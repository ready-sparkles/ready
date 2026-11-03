from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, AsyncIterator, Dict, List, Optional


SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from livekit.agents import stt as stt_api
from livekit.agents import vad as vad_api

from app.stt_gate import (
    GATE_MODE_ON,
    GATE_MODE_SHADOW,
    SttAdmissionController,
    SttGateObserver,
    SttGateRunner,
    SttGateSettings,
)


FRAME_SECONDS = 0.05
WAIT_MAX_TURNS = 1000


class FakeFrame:
    """Minimal stand-in for rtc.AudioFrame: the gate only reads `duration`."""

    def __init__(self, index: int) -> None:
        self.index = index
        self.duration = FRAME_SECONDS

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"FakeFrame({self.index})"


class FakeSpeechStream:
    """Models the parts of RecognizeStream the gate depends on.

    Most importantly: `end_input()` produces a trailing final transcript and
    *then* ends iteration, which is the behaviour that makes a graceful close
    safe. A stream that is `aclose()`d without draining loses that transcript.
    """

    def __init__(
        self,
        *,
        fail_on_iter: bool = False,
        fail_on_push: bool = False,
        block_aclose: bool = False,
        block_drain: bool = False,
        fail_push_after: Optional[int] = None,
    ) -> None:
        self.frames: List[FakeFrame] = []
        self.input_ended = False
        self.closed = False
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._fail_on_iter = fail_on_iter
        self._fail_on_push = fail_on_push
        self._block_aclose = block_aclose
        self._block_drain = block_drain
        self._fail_push_after = fail_push_after

    def release_drain(self) -> None:
        self._queue.put_nowait(
            stt_api.SpeechEvent(
                type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                alternatives=[stt_api.SpeechData(language="en", text="trailing")],
            )
        )
        self._queue.put_nowait(None)

    def end_cleanly(self) -> None:
        """Provider closes the stream normally: iteration just stops."""
        self._queue.put_nowait(None)

    def push_frame(self, frame: FakeFrame) -> None:
        if self._fail_on_push:
            raise RuntimeError("stream rejected the frame")
        if (
            self._fail_push_after is not None
            and len(self.frames) >= self._fail_push_after
        ):
            # Accepts a prefix, then dies partway through the flush.
            raise RuntimeError("stream died mid-flush")
        if self.input_ended:
            raise RuntimeError("stream input already ended")
        self.frames.append(frame)

    def emit(self, event: Any) -> None:
        self._queue.put_nowait(event)

    def end_input(self) -> None:
        self.input_ended = True
        if self._block_drain:
            # Provider never finalises until release_drain().
            return
        self.release_drain()

    async def aclose(self) -> None:
        if self._block_aclose:
            # Hangs until cancelled, like a close racing a dead network.
            await asyncio.Event().wait()
        self.closed = True

    def __aiter__(self) -> "FakeSpeechStream":
        return self

    async def __anext__(self) -> Any:
        if self._fail_on_iter:
            raise RuntimeError("stt stream exploded")

        item = await self._queue.get()
        if item is None:
            raise StopAsyncIteration
        return item


class FakeSTT:
    def __init__(
        self,
        *,
        fail_streams: Optional[set[int]] = None,
        raise_on_stream: Optional[set[int]] = None,
    ) -> None:
        self.streams: List[FakeSpeechStream] = []
        self._fail_streams = fail_streams or set()
        self._raise_on_stream = raise_on_stream or set()
        self._fail_push_streams: set[int] = set()
        self._block_aclose_streams: set[int] = set()
        self._block_drain_streams: set[int] = set()
        self._fail_push_after: dict[int, int] = {}
        self.stream_calls = 0

    def fail_push_after(self, index: int, accepted: int) -> None:
        self._fail_push_after[index] = accepted

    def block_drain_on(self, *indexes: int) -> None:
        self._block_drain_streams.update(indexes)

    def fail_push_on(self, *indexes: int) -> None:
        self._fail_push_streams.update(indexes)

    def block_aclose_on(self, *indexes: int) -> None:
        self._block_aclose_streams.update(indexes)

    def stream(self) -> FakeSpeechStream:
        index = self.stream_calls
        self.stream_calls += 1
        if index in self._raise_on_stream:
            raise RuntimeError("provider refused a new stream")

        stream = FakeSpeechStream(
            fail_on_iter=index in self._fail_streams,
            fail_on_push=index in self._fail_push_streams,
            block_aclose=index in self._block_aclose_streams,
            block_drain=index in self._block_drain_streams,
            fail_push_after=self._fail_push_after.get(index),
        )
        self.streams.append(stream)
        return stream


class ScriptedVADStream:
    """Emits VAD events at scripted frame offsets.

    `wait_processed()` returns only once the gate's VAD consumer has taken the
    event *and* come back for the next one, which makes the tests deterministic
    without relying on how many event-loop turns a state update happens to take.
    """

    def __init__(self, script: Dict[int, str]) -> None:
        self._script = script
        self._frame_index = -1
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._in_flight = 0
        self._awaiting_ack = False
        self.input_ended = False
        self.closed = False

    def push_frame(self, frame: FakeFrame) -> None:
        self._frame_index += 1
        kind = self._script.get(self._frame_index)
        if kind is None:
            return

        self._in_flight += 1
        self._queue.put_nowait(
            vad_api.VADEvent(
                type=(
                    vad_api.VADEventType.START_OF_SPEECH
                    if kind == "start"
                    else vad_api.VADEventType.END_OF_SPEECH
                ),
                samples_index=0,
                timestamp=0.0,
                speech_duration=0.0,
                silence_duration=0.0,
            )
        )

    async def wait_processed(self) -> None:
        # Bounded: if the gate's VAD consumer dies, an unbounded wait here
        # would hang the whole suite instead of failing the one test.
        for _ in range(WAIT_MAX_TURNS):
            if not self._in_flight:
                return
            await asyncio.sleep(0)

        raise AssertionError(
            "gate did not consume a VAD event; its consumer task likely died"
        )

    def end_input(self) -> None:
        self.input_ended = True
        # Real VAD streams flush and end iteration once input ends; queued
        # events are still delivered first.
        self._queue.put_nowait(None)

    async def aclose(self) -> None:
        self.closed = True

    def __aiter__(self) -> "ScriptedVADStream":
        return self

    async def __anext__(self) -> Any:
        if self._awaiting_ack:
            # The consumer finished the previous event and asked for another.
            self._awaiting_ack = False
            self._in_flight -= 1

        event = await self._queue.get()
        if event is None:
            raise StopAsyncIteration
        self._awaiting_ack = True
        return event


