"""Audio-activity gating for the push-to-talk assistant's STT.

In group mode the assistant session is built with an STT but its audio input is
disabled until a push-to-talk turn starts. The STT stream is created eagerly at
session start regardless, so the websocket to the inference service stays open
for the entire meeting to serve turns that may never happen.

Frames are the push-to-talk signal. RoomIO drops audio while the input is
detached (``set_audio_enabled(False)``), so "frames are arriving" is exactly
"a turn is in progress" — no VAD, and no coupling to the RPC handlers that
could drift out of sync with the real audio state.

Turn latency is the constraint that matters here. ``STT.stream()`` is
synchronous and buffers into its own input channel until the websocket
finishes connecting, so opening on the first frame of a turn costs no
round-trip: the frame is queued immediately and sent as soon as the socket is
up, exactly as it would have been on an already-open stream.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, AsyncIterable, AsyncIterator, Callable, Optional, Set


LOGGER = logging.getLogger("readymeet.meeting_agent.stt_gate")

CLOSE_DRAIN_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True)
class SttActivityGateSettings:
    enabled: bool = False
    # How long after the last audio frame the stream is held open. This only
    # needs to outlast the gap between frames within a turn, not the gap
    # between turns.
    idle_close_seconds: float = 5.0
    poll_interval_seconds: float = 1.0


@dataclass
class _OpenStream:
    """One provider session, plus the forwarder that must die with it."""

    stream: Any
    forwarder: Optional[asyncio.Task[None]] = None
    teardown_started: bool = False
    # Forwarder of the stream this one replaced, if it was still draining.
    # Emitting first would reorder the previous turn's trailing final after
    # this turn's events.
    predecessor: Optional[asyncio.Task[None]] = None


class SttActivityGateRunner:
    def __init__(
        self,
        *,
        audio: AsyncIterable[Any],
        stt: Any,
        settings: SttActivityGateSettings,
        label: str,
        monotonic: Optional[Callable[[], float]] = None,
    ) -> None:
        self._audio = audio
        self._stt = stt
        self._settings = settings
        self._label = label
        self._monotonic = monotonic or time.monotonic

        self._out: asyncio.Queue[Any] = asyncio.Queue()
        self._sentinel = object()
        self._open: Optional[_OpenStream] = None
        self._draining_forwarder: Optional[asyncio.Task[None]] = None
        self._last_frame_at: Optional[float] = None
        self._open_lock = asyncio.Lock()
        self._teardowns: Set[asyncio.Task[None]] = set()

        self.opens = 0
        self.closes = 0

    @property
    def stream_open(self) -> bool:
        return self._open is not None

    async def run(self) -> AsyncIterator[Any]:
        pump_task = asyncio.create_task(self._pump_audio())
        watchdog_task = asyncio.create_task(self._watchdog())

        try:
            while True:
                item = await self._out.get()
                if item is self._sentinel:
                    break
                yield item
        finally:
            for task in (pump_task, watchdog_task):
                task.cancel()
            await asyncio.gather(pump_task, watchdog_task, return_exceptions=True)
            # Backstop for the cancellation path: events drained here cannot be
            # yielded, but the provider session must still be released.
            await self._shutdown_stream(reason="shutdown")
            await self._drain_teardowns()

    async def _pump_audio(self) -> None:
        try:
            async for frame in self._audio:
                self._last_frame_at = self._monotonic()
                await self._ensure_stream_open()
                record = self._open
                if record is None:
                    continue
                if record.teardown_started:
                    # Lost the race to an idle teardown: reopen rather than
                    # push the first frame of a new turn into a closing stream.
                    #
                    # Unreachable as written — teardown detaches synchronously
                    # and there is no await between the read above and the push
                    # below — but that safety is incidental, not designed. It
                    # rests on _ensure_stream_open() returning without
                    # suspending when a stream is already open. Add any await
                    # to the open path (admission control, an async stream
                    # factory) and this becomes a silently dropped first frame.
                    await self._ensure_stream_open()
                    record = self._open
                    if record is None or record.teardown_started:
                        continue
                try:
                    record.stream.push_frame(frame)
                except Exception as error:
                    LOGGER.warning(
                        "assistant stt push failed, dropping stream",
                        extra={"gateLabel": self._label, "error": str(error)},
                    )
                    self._begin_teardown(record, graceful=False, reason="push_failed")
        except asyncio.CancelledError:
            raise
        except Exception as error:  # pragma: no cover - upstream audio failure
            LOGGER.exception(
                "assistant stt audio pump failed",
                extra={"gateLabel": self._label, "error": str(error)},
            )
        finally:
            # Drain before signalling end-of-output: the turn's final
            # transcript is emitted during end_input(), and anything queued
            # after the sentinel is never yielded. Idle teardowns run detached
            # (so they never sit on the turn-latency path), so wait for those
            # too — an earlier turn's last words may still be in flight.
            await self._shutdown_stream(reason="audio-ended")
            await self._drain_teardowns()
            await self._out.put(self._sentinel)

    async def _shutdown_stream(self, *, reason: str) -> None:
        record = self._open
        if record is None:
            return

        task = self._begin_teardown(record, graceful=True, reason=reason)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    async def drain_teardowns(self) -> None:
        """Wait for detached stream teardowns to finish."""

        pending = [task for task in self._teardowns if not task.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _drain_teardowns(self) -> None:
        await self.drain_teardowns()

    async def _watchdog(self) -> None:
        while True:
            await asyncio.sleep(self._settings.poll_interval_seconds)
            await self.close_if_idle()

    async def close_if_idle(self, *, now: Optional[float] = None) -> bool:
        record = self._open
        if record is None or self._last_frame_at is None:
            return False

        elapsed = (now if now is not None else self._monotonic()) - self._last_frame_at
        if elapsed < self._settings.idle_close_seconds:
            return False

        self._begin_teardown(record, graceful=True, reason="idle")
        return True

    async def _ensure_stream_open(self) -> None:
        if self._open is not None:
            return

        # This lock is only ever held across the synchronous stt.stream() call.
        # Teardown deliberately does not hold it: draining can take seconds,
        # and a new turn starting during a drain must not wait on it — that
        # would put the whole close path on the push-to-talk latency budget.
        async with self._open_lock:
            if self._open is not None:
                return

            record = _OpenStream(stream=None)
            try:
                record.stream = self._stt.stream()
                # Chain output ordering to a stream still draining, so its
                # trailing final cannot land behind this turn's events. Only
                # the first emitted event waits — never the open or the audio
                # push — so push-to-talk latency is untouched.
                predecessor = self._draining_forwarder
                if predecessor is not None and not predecessor.done():
                    record.predecessor = predecessor
                record.forwarder = asyncio.create_task(self._forward_stream(record))
                self._open = record
            except Exception as error:
                LOGGER.exception(
                    "assistant stt stream open failed",
                    extra={"gateLabel": self._label, "error": str(error)},
                )
                if record.stream is not None:
                    record.teardown_started = True
                    try:
                        await record.stream.aclose()
                    except Exception:  # pragma: no cover - defensive teardown
                        LOGGER.debug(
                            "assistant stt partial stream close failed",
                            extra={"gateLabel": self._label},
                        )
                return

            self.opens += 1
            LOGGER.info(
                "assistant stt stream opened",
                extra={"gateLabel": self._label},
            )

    async def _forward_stream(self, record: "_OpenStream") -> None:
        try:
            async for event in record.stream:
                if record.predecessor is not None:
                    # Bounded by the predecessor's own drain timeout.
                    await asyncio.gather(record.predecessor, return_exceptions=True)
                    record.predecessor = None
                await self._out.put(event)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # One failed turn, not a permanently deaf assistant.
            LOGGER.warning(
                "assistant stt stream failed",
                extra={"gateLabel": self._label, "error": str(error)},
            )
            self._begin_teardown(record, graceful=False, reason="stream_failed")
        else:
            # Clean EOF with no teardown in progress: the provider closed the
            # stream itself. Leaving the record published would make
            # _ensure_stream_open() refuse to reopen, so the next turn would
            # push into a dead stream. Tear it down so the turn after can open
            # a fresh one. (During a graceful close teardown_started is
            # already set, so the expected end-of-drain EOF is a no-op.)
            if not record.teardown_started:
                LOGGER.warning(
                    "assistant stt stream ended unexpectedly",
                    extra={"gateLabel": self._label},
                )
                self._begin_teardown(record, graceful=False, reason="stream_ended")

    def _begin_teardown(
        self, record: "_OpenStream", *, graceful: bool, reason: str
    ) -> Optional[asyncio.Task[None]]:
        """Detach synchronously; close and cancel exactly once."""

        if record.teardown_started:
            return None

        record.teardown_started = True
        if self._open is record:
            self._open = None
        if record.forwarder is not None and not record.forwarder.done():
            self._draining_forwarder = record.forwarder
        self.closes += 1

        task = asyncio.create_task(
            self._teardown_stream(record, graceful=graceful, reason=reason)
        )
        self._teardowns.add(task)
        task.add_done_callback(self._teardowns.discard)
        return task

    async def _teardown_stream(
        self, record: "_OpenStream", *, graceful: bool, reason: str
    ) -> None:
        stream = record.stream
        forwarder = record.forwarder
        try:
            if graceful and stream is not None:
                # Drain before closing so the turn's final transcript is not
                # truncated; aclose() alone cancels the run task.
                stream.end_input()
                if forwarder is not None:
                    await asyncio.wait_for(forwarder, timeout=CLOSE_DRAIN_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            LOGGER.warning(
                "assistant stt stream drain timed out",
                extra={"gateLabel": self._label, "reason": reason},
            )
        except Exception as error:
            LOGGER.warning(
                "assistant stt stream drain failed",
                extra={"gateLabel": self._label, "reason": reason, "error": str(error)},
            )
        finally:
            # Teardown always runs on its own task (see _begin_teardown), so a
            # forwarder that asked for teardown has already returned by the
            # time we get here. Guard anyway: if this ever ran inline on the
            # forwarder, cancelling and awaiting self would abort cleanup
            # before aclose().
            if (
                forwarder is not None
                and not forwarder.done()
                and forwarder is not asyncio.current_task()
            ):
                forwarder.cancel()
                await asyncio.gather(forwarder, return_exceptions=True)
            if stream is not None:
                try:
                    await stream.aclose()
                except Exception:  # pragma: no cover - defensive teardown
                    LOGGER.debug(
                        "assistant stt stream close failed",
                        extra={"gateLabel": self._label},
                    )


async def activity_gated_stt_stream(
    *,
    audio: AsyncIterable[Any],
    stt: Any,
    settings: SttActivityGateSettings,
    label: str = "assistant-stt-gate",
) -> AsyncIterator[Any]:
    """Yield the STT's speech events, opening it only while audio is flowing."""

    runner = SttActivityGateRunner(
        audio=audio,
        stt=stt,
        settings=settings,
        label=label,
    )
    async for event in runner.run():
        yield event
