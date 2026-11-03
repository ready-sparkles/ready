from __future__ import annotations

import asyncio
import logging
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Deque, Optional

from livekit.agents.types import (
    ATTRIBUTE_TRANSCRIPTION_FINAL,
    ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID,
    ATTRIBUTE_TRANSCRIPTION_TRACK_ID,
    TOPIC_TRANSCRIPTION,
)

from .task_cleanup import finish_on_cancel

# Marks captions from this durable scribe so clients can ignore the voice agent's
# forwarded user-input transcripts (fragmentary realtime-model text) for humans.
ATTRIBUTE_CAPTION_SOURCE = "readymeet.caption_source"
CAPTION_SOURCE_SCRIBE = "scribe"


LOGGER = logging.getLogger("readymeet.livekit_realtime.captions")

CAPTION_DRAIN_TIMEOUT_SECONDS = 3.0
CAPTION_PUBLISH_TIMEOUT_SECONDS = 2.0
CAPTION_WRITER_CLOSE_TIMEOUT_SECONDS = 0.5


@dataclass
class _PendingCaption:
    text: str
    is_final: bool
    track_sid: Optional[str]
    segment_id: str


class CaptionPublisher:
    """Ordered, bounded-latency publisher for LiveKit transcription streams.

    STT providers emit complete interim replacements rather than append-only
    deltas. Each update therefore uses its own LiveKit text stream, while all
    updates for one STT segment share a segment id. A single worker preserves
    open/close order, and coalescing prevents obsolete interims from building
    a queue behind a slow room connection.
    """

    def __init__(
        self,
        *,
        room_provider: Callable[[], Any],
        sender_identity: str,
        metrics: Any,
        log_context: Optional[dict[str, Any]] = None,
    ) -> None:
        self._room_provider = room_provider
        self._sender_identity = sender_identity
        self._metrics = metrics
        self._log_context = dict(log_context or {})
        self._segment_id: Optional[str] = None
        self._pending: Deque[_PendingCaption] = deque()
        self._wake = asyncio.Event()
        self._worker: Optional[asyncio.Task[None]] = None
        self._closing = False
        self._close_task: Optional[asyncio.Task[None]] = None
        self._inflight_final = False

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def worker_task(self) -> Optional[asyncio.Task[None]]:
        return self._worker

    def enqueue(
        self,
        text: str,
        *,
        is_final: bool,
        track_sid: Optional[str],
    ) -> None:
        if self._closing:
            return

        if self._segment_id is None:
            self._segment_id = f"SG_{uuid.uuid4().hex[:12]}"
        segment_id = self._segment_id
        if is_final:
            # Allocate identities in STT event order, not publish-completion
            # order. Otherwise the next interim can inherit a slow final's id.
            self._segment_id = None

        item = _PendingCaption(
            text=text,
            is_final=is_final,
            track_sid=track_sid,
            segment_id=segment_id,
        )

        if not is_final and self._pending and not self._pending[-1].is_final:
            self._pending[-1] = item
            self._metrics.record_caption_interim_coalesced()
        else:
            self._pending.append(item)

        if is_final:
            pending_finals = sum(
                1 for caption in self._pending if caption.is_final
            ) + int(self._inflight_final)
            self._metrics.record_caption_pending_finals(pending_finals)

        self._wake.set()
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            if self._pending:
                item = self._pending.popleft()
                self._inflight_final = item.is_final
                outcome = "error"
                try:
                    outcome = await asyncio.wait_for(
                        self._publish_caption(
                            item.text,
                            is_final=item.is_final,
                            track_sid=item.track_sid,
                            segment_id=item.segment_id,
                        ),
                        timeout=CAPTION_PUBLISH_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    outcome = "timeout"
                    LOGGER.warning(
                        "caption publish timed out",
                        extra=self._extra(
                            segmentId=item.segment_id,
                            isFinal=item.is_final,
                        ),
                    )
                except asyncio.CancelledError:
                    outcome = "cancelled"
                    self._metrics.record_caption_publish(outcome=outcome)
                    raise
                except Exception as error:  # pragma: no cover - defensive
                    LOGGER.warning(
                        "caption worker publish failed",
                        extra=self._extra(
                            segmentId=item.segment_id,
                            error=str(error),
                        ),
                    )
                finally:
                    self._inflight_final = False

                self._metrics.record_caption_publish(outcome=outcome)
                continue

            if self._closing:
                return

            self._wake.clear()
            if self._pending or self._closing:
                continue
            await self._wake.wait()

    async def aclose(self, *, drain: bool) -> None:
        """Stop the worker, optionally flushing captions already in its queue."""

        if self._close_task is None:
            self._closing = True
            self._wake.set()
            self._close_task = asyncio.create_task(self._close(drain=drain))
        await finish_on_cancel(self._close_task)

    async def _close(self, *, drain: bool) -> None:
        worker = self._worker
        try:
            if drain and worker is not None and not worker.done():
                try:
                    await asyncio.wait_for(
                        asyncio.shield(worker), timeout=CAPTION_DRAIN_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    LOGGER.warning(
                        "caption drain timed out",
                        extra=self._extra(pendingCaptions=len(self._pending)),
                    )
                except Exception:  # pragma: no cover - defensive teardown
                    pass
        finally:
            if worker is not None:
                if not worker.done():
                    worker.cancel()
                await asyncio.gather(worker, return_exceptions=True)
            self._worker = None
            self._pending.clear()

    async def _publish_caption(
        self,
        text: str,
        *,
        is_final: bool,
        track_sid: Optional[str],
        segment_id: str,
    ) -> str:
        writer: Optional[Any] = None
        wrote_text = False
        outcome = "error"
        try:
            room = self._room_provider()
            try:
                if not room.isconnected():
                    return "disconnected"
            except Exception:  # pragma: no cover - defensive
                return "disconnected"

            attributes = {
                ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID: segment_id,
                ATTRIBUTE_TRANSCRIPTION_FINAL: "true" if is_final else "false",
                ATTRIBUTE_CAPTION_SOURCE: CAPTION_SOURCE_SCRIBE,
            }
            if track_sid:
                attributes[ATTRIBUTE_TRANSCRIPTION_TRACK_ID] = track_sid

            writer = await room.local_participant.stream_text(
                topic=TOPIC_TRANSCRIPTION,
                sender_identity=self._sender_identity,
                attributes=attributes,
            )
            await writer.write(text)
            wrote_text = True
            outcome = "success"
        except asyncio.CancelledError:
            raise
        except Exception as error:
            LOGGER.warning(
                "failed to publish caption segment",
                extra=self._extra(
                    segmentId=segment_id,
                    error=str(error),
                ),
            )
        finally:
            if writer is not None:
                try:
                    await asyncio.wait_for(
                        writer.aclose(),
                        timeout=CAPTION_WRITER_CLOSE_TIMEOUT_SECONDS,
                    )
                except Exception:
                    # write() and aclose() are separate LiveKit operations.
                    # A successful write means the chunk was accepted, but a
                    # receiver using read_all() still needs this trailer to
                    # observe end-of-stream. Keep the distinct failure outcome.
                    LOGGER.debug(
                        "caption stream close failed",
                        extra=self._extra(segmentId=segment_id),
                    )
                    if wrote_text:
                        outcome = "close_failed"

        return outcome

    def _extra(self, **values: Any) -> dict[str, Any]:
        return {
            **self._log_context,
            "participantIdentity": self._sender_identity,
            **values,
        }