class ScriptedVAD:
    def __init__(self, script: Dict[int, str]) -> None:
        self._script = script
        self.streams: List[ScriptedVADStream] = []

    def stream(self) -> ScriptedVADStream:
        stream = ScriptedVADStream(self._script)
        self.streams.append(stream)
        return stream


class RecordingObserver(SttGateObserver):
    def __init__(self) -> None:
        self.opens: List[bool] = []
        self.closes: List[float] = []
        self.admission_denied = 0
        self.prebuffer_flushes: List[float] = []
        self.errors: List[str] = []
        self.dropped_seconds = 0.0
        self.stream_opens = 0
        self.stream_closes: List[str] = []
        self.stream_healthy = 0

    def on_open(self, *, shadow: bool) -> None:
        self.opens.append(shadow)

    def on_stream_opened(self) -> None:
        self.stream_opens += 1

    def on_stream_closed(self, *, reason: str) -> None:
        self.stream_closes.append(reason)

    def on_stream_healthy(self) -> None:
        self.stream_healthy += 1

    def on_close(self, *, shadow: bool, open_seconds: float, reason: str) -> None:
        self.closes.append(open_seconds)

    def on_admission_denied(self, *, waited_seconds: float) -> None:
        self.admission_denied += 1

    def on_prebuffer_flush(self, *, frames: int, seconds: float) -> None:
        self.prebuffer_flushes.append(seconds)

    def on_stream_error(self, *, reason: str) -> None:
        self.errors.append(reason)

    def on_frames_dropped(self, *, frames: int, seconds: float) -> None:
        self.dropped_seconds += seconds


class GateHarness:
    """Drives a runner one frame at a time with full determinism."""

    def __init__(
        self,
        *,
        frame_count: int,
        vad_script: Dict[int, str],
        settings: SttGateSettings,
        stt: Optional[FakeSTT] = None,
        admission: Optional[SttAdmissionController] = None,
        observer: Optional[RecordingObserver] = None,
        barrier: Optional[asyncio.Barrier] = None,
    ) -> None:
        self.frames = [FakeFrame(index) for index in range(frame_count)]
        self.stt = stt or FakeSTT()
        self.vad = ScriptedVAD(vad_script)
        self.admission = admission or SttAdmissionController(None)
        self.observer = observer or RecordingObserver()
        self.events: List[Any] = []
        self._settings = settings
        # Multi-participant tests need a shared timeline: without a barrier
        # each harness advances its own audio clock at whatever rate the event
        # loop allows, and "concurrency" would just measure task scheduling.
        self._barrier = barrier
        self.runner = SttGateRunner(
            audio=self._audio(),
            stt=self.stt,
            vad=self.vad,
            settings=settings,
            admission=self.admission,
            observer=self.observer,
            label="test",
        )
        self._pause_at: Dict[int, Any] = {}

    def pause_at(self, frame_index: int, callback: Any) -> None:
        """Run `callback` after the gate has fully processed `frame_index`."""

        self._pause_at[frame_index] = callback

    async def _audio(self) -> AsyncIterator[FakeFrame]:
        for frame in self.frames:
            yield frame
            vad_stream = self.vad.streams[0] if self.vad.streams else None
            if vad_stream is not None:
                await vad_stream.wait_processed()
            await self.runner.settle()

            callback = self._pause_at.pop(frame.index, None)
            if callback is not None:
                result = callback(self)
                if asyncio.iscoroutine(result):
                    await result
                await self.runner.settle()

            if self._barrier is not None:
                await self._barrier.wait()

    async def run(self) -> None:
        async for event in self.runner.run():
            self.events.append(event)


def make_settings(**overrides: Any) -> SttGateSettings:
    base = {
        "mode": GATE_MODE_ON,
        "hold_open_seconds": 0.2,
        "min_open_seconds": 0.0,
        "prebuffer_seconds": 0.1,
        "admission_capacity": 0,
        "admission_wait_seconds": 0.05,
        "max_blocked_buffer_seconds": 5.0,
    }
    base.update(overrides)
    return SttGateSettings(**base)


