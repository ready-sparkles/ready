"""Speech-gated STT streaming.

The transcriber opens one STT stream per human participant and, by default,
holds it open for the whole meeting. Every open stream is a session against
LiveKit Inference, so concurrency scales with *attendees* rather than with
*people currently talking* — a 6-person meeting pins 6 streams to serve the
one person who is speaking.

This module wraps an STT so the underlying stream is only open while the
participant is actually producing speech. The realtime service feeds it frames
from that participant's microphone track on the meeting's shared room
connection. Speaker attribution remains a property of the per-track binding,
not of the STT stream.

Three details make this safe:

- ``STT.stream()`` is synchronous and buffers pushed frames in its own input
  channel until the websocket finishes connecting, so re-opening never blocks
  on the network and never clips audio waiting for a connection.
- Closing goes through ``end_input()`` and drains the stream to completion
  before ``aclose()``, so the trailing ``final_transcript`` is always collected.
  ``aclose()`` alone cancels the run task and would truncate the last word.
  Shutdown drains *before* signalling end-of-output, so the last thing said in
  a meeting still reaches the transcript.
- The gate's *decision* state (``_gate_open``) is tracked separately from the
  *actual* stream, so shadow mode records exactly what enforcement would have
  done while the real stream stays open for the whole session. Observers get
  both: ``on_open``/``on_close`` for decisions, ``on_stream_opened``/
  ``on_stream_closed`` for real provider sessions.

Every open stream is represented by an ``_OpenStream`` record that owns its
forwarder task and its admission slot. All teardown paths funnel through
``_begin_teardown``, which is idempotent, so a stream is closed exactly once
and its slot released exactly once no matter how it died.

All timing is measured in *consumed audio seconds* rather than wall clock.
The track AudioStream delivers frames continuously whether or not anyone is
talking, so the audio clock advances at the same rate as real time while
remaining fully deterministic under test.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any, AsyncIterable, AsyncIterator, Deque, Optional, Set

from livekit.agents import stt as stt_api
from livekit.agents import vad as vad_api


LOGGER = logging.getLogger("readymeet.livekit_realtime.stt_gate")

GATE_MODE_OFF = "off"
GATE_MODE_SHADOW = "shadow"
GATE_MODE_ON = "on"
GATE_MODES = (GATE_MODE_OFF, GATE_MODE_SHADOW, GATE_MODE_ON)

CLOSE_DRAIN_TIMEOUT_SECONDS = 5.0
ADMISSION_RETRY_BACKOFF_SECONDS = 1.0
SETTLE_MAX_ROUNDS = 64
# End-of-audio bounds: how long to wait for the VAD consumer to process its
# final queued events, and how long a last-chance open for an utterance that
# began right at EOF may take. Both cap what shutdown adds to meeting end.
VAD_FLUSH_TIMEOUT_SECONDS = 2.0
EOF_FLUSH_OPEN_TIMEOUT_SECONDS = 2.0


def normalize_gate_mode(raw: str) -> str:
    normalized = (raw or "").strip().lower()
    if normalized in GATE_MODES:
        return normalized
    if normalized:
        LOGGER.warning(
            "unknown STT gate mode, falling back to off",
            extra={"requestedMode": normalized},
        )
    return GATE_MODE_OFF


@dataclass(frozen=True)
class SttGateSettings:
    """Tuning for the speech gate.

    ``hold_open_seconds`` is the knob that decides concurrency: it is how long
    a stream lingers after speech stops. Too short and a normal conversational
    pause churns the websocket; too long and every recent speaker stays open,
    which gives back the saving. It is deliberately generous by default and
    should be tuned from shadow-mode data rather than from first principles.
    """

    mode: str = GATE_MODE_OFF
    hold_open_seconds: float = 8.0
    min_open_seconds: float = 3.0
    prebuffer_seconds: float = 1.5
    admission_capacity: int = 0
    admission_wait_seconds: float = 5.0
    max_blocked_buffer_seconds: float = 30.0

    @property
    def enabled(self) -> bool:
        return self.mode in (GATE_MODE_SHADOW, GATE_MODE_ON)


class SttGateObserver:
    """No-op hook surface. The service passes a metrics-backed subclass.

    ``on_open``/``on_close`` report gate *decisions* and fire in shadow mode
    too, which is what makes shadow data a prediction of enforcement.
    ``on_stream_opened``/``on_stream_closed`` report *real* provider sessions
    and are the only signal that admission state actually changed. Anything
    that must reflect reality — capacity gauges, failure recovery — belongs on
    the stream hooks, not the decision hooks.
    """

    def on_open(self, *, shadow: bool) -> None:
        return None

    def on_close(self, *, shadow: bool, open_seconds: float, reason: str) -> None:
        return None

    def on_stream_opened(self) -> None:
        return None

    def on_stream_closed(self, *, reason: str) -> None:
        return None

    def on_stream_healthy(self) -> None:
        """First event received from a stream: the provider session works.

        This — not ``on_stream_opened`` — is the hook for anything that means
        "recovered". A stream object is created before the websocket ever
        connects, so opening proves nothing about provider health.
        """

        return None

    def on_admission_denied(self, *, waited_seconds: float) -> None:
        return None

    def on_prebuffer_flush(self, *, frames: int, seconds: float) -> None:
        return None

    def on_stream_error(self, *, reason: str) -> None:
        return None

    def on_frames_dropped(self, *, frames: int, seconds: float) -> None:
        return None


class SttAdmissionController:
    """Bounds concurrently open STT streams inside this process.

    Gating moves failure from meeting-join time (loud, predictable) to
    mid-sentence (silent, lossy), so opens are admission-controlled against a
    budget set below the provider cap. A denied open does not drop audio: the
    caller keeps buffering into a large window and retries.

    This is per-process, and there are two processes: the meeting agent draws
    on the same provider cap with no budget of its own, so the configured
    capacity must leave room for it.
    """

    def __init__(self, capacity: Optional[int]) -> None:
        self._capacity = capacity if capacity and capacity > 0 else None
        self._semaphore: Optional[asyncio.Semaphore] = None
        self._in_use = 0
        self._peak_in_use = 0
        self._denied = 0

    @property
    def capacity(self) -> Optional[int]:
        return self._capacity

    @property
    def in_use(self) -> int:
        return self._in_use

    @property
    def peak_in_use(self) -> int:
        return self._peak_in_use

    @property
    def denied(self) -> int:
        return self._denied

    def _ensure_semaphore(self) -> Optional[asyncio.Semaphore]:
        if self._capacity is None:
            return None
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(self._capacity)
        return self._semaphore

    async def acquire(self, *, timeout: float) -> bool:
        semaphore = self._ensure_semaphore()
        if semaphore is not None:
            if timeout <= 0:
                # wait_for() with a non-positive timeout cancels the acquire
                # before the semaphore's fast path can run, so it would deny
                # even a completely free budget. Zero means "do not wait",
                # not "always fail".
                if semaphore.locked():
                    self._denied += 1
                    return False
                await semaphore.acquire()
            else:
                try:
                    await asyncio.wait_for(semaphore.acquire(), timeout=timeout)
                except asyncio.TimeoutError:
                    self._denied += 1
                    return False

        self._in_use += 1
        self._peak_in_use = max(self._peak_in_use, self._in_use)
        return True

    def release(self) -> None:
        if self._in_use <= 0:
            return

        self._in_use -= 1
        if self._semaphore is not None:
            self._semaphore.release()

    def snapshot(self) -> dict[str, Any]:
        return {
            "capacity": self._capacity,
            "inUse": self._in_use,
            "peakInUse": self._peak_in_use,
            "denied": self._denied,
        }


@dataclass
class _OpenStream:
    """One provider session, plus everything that must be released with it."""

    stream: Any
    forwarder: Optional[asyncio.Task[None]] = None
    admission_held: bool = False
    teardown_started: bool = False
    # Forwarder of the stream this one replaced, if it was still draining.
    # Emitting before it finishes would reorder the previous utterance's
    # trailing final after this stream's events.
    predecessor: Optional[asyncio.Task[None]] = None
    # Set on the first event received from the provider. Creating the local
    # stream object proves nothing — the websocket connects lazily — so this
    # is the earliest moment the session is known to actually work.
    healthy: bool = False


class SttGateRunner:
    """Owns one participant's gated STT stream."""

    def __init__(
        self,
        *,
        audio: AsyncIterable[Any],
        stt: Any,
        vad: Any,
        settings: SttGateSettings,
        admission: SttAdmissionController,
        observer: SttGateObserver,
        label: str,
    ) -> None:
        self._audio = audio
        self._stt = stt
        self._vad = vad
        self._settings = settings
        self._admission = admission
        self._observer = observer
        self._label = label

        self._shadow = settings.mode == GATE_MODE_SHADOW
        self._out: asyncio.Queue[Any] = asyncio.Queue()
        self._sentinel = object()

        self._open: Optional[_OpenStream] = None
        self._draining_forwarder: Optional[asyncio.Task[None]] = None
        self._open_task: Optional[asyncio.Task[Any]] = None
        self._closing = False
        self._transition_lock = asyncio.Lock()
        self._transitions: Set[asyncio.Task[Any]] = set()

        self._buffer: Deque[Any] = deque()
        self._buffered_seconds = 0.0

        self._clock = 0.0
        self._speaking = False
        self._last_speech_clock = 0.0
        self._open_pending = False
        self._retry_open_clock = 0.0

        self._gate_open = False
        self._gate_opened_clock = 0.0

        self.opens = 0
        self.closes = 0
        self.dropped_frames = 0
        self.dropped_seconds = 0.0

    @property
    def gate_open(self) -> bool:
        return self._gate_open

    async def settle(self) -> None:
        """Wait for in-flight open/close transitions to finish.

        Only genuinely pending tasks are awaited. Awaiting an already-completed
        task does not yield to the event loop, so looping on the task *set*
        (which is drained by a done-callback) can spin without ever letting
        that callback run.
        """

        for _ in range(SETTLE_MAX_ROUNDS):
            pending = [task for task in self._transitions if not task.done()]
            if not pending:
                return
            await asyncio.gather(*pending, return_exceptions=True)

        raise RuntimeError(
            f"stt gate transitions did not settle after {SETTLE_MAX_ROUNDS} rounds"
        )

    async def run(self) -> AsyncIterator[Any]:
        vad_stream = self._vad.stream()
        vad_task = asyncio.create_task(self._consume_vad(vad_stream))
        pump_task = asyncio.create_task(self._pump_audio(vad_stream, vad_task))

        try:
            if self._shadow:
                # Shadow keeps the real stream open for the whole session, so
                # transcript behaviour is exactly today's behaviour while the
                # decision log tells us what enforcement would have cost.
                await self._open_real_stream()

            while True:
                item = await self._out.get()
                if item is self._sentinel:
                    break
                yield item
        finally:
            for task in (pump_task, vad_task):
                task.cancel()
            await asyncio.gather(pump_task, vad_task, return_exceptions=True)
            try:
                await vad_stream.aclose()
            except Exception:  # pragma: no cover - defensive teardown
                LOGGER.debug("vad stream close failed", extra={"gateLabel": self._label})

            # Backstop for the cancellation path, where the pump never reached
            # its own shutdown. Events drained here cannot be yielded — the
            # consumer is already gone — but the provider session and its
            # admission slot must still be released.
            await self._abort_pending_open()
            await self._shutdown_stream(reason="shutdown")
            await self._drain_transitions()

            if self._gate_open:
                # Otherwise a gate that ends mid-utterance leaks upward in the
                # open-gauge forever, and the peak we tune from drifts.
                self._close_gate(reason="shutdown")

    def _spawn_transition(self, coro: Any) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro)
        self._transitions.add(task)
        task.add_done_callback(self._transitions.discard)
        return task

    async def _drain_transitions(self) -> None:
        pending = [task for task in self._transitions if not task.done()]
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _pump_audio(
        self, vad_stream: Any, vad_task: Optional[asyncio.Task[Any]] = None
    ) -> None:
        try:
            async for frame in self._audio:
                self._clock += frame.duration
                vad_stream.push_frame(frame)
                self._accept_frame(frame)
                self._maybe_open_stream()
                self._maybe_close_gate()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # pragma: no cover - upstream audio failure
            LOGGER.exception(
                "gated stt audio pump failed",
                extra={"gateLabel": self._label, "error": str(error)},
            )
        finally:
            try:
                vad_stream.end_input()
            except Exception:
                pass

            # Let the last VAD decision land before tearing anything down. A
            # START_OF_SPEECH can still be queued when the audio iterator
            # finishes — someone talking right as the meeting closes — and
            # shutting down first would silently drop that final utterance.
            # The VAD stream ends iteration after end_input, so its consumer
            # finishes promptly; the timeout only guards a wedged VAD, and
            # the shield keeps it from cancelling a task run() still owns.
            if vad_task is not None:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(vad_task), timeout=VAD_FLUSH_TIMEOUT_SECONDS
                    )
                except (asyncio.TimeoutError, Exception):
                    pass

            # If that decision opened the gate and the utterance is sitting in
            # the buffer with no stream, make one bounded attempt to flush it
            # through a real stream before closing. A pending open (parked on
            # admission) keeps its round-4 semantics: cancelled, not honoured.
            if (
                self._wants_stream()
                and self._open is None
                and not self._open_pending
                and self._buffer
            ):
                self._open_pending = True
                try:
                    await asyncio.wait_for(
                        self._run_open(), timeout=EOF_FLUSH_OPEN_TIMEOUT_SECONDS
                    )
                except asyncio.TimeoutError:
                    LOGGER.warning(
                        "gated stt eof flush open timed out",
                        extra={"gateLabel": self._label},
                    )
                except Exception:  # pragma: no cover - open path logs itself
                    pass

            # Drain the stream *before* signalling end-of-output. The trailing
            # final_transcript is emitted during end_input(), and anything
            # queued after the sentinel is never yielded — that is the last
            # thing said in the meeting. Idle teardowns run detached, so wait
            # for those too: an earlier utterance may still be draining.
            await self._abort_pending_open()
            await self._shutdown_stream(reason="audio-ended")
            await self._drain_transitions()
            await self._out.put(self._sentinel)

    async def _abort_pending_open(self) -> None:
        """Cancel an open still parked on admission; never wait it out.

        Draining a blocked open would stall shutdown for up to the full
        admission wait, and honouring a late grant would publish an ownerless
        post-shutdown stream whose events sit behind the sentinel. The acquire
        path releases its slot on cancellation, so cancel is safe.
        """

        self._closing = True
        task = self._open_task
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _shutdown_stream(self, *, reason: str) -> None:
        record = self._open
        if record is None:
            return

        task = self._begin_teardown(record, graceful=True, reason=reason)
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)

    def _accept_frame(self, frame: Any) -> None:
        record = self._open
        if record is not None:
            try:
                record.stream.push_frame(frame)
                return
            except Exception as error:
                # The stream died underneath us; tear it down properly and let
                # the gate reopen instead of losing the rest of the meeting for
                # this participant.
                LOGGER.warning(
                    "gated stt push failed, dropping stream",
                    extra={"gateLabel": self._label, "error": str(error)},
                )
                self._observer.on_stream_error(reason="push_failed")
                self._discard_failed_stream(record, reason="push_failed")

        self._buffer.append(frame)
        self._buffered_seconds += frame.duration
        self._trim_buffer()

    def _wants_stream(self) -> bool:
        # Shadow wants its stream for the whole session: it is the live
        # transcript path while the mode is on, so after a failure it must
        # reopen without waiting for a gate decision that never comes
        # (shadow gates only record, they never enforce).
        if self._closing:
            return False
        if self._shadow:
            return True
        return self._gate_open

    def _trim_buffer(self) -> None:
        # While we want a stream but do not have one (waiting on admission, or
        # backing off after a denial) we keep a much larger window, so a slot
        # that frees up late still yields a complete utterance.
        blocked = self._open_pending or (self._wants_stream() and self._open is None)
        limit = (
            self._settings.max_blocked_buffer_seconds
            if blocked
            else self._settings.prebuffer_seconds
        )
        dropped_frames = 0
        dropped_seconds = 0.0
        while self._buffer and self._buffered_seconds > limit:
            dropped = self._buffer.popleft()
            self._buffered_seconds -= dropped.duration
            dropped_frames += 1
            dropped_seconds += dropped.duration

        if dropped_frames and blocked:
            # Dropping while blocked means audio was genuinely lost rather
            # than aged out of the idle pre-roll window.
            self.dropped_frames += dropped_frames
            self.dropped_seconds += dropped_seconds
            self._observer.on_frames_dropped(
                frames=dropped_frames,
                seconds=dropped_seconds,
            )

    async def _consume_vad(self, vad_stream: Any) -> None:
        try:
            async for event in vad_stream:
                if event.type == vad_api.VADEventType.START_OF_SPEECH:
                    self._speaking = True
                    self._last_speech_clock = self._clock
                    self._open_gate()
                elif event.type == vad_api.VADEventType.END_OF_SPEECH:
                    self._speaking = False
                    self._last_speech_clock = self._clock
        except asyncio.CancelledError:
            raise
        except Exception as error:
            LOGGER.exception(
                "gated stt vad consumer failed",
                extra={"gateLabel": self._label, "error": str(error)},
            )
            self._observer.on_stream_error(reason="vad_failed")
            # Fail open. The pump is still running, but without VAD there are
            # no further open/close decisions: if the gate is not already open
            # the participant's words silently stop appearing for the rest of
            # the session. Pinning speaking=True holds the gate open
            # permanently — pre-gate behaviour, trading cost for transcript.
            self._speaking = True
            self._open_gate()

    def _open_gate(self) -> None:
        if self._gate_open:
            return

        self._gate_open = True
        self._gate_opened_clock = self._clock
        self._retry_open_clock = 0.0
        self.opens += 1
        self._observer.on_open(shadow=self._shadow)

    def _close_gate(self, *, reason: str) -> float:
        open_seconds = self._clock - self._gate_opened_clock
        self._gate_open = False
        self.closes += 1
        self._observer.on_close(
            shadow=self._shadow,
            open_seconds=open_seconds,
            reason=reason,
        )
        return open_seconds

    def _maybe_open_stream(self) -> None:
        if not self._wants_stream():
            return
        if self._open is not None or self._open_pending:
            return
        if self._clock < self._retry_open_clock:
            return

        # Single-flight: the flag must flip synchronously, before the task
        # gets its first turn. Frames can be processed back-to-back without a
        # loop yield, and setting the flag inside the task let every such
        # frame spawn its own open — with only the last one tracked for
        # shutdown cancellation.
        self._open_pending = True
        self._open_task = self._spawn_transition(self._run_open())

    async def _run_open(self) -> None:
        try:
            await self._open_real_stream()
        finally:
            self._open_pending = False
            self._trim_buffer()

    def _maybe_close_gate(self) -> None:
        if not self._gate_open or self._speaking:
            return
        if self._clock - self._last_speech_clock < self._settings.hold_open_seconds:
            return
        if self._clock - self._gate_opened_clock < self._settings.min_open_seconds:
            return

        self._close_gate(reason="idle")

        if self._shadow:
            return

        record = self._open
        if record is not None:
            self._begin_teardown(record, graceful=True, reason="idle")

    async def _open_real_stream(self) -> None:
        # Callers own the `_open_pending` single-flight flag (see
        # _maybe_open_stream / the shadow bootstrap); this method only checks
        # whether the open is still valid.
        if self._closing or self._open is not None:
            return

        async with self._transition_lock:
            if self._closing or self._open is not None:
                return

            # Shadow must be behaviour-identical to today, and today has no
            # admission control. Letting the budget deny the shadow stream
            # would silently cost transcript rather than just prediction.
            admitted = False
            loop = asyncio.get_running_loop()
            started_at = loop.time()
            try:
                if self._shadow:
                    admitted = True
                else:
                    admitted = await self._admission.acquire(
                        timeout=self._settings.admission_wait_seconds
                    )
            except asyncio.CancelledError:
                # Shutdown cancelled us mid-acquire. `admitted` can only be
                # True here if the grant landed before the cancel was
                # delivered — give the slot back either way.
                if admitted and not self._shadow:
                    self._admission.release()
                raise
            if not admitted:
                waited = loop.time() - started_at
                self._retry_open_clock = self._clock + ADMISSION_RETRY_BACKOFF_SECONDS
                LOGGER.warning(
                    "gated stt admission denied",
                    extra={
                        "gateLabel": self._label,
                        "waitedSeconds": round(waited, 3),
                        **self._admission.snapshot(),
                    },
                )
                self._observer.on_admission_denied(waited_seconds=waited)
                return

            if not self._wants_stream():
                # The gate closed on idle — or shutdown began — while we
                # were parked on admission. A stream opened now would have
                # no owner: no close decision ever fires for it, so the
                # provider session and the slot would leak until shutdown.
                # Everything from here to publishing is await-free, so
                # this single re-check is sufficient.
                if not self._shadow:
                    self._admission.release()
                LOGGER.info(
                    "gated stt open abandoned, no longer wanted",
                    extra={"gateLabel": self._label, **self._admission.snapshot()},
                )
                return

            record = _OpenStream(stream=None, admission_held=not self._shadow)
            try:
                record.stream = self._stt.stream()
                buffered_frames = len(self._buffer)
                buffered_seconds = self._buffered_seconds

                # Synchronous drain: no awaits between flushing the backlog
                # and publishing the stream, so ordering cannot invert
                # against the pump.
                #
                # Each frame is dropped from the buffer only *after* its push
                # succeeds, so a mid-flush failure leaves exactly the
                # unflushed remainder behind. Neither half of that is
                # optional: clearing up front loses the pre-roll the retry
                # needs, and clearing only at the end replays audio the dying
                # stream already accepted — transcribing and billing it twice.
                while self._buffer:
                    frame = self._buffer[0]
                    record.stream.push_frame(frame)
                    self._buffer.popleft()
                    self._buffered_seconds = max(
                        0.0, self._buffered_seconds - frame.duration
                    )
                self._buffered_seconds = 0.0
                # Chain output ordering to any stream still draining, so its
                # trailing final cannot land behind our events. This delays
                # only the first emitted event, never the open or the audio
                # push, so turn latency is untouched.
                predecessor = self._draining_forwarder
                if predecessor is not None and not predecessor.done():
                    record.predecessor = predecessor
                record.forwarder = asyncio.create_task(self._forward_stream(record))
                self._open = record
            except Exception as error:
                # Anything that throws between acquiring the slot and
                # publishing the stream would otherwise leak the slot (and
                # possibly a live provider session) forever.
                LOGGER.exception(
                    "gated stt stream open failed",
                    extra={"gateLabel": self._label, "error": str(error)},
                )
                self._observer.on_stream_error(reason="open_failed")
                self._retry_open_clock = (
                    self._clock + ADMISSION_RETRY_BACKOFF_SECONDS
                )
                await self._abandon_partial_open(record)
                return

            self._observer.on_stream_opened()
            if buffered_frames:
                self._observer.on_prebuffer_flush(
                    frames=buffered_frames,
                    seconds=buffered_seconds,
                )
            LOGGER.info(
                "gated stt stream opened",
                extra={
                    "gateLabel": self._label,
                    "prebufferedFrames": buffered_frames,
                    "prebufferedSeconds": round(buffered_seconds, 3),
                    **self._admission.snapshot(),
                },
            )

    async def _abandon_partial_open(self, record: _OpenStream) -> None:
        record.teardown_started = True
        try:
            if record.stream is not None:
                try:
                    await record.stream.aclose()
                except Exception:  # pragma: no cover - defensive teardown
                    LOGGER.debug(
                        "gated stt partial stream close failed",
                        extra={"gateLabel": self._label},
                    )
        finally:
            # Must run even if aclose() is interrupted by cancellation —
            # shutdown's abort-pending-open cancels exactly this window, and
            # a skipped release strands the slot forever.
            self._release_admission(record)

    def _release_admission(self, record: _OpenStream) -> None:
        if not record.admission_held:
            return
        record.admission_held = False
        self._admission.release()

    async def _forward_stream(self, record: _OpenStream) -> None:
        try:
            async for event in record.stream:
                if record.predecessor is not None:
                    # Bounded by the predecessor's own drain timeout.
                    await asyncio.gather(record.predecessor, return_exceptions=True)
                    record.predecessor = None
                if not record.healthy:
                    record.healthy = True
                    self._observer.on_stream_healthy()
                await self._out.put(event)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Do not propagate: a failed stream should cost us one utterance,
            # not the rest of the meeting. The gate reopens on the next frame.
            LOGGER.warning(
                "gated stt stream failed",
                extra={"gateLabel": self._label, "error": str(error)},
            )
            self._observer.on_stream_error(reason="stream_failed")
            self._discard_failed_stream(record, reason="stream_failed")
        else:
            # Clean EOF without a teardown in progress: the provider closed
            # the stream on its own. Leaving the record published would wedge
            # this participant permanently — the slot held, no reopen ever
            # scheduled. Treat it like a failure so the backoff/reopen path
            # applies. (During a graceful close teardown_started is already
            # set, so the expected end-of-drain EOF is a no-op here.)
            if not record.teardown_started:
                LOGGER.warning(
                    "gated stt stream ended unexpectedly",
                    extra={"gateLabel": self._label},
                )
                self._observer.on_stream_error(reason="stream_ended")
                self._discard_failed_stream(record, reason="stream_ended")

    def _discard_failed_stream(self, record: _OpenStream, *, reason: str) -> None:
        self._retry_open_clock = self._clock + ADMISSION_RETRY_BACKOFF_SECONDS
        self._begin_teardown(record, graceful=False, reason=reason)

    def _begin_teardown(
        self, record: _OpenStream, *, graceful: bool, reason: str
    ) -> Optional[asyncio.Task[Any]]:
        """Detach a stream synchronously and tear it down exactly once."""

        if record.teardown_started:
            return None

        record.teardown_started = True
        if self._open is record:
            self._open = None
        if record.forwarder is not None and not record.forwarder.done():
            self._draining_forwarder = record.forwarder

        return self._spawn_transition(
            self._teardown_stream(record, graceful=graceful, reason=reason)
        )

    async def _teardown_stream(
        self, record: _OpenStream, *, graceful: bool, reason: str
    ) -> None:
        stream = record.stream
        forwarder = record.forwarder
        try:
            if graceful and stream is not None:
                try:
                    # end_input() flushes and lets the stream finish naturally
                    # so the trailing final_transcript is delivered. aclose()
                    # alone cancels the run task and truncates the last word.
                    stream.end_input()
                    if forwarder is not None:
                        await asyncio.wait_for(
                            forwarder, timeout=CLOSE_DRAIN_TIMEOUT_SECONDS
                        )
                except asyncio.TimeoutError:
                    LOGGER.warning(
                        "gated stt stream drain timed out",
                        extra={"gateLabel": self._label, "reason": reason},
                    )
                except Exception as error:
                    LOGGER.warning(
                        "gated stt stream drain failed",
                        extra={
                            "gateLabel": self._label,
                            "reason": reason,
                            "error": str(error),
                        },
                    )
        finally:
            try:
                # Teardown always runs on its own task (see _begin_teardown),
                # so a forwarder that asked for teardown has already returned
                # by the time we get here. Guard anyway: if this ever ran
                # inline on the forwarder, cancelling and awaiting self would
                # abort cleanup before aclose() and strand the admission slot.
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
                            "gated stt stream close failed",
                            extra={"gateLabel": self._label},
                        )
            finally:
                # Same cancellation-safety as the partial-open path: the slot
                # release must survive a cancel landing in the awaits above.
                self._release_admission(record)
                self._observer.on_stream_closed(reason=reason)


async def gated_stt_stream(
    *,
    audio: AsyncIterable[Any],
    stt: Any,
    vad: Any,
    settings: SttGateSettings,
    admission: SttAdmissionController,
    observer: Optional[SttGateObserver] = None,
    label: str = "stt-gate",
) -> AsyncIterator[stt_api.SpeechEvent]:
    """Yield the wrapped STT's speech events, opening it only around speech."""

    runner = SttGateRunner(
        audio=audio,
        stt=stt,
        vad=vad,
        settings=settings,
        admission=admission,
        observer=observer or SttGateObserver(),
        label=label,
    )
    async for event in runner.run():
        yield event