class SttGateGatingTests(unittest.IsolatedAsyncioTestCase):
    async def test_opens_on_speech_and_closes_after_hold_open(self) -> None:
        # Speech at frame 2, ends at frame 4, then silence past the hold window.
        harness = GateHarness(
            frame_count=20,
            vad_script={2: "start", 4: "end"},
            settings=make_settings(hold_open_seconds=0.2),
        )

        await harness.run()

        self.assertEqual(len(harness.stt.streams), 1)
        self.assertEqual(harness.observer.opens, [False])
        self.assertEqual(len(harness.observer.closes), 1)
        self.assertTrue(harness.stt.streams[0].closed)

    async def test_silent_participant_never_opens_a_stream(self) -> None:
        harness = GateHarness(
            frame_count=40,
            vad_script={},
            settings=make_settings(),
        )

        await harness.run()

        # This is the whole point: a connected but silent participant costs
        # nothing against the inference concurrency budget.
        self.assertEqual(harness.stt.streams, [])
        self.assertEqual(harness.observer.opens, [])

    async def test_speech_audio_reaches_the_stream_without_gaps(self) -> None:
        harness = GateHarness(
            frame_count=20,
            vad_script={5: "start", 12: "end"},
            settings=make_settings(hold_open_seconds=10.0, prebuffer_seconds=0.2),
        )

        await harness.run()

        self.assertEqual(len(harness.stt.streams), 1)
        delivered = [frame.index for frame in harness.stt.streams[0].frames]

        # Contiguous: no holes anywhere in what the STT received.
        self.assertEqual(delivered, list(range(delivered[0], delivered[-1] + 1)))
        # Pre-roll: audio from before the VAD fired is flushed in, so the start
        # of the utterance is not clipped.
        self.assertLess(delivered[0], 5)
        # Everything from the open through the end of the audio is present.
        self.assertEqual(delivered[-1], 19)

    async def test_trailing_final_transcript_survives_the_close(self) -> None:
        harness = GateHarness(
            frame_count=20,
            vad_script={2: "start", 4: "end"},
            settings=make_settings(hold_open_seconds=0.2),
        )

        await harness.run()

        finals = [
            event
            for event in harness.events
            if event.type == stt_api.SpeechEventType.FINAL_TRANSCRIPT
        ]
        # end_input() -> drain -> aclose(): the last words are not truncated.
        self.assertEqual(len(finals), 1)
        self.assertEqual(finals[0].alternatives[0].text, "trailing")

    async def test_min_open_seconds_holds_a_short_utterance_open(self) -> None:
        harness = GateHarness(
            frame_count=20,
            vad_script={1: "start", 2: "end"},
            settings=make_settings(hold_open_seconds=0.05, min_open_seconds=0.5),
        )

        await harness.run()

        self.assertEqual(len(harness.observer.closes), 1)
        # Closed on the min-open floor rather than the (much shorter) hold
        # window, so a two-syllable backchannel cannot churn the websocket.
        self.assertGreaterEqual(harness.observer.closes[0], 0.5)

    async def test_repeated_utterances_reuse_one_slot_sequentially(self) -> None:
        harness = GateHarness(
            frame_count=40,
            vad_script={2: "start", 4: "end", 20: "start", 22: "end"},
            settings=make_settings(hold_open_seconds=0.2),
            admission=SttAdmissionController(1),
        )

        await harness.run()

        # Two separate streams, never concurrent: the slot is released on close
        # and re-acquired on the next utterance.
        self.assertEqual(len(harness.stt.streams), 2)
        self.assertEqual(harness.admission.peak_in_use, 1)
        self.assertEqual(harness.admission.in_use, 0)
        self.assertEqual(harness.admission.denied, 0)


class SttGateShadowTests(unittest.IsolatedAsyncioTestCase):
    async def test_shadow_records_decisions_without_closing_the_stream(self) -> None:
        harness = GateHarness(
            frame_count=20,
            vad_script={2: "start", 4: "end"},
            settings=make_settings(mode=GATE_MODE_SHADOW, hold_open_seconds=0.2),
        )

        await harness.run()

        # One stream for the whole session — production behaviour is unchanged.
        self.assertEqual(len(harness.stt.streams), 1)
        self.assertEqual(
            [frame.index for frame in harness.stt.streams[0].frames],
            [frame.index for frame in harness.frames],
        )
        # But the decisions enforcement would have made are recorded.
        self.assertEqual(harness.observer.opens, [True])
        self.assertEqual(len(harness.observer.closes), 1)

    async def test_shadow_is_not_blocked_by_a_full_admission_budget(self) -> None:
        admission = SttAdmissionController(1)
        self.assertTrue(await admission.acquire(timeout=0.01))

        harness = GateHarness(
            frame_count=12,
            vad_script={2: "start"},
            settings=make_settings(
                mode=GATE_MODE_SHADOW,
                admission_wait_seconds=0.01,
            ),
            admission=admission,
        )

        await harness.run()

        # Shadow must never cost transcript: an exhausted budget can deny a
        # prediction, but it must not deny the real stream.
        self.assertEqual(len(harness.stt.streams), 1)
        self.assertEqual(
            [frame.index for frame in harness.stt.streams[0].frames],
            [frame.index for frame in harness.frames],
        )
        self.assertEqual(harness.observer.admission_denied, 0)
        self.assertEqual(harness.observer.dropped_seconds, 0.0)


class SttGateAdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_denied_admission_buffers_audio_and_retries(self) -> None:
        admission = SttAdmissionController(1)
        # Hold the only slot so the gate's first open attempt is refused.
        self.assertTrue(await admission.acquire(timeout=0.01))

        harness = GateHarness(
            frame_count=40,
            vad_script={2: "start"},
            settings=make_settings(
                hold_open_seconds=100.0,
                admission_wait_seconds=0.01,
                max_blocked_buffer_seconds=100.0,
            ),
            admission=admission,
        )

        def release_slot(_: GateHarness) -> None:
            admission.release()

        harness.pause_at(10, release_slot)

        await harness.run()

        self.assertGreaterEqual(harness.observer.admission_denied, 1)
        self.assertEqual(len(harness.stt.streams), 1)

        delivered = [frame.index for frame in harness.stt.streams[0].frames]
        # Audio buffered during the denial is flushed once a slot frees up,
        # contiguously and in order — a denial costs latency, not words.
        self.assertEqual(delivered, list(range(delivered[0], delivered[-1] + 1)))
        self.assertLessEqual(delivered[0], 2)
        self.assertEqual(harness.observer.dropped_seconds, 0.0)

    async def test_blocked_buffer_is_bounded_and_reports_loss(self) -> None:
        admission = SttAdmissionController(1)
        self.assertTrue(await admission.acquire(timeout=0.01))

        harness = GateHarness(
            frame_count=40,
            vad_script={2: "start"},
            settings=make_settings(
                hold_open_seconds=100.0,
                admission_wait_seconds=0.01,
                max_blocked_buffer_seconds=0.25,
            ),
            admission=admission,
        )

        await harness.run()

        # Memory stays bounded when a slot never frees, and the audio we had to
        # discard is counted rather than silently dropped.
        self.assertGreater(harness.observer.dropped_seconds, 0.0)
        self.assertEqual(harness.stt.streams, [])


class SttGateFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_failure_releases_slot_and_reopens(self) -> None:
        admission = SttAdmissionController(1)
        harness = GateHarness(
            frame_count=60,
            vad_script={2: "start", 30: "start"},
            settings=make_settings(hold_open_seconds=100.0),
            stt=FakeSTT(fail_streams={0}),
            admission=admission,
        )

        await harness.run()

        self.assertIn("stream_failed", harness.observer.errors)
        # A failed stream costs one utterance, not the rest of the meeting:
        # the gate reopens instead of going permanently deaf.
        self.assertGreaterEqual(len(harness.stt.streams), 2)
        self.assertEqual(admission.in_use, 0)


class SttGateConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_turn_taking_meeting_peaks_below_participant_count(self) -> None:
        """Six participants taking turns should not pin six streams."""

        speakers = 6
        admission = SttAdmissionController(None)
        barrier = asyncio.Barrier(speakers)
        harnesses = []
        for speaker in range(speakers):
            start = 4 + speaker * 12
            harnesses.append(
                GateHarness(
                    frame_count=90,
                    vad_script={start: "start", start + 4: "end"},
                    settings=make_settings(hold_open_seconds=0.2, min_open_seconds=0.0),
                    admission=admission,
                    barrier=barrier,
                )
            )

        await asyncio.gather(*(harness.run() for harness in harnesses))

        # Each participant opened exactly once, for their own turn only.
        for harness in harnesses:
            self.assertEqual(len(harness.stt.streams), 1)

        # The ungated design would have held six concurrent streams for the
        # whole meeting. With clean turn-taking the peak is one.
        self.assertEqual(admission.peak_in_use, 1)
        self.assertEqual(admission.in_use, 0)


    async def test_simultaneous_speakers_do_use_concurrent_streams(self) -> None:
        """The gate tracks who is talking, so genuine overlap still costs slots."""

        speakers = 3
        admission = SttAdmissionController(None)
        barrier = asyncio.Barrier(speakers)
        harnesses = [
            GateHarness(
                frame_count=40,
                # Everyone talks over each other in the same window.
                vad_script={4: "start", 10: "end"},
                settings=make_settings(hold_open_seconds=0.2, min_open_seconds=0.0),
                admission=admission,
                barrier=barrier,
            )
            for _ in range(speakers)
        ]

        await asyncio.gather(*(harness.run() for harness in harnesses))

        self.assertEqual(admission.peak_in_use, speakers)
        self.assertEqual(admission.in_use, 0)


class SttAdmissionControllerTests(unittest.IsolatedAsyncioTestCase):
    async def test_unlimited_capacity_never_denies(self) -> None:
        admission = SttAdmissionController(0)

        for _ in range(50):
            self.assertTrue(await admission.acquire(timeout=0.01))

        self.assertIsNone(admission.capacity)
        self.assertEqual(admission.denied, 0)
        self.assertEqual(admission.in_use, 50)

    async def test_capacity_is_enforced_and_released(self) -> None:
        admission = SttAdmissionController(2)

        self.assertTrue(await admission.acquire(timeout=0.01))
        self.assertTrue(await admission.acquire(timeout=0.01))
        self.assertFalse(await admission.acquire(timeout=0.01))
        self.assertEqual(admission.denied, 1)

        admission.release()
        self.assertTrue(await admission.acquire(timeout=0.01))
        self.assertEqual(admission.in_use, 2)
        self.assertEqual(admission.peak_in_use, 2)

    async def test_release_without_acquire_is_a_noop(self) -> None:
        admission = SttAdmissionController(1)
        admission.release()

        self.assertEqual(admission.in_use, 0)
        self.assertTrue(await admission.acquire(timeout=0.01))
        self.assertFalse(await admission.acquire(timeout=0.01))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class SttGateTeardownTests(unittest.IsolatedAsyncioTestCase):
    """Regressions for the lifecycle bugs found in review."""

    async def test_trailing_final_survives_shutdown_while_gate_open(self) -> None:
        harness = GateHarness(
            frame_count=10,
            vad_script={2: "start"},
            # Never idles: the session ends with the gate still open, which is
            # what happens when a meeting ends mid-sentence.
            settings=make_settings(hold_open_seconds=1000.0),
        )

        await harness.run()

        finals = [
            event
            for event in harness.events
            if getattr(event, "type", None) == stt_api.SpeechEventType.FINAL_TRANSCRIPT
        ]
        # The sentinel must be queued *after* the drain, or the last thing said
        # in the meeting lands behind it and is never yielded.
        self.assertEqual(len(finals), 1)

    async def test_shutdown_emits_a_logical_close_for_an_open_gate(self) -> None:
        harness = GateHarness(
            frame_count=10,
            vad_script={2: "start"},
            settings=make_settings(hold_open_seconds=1000.0),
        )

        await harness.run()

        # Without this the open-gauge leaks upward for every gate that ends
        # mid-utterance, and the peak we tune rollout from drifts high.
        self.assertEqual(len(harness.observer.opens), 1)
        self.assertEqual(len(harness.observer.closes), 1)

    async def test_open_failure_releases_the_admission_slot(self) -> None:
        admission = SttAdmissionController(1)
        harness = GateHarness(
            # Long enough to outlast the post-failure backoff (1 audio second)
            # so the retry is observable.
            frame_count=48,
            vad_script={2: "start"},
            settings=make_settings(hold_open_seconds=1000.0),
            stt=FakeSTT(raise_on_stream={0}),
            admission=admission,
        )

        await harness.run()

        # A throw between acquiring the slot and publishing the stream must not
        # strand the slot, or capacity bleeds away one failure at a time.
        self.assertEqual(admission.in_use, 0)
        self.assertIn("open_failed", harness.observer.errors)
        # And the gate recovers: the retry after backoff succeeds.
        self.assertGreaterEqual(harness.stt.stream_calls, 2)

    async def test_failed_stream_is_closed_not_just_forgotten(self) -> None:
        # Capacity of exactly 1: the retry can only succeed if the failed
        # stream's permit was genuinely returned to the semaphore, not merely
        # decremented off the counter.
        admission = SttAdmissionController(1)
        harness = GateHarness(
            frame_count=60,
            vad_script={2: "start"},
            settings=make_settings(hold_open_seconds=1000.0),
            # The failure surfaces from iterating the stream, so teardown is
            # initiated by the forwarder task itself — the path where a
            # self-cancel would abort cleanup before aclose().
            stt=FakeSTT(fail_streams={0}),
            admission=admission,
        )

        await harness.run()

        # The dead stream's provider session must actually be closed, not just
        # dropped from our bookkeeping while it stays alive upstream.
        self.assertTrue(harness.stt.streams[0].closed)
        self.assertEqual(admission.in_use, 0)
        self.assertEqual(admission.peak_in_use, 1)
        self.assertGreaterEqual(len(harness.stt.streams), 2)
        self.assertTrue(all(stream.closed for stream in harness.stt.streams))

    async def test_every_opened_stream_reports_a_close(self) -> None:
        harness = GateHarness(
            frame_count=60,
            vad_script={2: "start", 4: "end", 30: "start", 32: "end"},
            settings=make_settings(hold_open_seconds=0.2),
        )

        await harness.run()

        # Stream-lifecycle hooks must balance, since the capacity gauge is
        # driven from them rather than from gate decisions.
        self.assertEqual(harness.observer.stream_opens, len(harness.stt.streams))
        self.assertEqual(
            len(harness.observer.stream_closes), harness.observer.stream_opens
        )
        self.assertTrue(all(stream.closed for stream in harness.stt.streams))

    async def test_admission_denial_does_not_report_a_stream_open(self) -> None:
        admission = SttAdmissionController(1)
        self.assertTrue(await admission.acquire(timeout=0.01))

        harness = GateHarness(
            frame_count=12,
            vad_script={2: "start"},
            settings=make_settings(
                hold_open_seconds=1000.0,
                admission_wait_seconds=0.01,
                max_blocked_buffer_seconds=100.0,
            ),
            admission=admission,
        )

        await harness.run()

        # The gate decided "open" but no provider session exists. Anything that
        # means "recovered" or "in use" must key off the stream hook, not this.
        self.assertEqual(harness.observer.opens, [False])
        self.assertEqual(harness.observer.stream_opens, 0)
        self.assertGreaterEqual(harness.observer.admission_denied, 1)


class SttGateLateOpenAndVadFailureTests(unittest.IsolatedAsyncioTestCase):
    """Regressions for the third review round."""

    async def test_late_admission_grant_does_not_open_after_gate_closed(self) -> None:
        """A blocked acquire must not produce a stream for a gate that closed.

        The open task can wait on admission long enough for the utterance to
        end and the gate to close on idle. When the slot finally frees, the
        open must be abandoned — otherwise the stream has no owner: the gate
        is closed, so no idle close ever fires, and the provider session plus
        the admission slot leak until session shutdown.
        """

        admission = SttAdmissionController(1)
        self.assertTrue(await admission.acquire(timeout=0.01))  # hog the only slot

        stt = FakeSTT()
        observer = RecordingObserver()
        vad = ScriptedVAD({2: "start", 4: "end"})
        settings = make_settings(
            hold_open_seconds=0.2,
            min_open_seconds=0.05,
            admission_wait_seconds=30.0,  # far outlasts the gate's close
        )

        released = False

        async def audio() -> AsyncIterator[FakeFrame]:
            nonlocal released
            for index in range(40):
                yield FakeFrame(index)
                vad_stream = vad.streams[0]
                await vad_stream.wait_processed()
                for _ in range(3):
                    await asyncio.sleep(0)

                if not released and index > 4 and not runner.gate_open:
                    # The gate has closed on idle while the open task is still
                    # parked on admission. Free the slot: the stale open must
                    # now be abandoned, not completed.
                    released = True
                    admission.release()
                    for _ in range(10):
                        await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=settings,
            admission=admission,
            observer=observer,
            label="late-open",
        )
        async for _ in runner.run():
            pass

        self.assertFalse(runner.gate_open)
        self.assertEqual(observer.stream_opens, 0)
        self.assertEqual(stt.streams, [])
        self.assertEqual(admission.in_use, 0)

    async def test_vad_failure_fails_open_instead_of_going_silent(self) -> None:
        """A dead VAD consumer must not silently end a participant's transcript.

        If the VAD stream raises, the consumer exits while the pump keeps
        running. Without a fallback the gate never opens again and the
        participant's words simply stop appearing. The correct degradation is
        to fail open — permanent stream, pre-gate behaviour — trading cost for
        transcript.
        """

        class ExplodingVADStream:
            def __init__(self) -> None:
                self.closed = False

            def push_frame(self, frame: Any) -> None:
                return None

            def end_input(self) -> None:
                return None

            async def aclose(self) -> None:
                self.closed = True

            def __aiter__(self) -> "ExplodingVADStream":
                return self

            async def __anext__(self) -> Any:
                await asyncio.sleep(0)
                raise RuntimeError("vad model crashed")

        class ExplodingVAD:
            def __init__(self) -> None:
                self.streams: List[ExplodingVADStream] = []

            def stream(self) -> ExplodingVADStream:
                stream = ExplodingVADStream()
                self.streams.append(stream)
                return stream

        stt = FakeSTT()
        observer = RecordingObserver()

        async def audio() -> AsyncIterator[FakeFrame]:
            for index in range(30):
                yield FakeFrame(index)
                await asyncio.sleep(0)
                await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=ExplodingVAD(),
            settings=make_settings(hold_open_seconds=0.2, min_open_seconds=0.05),
            admission=SttAdmissionController(None),
            observer=observer,
            label="vad-dead",
        )
        async for _ in runner.run():
            pass

        # Fail-open: a stream exists, stays up for the rest of the session,
        # and the tail of the audio reaches it.
        self.assertEqual(observer.stream_opens, 1)
        self.assertEqual(len(stt.streams), 1)
        self.assertIn("vad_failed", observer.errors)
        delivered = [frame.index for frame in stt.streams[0].frames]
        self.assertIn(29, delivered)


def _delivered_indexes(stt: FakeSTT) -> List[int]:
    return sorted(frame.index for stream in stt.streams for frame in stream.frames)


class SttGateFourthRoundTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_aborts_an_open_still_parked_on_admission(self) -> None:
        """Audio ending must abort a pending open, not wait for or honour it.

        If the pump ends while an open is parked on admission, draining the
        transition stalls shutdown for up to the full admission wait — and if
        the slot then frees, the open publishes a stream after shutdown whose
        events sit behind the sentinel, never yielded, its slot only released
        by the outer backstop.
        """

        admission = SttAdmissionController(1)
        self.assertTrue(await admission.acquire(timeout=0.01))  # hog the slot

        stt = FakeSTT()
        observer = RecordingObserver()
        vad = ScriptedVAD({2: "start"})

        async def audio() -> AsyncIterator[FakeFrame]:
            # Ends while the open (spawned at frame 2) is still blocked.
            for index in range(6):
                yield FakeFrame(index)
                vad_stream = vad.streams[0]
                await vad_stream.wait_processed()
                for _ in range(3):
                    await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(
                hold_open_seconds=1000.0,
                admission_wait_seconds=30.0,
            ),
            admission=admission,
            observer=observer,
            label="shutdown-pending-open",
        )

        async def consume() -> None:
            async for _ in runner.run():
                pass

        # Old behaviour: shutdown blocks on the parked acquire for the full
        # admission wait. Two seconds is three orders of magnitude of headroom
        # over a correct shutdown while still failing fast against the bug.
        await asyncio.wait_for(consume(), timeout=2.0)

        self.assertEqual(observer.stream_opens, 0)
        self.assertEqual(stt.streams, [])
        self.assertEqual(admission.in_use, 1)  # only the hog remains

    async def test_shadow_reopens_after_a_stream_failure(self) -> None:
        """Shadow must stay behaviour-identical to today across a failure.

        Shadow opens one real stream up front, but nothing reopened it after a
        failure, so a single provider blip silenced the participant for the
        rest of the session — in exactly the mode whose promise is 'transcripts
        unchanged'.
        """

        stt = FakeSTT(fail_streams={0})
        observer = RecordingObserver()
        vad = ScriptedVAD({})  # no speech events at all: reopen must not need them

        async def audio() -> AsyncIterator[FakeFrame]:
            # 60 frames = 3 audio-seconds, past the 1s reopen backoff.
            for index in range(60):
                yield FakeFrame(index)
                await asyncio.sleep(0)
                await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(mode=GATE_MODE_SHADOW),
            admission=SttAdmissionController(None),
            observer=observer,
            label="shadow-reopen",
        )
        async for _ in runner.run():
            pass

        self.assertGreaterEqual(len(stt.streams), 2)
        # Nothing may be lost across the gap: frames buffered while the stream
        # was down must be flushed into the replacement.
        self.assertEqual(_delivered_indexes(stt), list(range(60)))

    async def test_prebuffer_survives_a_failed_flush(self) -> None:
        """A flush that dies mid-buffer must not eat the frames it popped.

        The flush consumed the deque destructively, so a push failure partway
        through abandoned the open with the already-popped audio gone — the
        retry then opened cleanly but could only transcribe from the gap
        onward.
        """

        stt = FakeSTT()
        stt.fail_push_on(0)  # first stream rejects every frame, incl. the flush
        observer = RecordingObserver()
        vad = ScriptedVAD({2: "start"})

        async def audio() -> AsyncIterator[FakeFrame]:
            # 60 frames = 3s: within both buffer windows, past the 1s backoff.
            for index in range(60):
                yield FakeFrame(index)
                if vad.streams:
                    await vad.streams[0].wait_processed()
                await asyncio.sleep(0)
                await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(
                hold_open_seconds=1000.0,
                # Wide pre-roll so frames 0-1 are still buffered when the
                # first open flushes — the frames the destructive flush ate.
                prebuffer_seconds=1.5,
            ),
            admission=SttAdmissionController(None),
            observer=observer,
            label="flush-failure",
        )
        async for _ in runner.run():
            pass

        self.assertGreaterEqual(len(stt.streams), 2)
        # Every frame — including the pre-roll popped during the failed
        # flush — must reach a healthy stream.
        healthy = [frame.index for frame in stt.streams[-1].frames]
        self.assertEqual(healthy, list(range(60)))


class SttGateFifthRoundTests(unittest.IsolatedAsyncioTestCase):
    async def test_clean_stream_eof_tears_down_and_reopens(self) -> None:
        """A provider ending the stream normally must not wedge the gate.

        Only exceptions triggered teardown; a clean EOF left `self._open` set
        and the slot held, with no reopen ever scheduled — the participant
        stayed wedged until session shutdown.
        """

        admission = SttAdmissionController(1)
        stt = FakeSTT()
        observer = RecordingObserver()
        vad = ScriptedVAD({2: "start"})
        ended = False

        async def audio() -> AsyncIterator[FakeFrame]:
            nonlocal ended
            # 60 frames = 3s: past the 1s reopen backoff after the EOF.
            for index in range(60):
                yield FakeFrame(index)
                if vad.streams:
                    await vad.streams[0].wait_processed()
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                if not ended and stt.streams:
                    # Provider closes the stream normally mid-turn.
                    ended = True
                    stt.streams[0].end_cleanly()
                    for _ in range(5):
                        await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(hold_open_seconds=1000.0, admission_capacity=1),
            admission=admission,
            observer=observer,
            label="clean-eof",
        )
        async for _ in runner.run():
            pass

        # A replacement stream must have opened — with capacity 1, that is
        # only possible if the dead stream's slot was actually released.
        self.assertGreaterEqual(len(stt.streams), 2)
        self.assertEqual(admission.in_use, 0)
        self.assertTrue(all(stream.closed for stream in stt.streams))

    async def test_cancel_during_partial_open_cleanup_releases_slot(self) -> None:
        """Shutdown cancelling a failing open must still release its slot.

        The partial-open cleanup awaited aclose() before releasing admission;
        a CancelledError delivered during that await skipped the release and
        stranded the slot — and shutdown's abort-pending-open is exactly the
        cancel that hits this window.
        """

        admission = SttAdmissionController(1)
        stt = FakeSTT()
        stt.fail_push_on(0)      # flush fails -> cleanup path
        stt.block_aclose_on(0)   # cleanup hangs on aclose -> cancel lands there
        vad = ScriptedVAD({2: "start"})

        async def audio() -> AsyncIterator[FakeFrame]:
            # Ends while cleanup is parked on the blocked aclose.
            for index in range(6):
                yield FakeFrame(index)
                if vad.streams:
                    await vad.streams[0].wait_processed()
                await asyncio.sleep(0)
                await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(hold_open_seconds=1000.0, admission_capacity=1),
            admission=admission,
            observer=RecordingObserver(),
            label="cancel-cleanup",
        )

        async def consume() -> None:
            async for _ in runner.run():
                pass

        await asyncio.wait_for(consume(), timeout=2.0)
        self.assertEqual(admission.in_use, 0)

    async def test_back_to_back_frames_spawn_a_single_open(self) -> None:
        """Frames processed without a loop yield must not double-spawn opens.

        `_open_pending` was set inside the spawned task, so frames arriving
        back-to-back each spawned an open; `_open_task` kept only the last, so
        shutdown cancelled the wrong task while an earlier one stayed parked
        on admission — reintroducing the shutdown stall.
        """

        admission = SttAdmissionController(1)
        self.assertTrue(await admission.acquire(timeout=0.01))  # hog the slot

        stt = FakeSTT()
        observer = RecordingObserver()
        vad = ScriptedVAD({0: "start"})

        async def audio() -> AsyncIterator[FakeFrame]:
            yield FakeFrame(0)
            await vad.streams[0].wait_processed()  # gate is now open
            # Back-to-back: no await between these yields, so the pump
            # processes both frames in one scheduling slice.
            yield FakeFrame(1)
            yield FakeFrame(2)
            await asyncio.sleep(0)
            await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(
                hold_open_seconds=1000.0,
                admission_capacity=1,
                admission_wait_seconds=30.0,
            ),
            admission=admission,
            observer=observer,
            label="single-flight",
        )

        async def consume() -> None:
            async for _ in runner.run():
                pass

        # Old behaviour: the orphaned first open stalls shutdown on its
        # 30s admission wait because only the second task was cancelled.
        await asyncio.wait_for(consume(), timeout=2.0)
        self.assertEqual(observer.stream_opens, 0)
        self.assertEqual(admission.in_use, 1)  # only the hog

    async def test_health_requires_an_event_not_just_a_stream_object(self) -> None:
        """Stream creation is not evidence of provider health.

        Recovery bookkeeping cleared on on_stream_opened, which fires when the
        local object is built — before the provider has said anything. A
        fast open/fail loop would clear stt_failed_at every cycle and postpone
        the reconcile rebuild forever. Health must mean an event arrived.
        """

        stt = FakeSTT(fail_streams={0})  # first stream dies before any event
        observer = RecordingObserver()
        vad = ScriptedVAD({2: "start"})

        async def audio() -> AsyncIterator[FakeFrame]:
            # 60 frames = 3s: failure, backoff, reopen, healthy events flow.
            for index in range(60):
                yield FakeFrame(index)
                if vad.streams:
                    await vad.streams[0].wait_processed()
                await asyncio.sleep(0)
                await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(hold_open_seconds=1000.0),
            admission=SttAdmissionController(None),
            observer=observer,
            label="health-evidence",
        )
        async for _ in runner.run():
            pass

        self.assertGreaterEqual(observer.stream_opens, 2)
        # Only the replacement stream ever produced an event (its trailing
        # final during drain); the dead stream must not have counted.
        self.assertEqual(observer.stream_healthy, 1)


class SttGateSixthRoundTests(unittest.IsolatedAsyncioTestCase):
    async def test_final_utterance_at_eof_is_not_beaten_by_shutdown(self) -> None:
        """Audio ending must let the last VAD decision land first.

        A START_OF_SPEECH still queued when the audio iterator finishes used
        to lose to shutdown: the pump tore everything down before the consumer
        processed the event, so an utterance beginning right at EOF — someone
        talking as the meeting closes — was never transcribed at all.
        """

        stt = FakeSTT()
        observer = RecordingObserver()
        # Speech starts on the very last frame; the audio generator returns
        # immediately after, without giving the consumer a turn.
        vad = ScriptedVAD({9: "start"})

        async def audio() -> AsyncIterator[FakeFrame]:
            for index in range(10):
                yield FakeFrame(index)
                if index < 9:
                    await vad.streams[0].wait_processed()
                    await asyncio.sleep(0)
                # Frame 9: fall straight out — the START event is still queued.

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(
                hold_open_seconds=1000.0,
                prebuffer_seconds=1.5,  # keep the whole tail in pre-roll
            ),
            admission=SttAdmissionController(None),
            observer=observer,
            label="eof-utterance",
        )
        events: List[Any] = []
        async for event in runner.run():
            events.append(event)

        # The late decision must have produced a stream, flushed the buffered
        # tail into it, and drained its trailing final before the sentinel.
        self.assertEqual(len(stt.streams), 1)
        delivered = [frame.index for frame in stt.streams[0].frames]
        self.assertIn(9, delivered)
        finals = [
            event
            for event in events
            if getattr(event, "type", None) == stt_api.SpeechEventType.FINAL_TRANSCRIPT
        ]
        self.assertEqual(len(finals), 1)


class SttGateSeventhRoundTests(unittest.IsolatedAsyncioTestCase):
    async def test_admission_wait_of_zero_grants_available_capacity(self) -> None:
        """timeout=0 must mean 'don't wait', not 'always deny'.

        wait_for(acquire(), timeout=0) cancels before the semaphore's fast
        path can run, so a zero wait denied every open even with the whole
        budget free.
        """

        admission = SttAdmissionController(2)

        self.assertTrue(await admission.acquire(timeout=0))
        self.assertTrue(await admission.acquire(timeout=0))
        self.assertEqual(admission.in_use, 2)
        # Budget genuinely exhausted: zero-wait now correctly denies.
        self.assertFalse(await admission.acquire(timeout=0))
        self.assertEqual(admission.denied, 1)

        admission.release()
        self.assertTrue(await admission.acquire(timeout=0))

    async def test_previous_utterance_final_lands_before_next_utterance_events(
        self,
    ) -> None:
        """An idle-closing stream's trailing final must not reorder.

        Teardown detaches the record before the drain finishes, so a reopen
        on new speech could forward its events into the output while the old
        stream was still emitting utterance N's trailing final — reordering
        the transcript across the gap.
        """

        stt = FakeSTT()
        stt.block_drain_on(0)
        observer = RecordingObserver()
        vad = ScriptedVAD({2: "start", 4: "end", 30: "start"})
        released = False

        async def audio() -> AsyncIterator[FakeFrame]:
            nonlocal released
            for index in range(60):
                yield FakeFrame(index)
                vad_stream = vad.streams[0]
                await vad_stream.wait_processed()
                await asyncio.sleep(0)
                await asyncio.sleep(0)

                if index == 34 and len(stt.streams) >= 2 and not released:
                    # Utterance 2 speaks while utterance 1 still drains.
                    stt.streams[1].emit(
                        stt_api.SpeechEvent(
                            type=stt_api.SpeechEventType.INTERIM_TRANSCRIPT,
                            alternatives=[
                                stt_api.SpeechData(language="en", text="second")
                            ],
                        )
                    )
                    for _ in range(6):
                        await asyncio.sleep(0)
                    released = True
                    stt.streams[0].release_drain()
                    for _ in range(6):
                        await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(hold_open_seconds=0.3, min_open_seconds=0.0),
            admission=SttAdmissionController(None),
            observer=observer,
            label="order",
        )
        events: List[Any] = []
        async for event in runner.run():
            events.append(event)

        texts = [
            event.alternatives[0].text
            for event in events
            if getattr(event, "alternatives", None)
        ]
        self.assertIn("trailing", texts)
        self.assertIn("second", texts)
        self.assertLess(texts.index("trailing"), texts.index("second"))


class SttGateEighthRoundTests(unittest.IsolatedAsyncioTestCase):
    async def test_partial_flush_does_not_replay_accepted_audio(self) -> None:
        """A flush that dies partway must not resend what already landed.

        The flush was made non-destructive so a mid-flush failure would not
        eat the pre-roll. That fixed loss but introduced replay: frames the
        dying stream had already accepted stayed in the buffer and were
        pushed again into the retry — the same audio billed and transcribed
        twice, on exactly the failure path this gate exists to recover from.

        The correct invariant is both at once: every frame reaches a stream
        exactly once.
        """

        stt = FakeSTT()
        # First stream takes 3 frames of the pre-roll, then dies.
        stt.fail_push_after(0, 3)
        observer = RecordingObserver()
        vad = ScriptedVAD({8: "start"})

        async def audio() -> AsyncIterator[FakeFrame]:
            # Speech starts at frame 8 so a real pre-roll has accumulated;
            # 60 frames leaves room for the 1s backoff and the retry.
            for index in range(60):
                yield FakeFrame(index)
                await vad.streams[0].wait_processed()
                await asyncio.sleep(0)
                await asyncio.sleep(0)

        runner = SttGateRunner(
            audio=audio(),
            stt=stt,
            vad=vad,
            settings=make_settings(
                hold_open_seconds=1000.0,
                prebuffer_seconds=1.5,
            ),
            admission=SttAdmissionController(None),
            observer=observer,
            label="partial-flush",
        )
        async for _ in runner.run():
            pass

        self.assertGreaterEqual(len(stt.streams), 2)
        self.assertEqual(len(stt.streams[0].frames), 3)  # the accepted prefix

        delivered = [
            frame.index for stream in stt.streams for frame in stream.frames
        ]
        # No frame is sent twice...
        self.assertEqual(
            len(delivered),
            len(set(delivered)),
            f"audio replayed into a second stream: {sorted(delivered)}",
        )
        # ...and the round-four property still holds: none is dropped either.
        # The prefix the dying stream took is contiguous with the retry's.
        surviving = [frame.index for frame in stt.streams[-1].frames]
        prefix = [frame.index for frame in stt.streams[0].frames]
        self.assertEqual(prefix + surviving, sorted(prefix + surviving))
        self.assertEqual(max(delivered), 59)
