from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from typing import Any, AsyncIterator, List, Optional


SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from meeting_agent.stt_activity_gate import (  # noqa: E402
    SttActivityGateRunner,
    SttActivityGateSettings,
)


class FakeFrame:
    def __init__(self, index: int) -> None:
        self.index = index
        self.duration = 0.05


class FakeSpeechStream:
    def __init__(self, *, fail_on_iter: bool = False, block_drain: bool = False) -> None:
        self.frames: List[FakeFrame] = []
        self.input_ended = False
        self.closed = False
        self._queue: asyncio.Queue[Any] = asyncio.Queue()
        self._fail_on_iter = fail_on_iter
        self._block_drain = block_drain

    def push_frame(self, frame: FakeFrame) -> None:
        if self.input_ended:
            raise RuntimeError("stream input already ended")
        self.frames.append(frame)

    def end_input(self) -> None:
        self.input_ended = True
        if self._block_drain:
            # Provider never finalises: the drain hangs until it is released.
            return
        self._queue.put_nowait("final")
        self._queue.put_nowait(None)

    def release_drain(self) -> None:
        self._queue.put_nowait("final")
        self._queue.put_nowait(None)

    def emit(self, event: Any) -> None:
        self._queue.put_nowait(event)

    def end_cleanly(self) -> None:
        """Provider closes the stream normally: iteration just stops."""
        self._queue.put_nowait(None)

    async def aclose(self) -> None:
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
        block_drain_streams: Optional[set[int]] = None,
    ) -> None:
        self.streams: List[FakeSpeechStream] = []
        self._fail_streams = fail_streams or set()
        self._block_drain_streams = block_drain_streams or set()

    def stream(self) -> FakeSpeechStream:
        index = len(self.streams)
        stream = FakeSpeechStream(
            fail_on_iter=index in self._fail_streams,
            block_drain=index in self._block_drain_streams,
        )
        self.streams.append(stream)
        return stream


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def make_settings(**overrides: Any) -> SttActivityGateSettings:
    base = {
        "enabled": True,
        "idle_close_seconds": 5.0,
        # Long enough that the watchdog never fires during a test; idle closes
        # are driven explicitly through close_if_idle().
        "poll_interval_seconds": 3600.0,
    }
    base.update(overrides)
    return SttActivityGateSettings(**base)


async def drive_turns(
    *,
    turns: List[int],
    settings: SttActivityGateSettings,
    stt: Optional[FakeSTT] = None,
    clock: Optional[FakeClock] = None,
):
    """Feed `turns` bursts of frames, closing on idle between each."""

    stt = stt or FakeSTT()
    clock = clock or FakeClock()
    runner_holder: dict = {}
    events: List[Any] = []
    frame_index = 0

    async def audio() -> AsyncIterator[FakeFrame]:
        nonlocal frame_index
        for burst in turns:
            for _ in range(burst):
                yield FakeFrame(frame_index)
                frame_index += 1
                await asyncio.sleep(0)

            # Turn over: no more frames arrive, so the watchdog would close.
            runner = runner_holder["runner"]
            clock.now += settings.idle_close_seconds + 1
            await runner.close_if_idle()
            # Teardown is detached so it never sits on the turn-latency path;
            # wait for it here to keep per-turn assertions deterministic.
            await runner.drain_teardowns()

    runner = SttActivityGateRunner(
        audio=audio(),
        stt=stt,
        settings=settings,
        label="test",
        monotonic=clock,
    )
    runner_holder["runner"] = runner

    async for event in runner.run():
        events.append(event)

    return runner, stt, events


class SttActivityGateTests(unittest.IsolatedAsyncioTestCase):
    async def _drive(self, **kwargs):
        return await drive_turns(**kwargs)

    async def test_no_stream_without_audio(self) -> None:
        stt = FakeSTT()

        async def audio() -> AsyncIterator[FakeFrame]:
            return
            yield  # pragma: no cover - makes this an async generator

        runner = SttActivityGateRunner(
            audio=audio(),
            stt=stt,
            settings=make_settings(),
            label="test",
            monotonic=FakeClock(),
        )
        async for _ in runner.run():
            pass

        # A meeting where nobody ever pushes to talk costs zero inference
        # sessions instead of one held open for its full duration.
        self.assertEqual(stt.streams, [])
        self.assertEqual(runner.opens, 0)

    async def test_opens_on_first_frame_of_a_turn(self) -> None:
        runner, stt, _ = await self._drive(turns=[4], settings=make_settings())

        self.assertEqual(len(stt.streams), 1)
        self.assertEqual(runner.opens, 1)
        self.assertEqual([frame.index for frame in stt.streams[0].frames], [0, 1, 2, 3])

    async def test_first_frame_is_not_dropped_while_opening(self) -> None:
        _, stt, _ = await self._drive(turns=[1], settings=make_settings())

        # Opening is synchronous, so the frame that triggered it is still the
        # first frame the STT sees — no clipped first word.
        self.assertEqual([frame.index for frame in stt.streams[0].frames], [0])

    async def test_idle_closes_between_turns_and_reopens(self) -> None:
        runner, stt, _ = await self._drive(turns=[3, 3], settings=make_settings())

        self.assertEqual(runner.opens, 2)
        self.assertEqual(runner.closes, 2)
        self.assertEqual(len(stt.streams), 2)
        # Each turn's audio lands on its own stream, in order, nothing lost.
        self.assertEqual([frame.index for frame in stt.streams[0].frames], [0, 1, 2])
        self.assertEqual([frame.index for frame in stt.streams[1].frames], [3, 4, 5])
        self.assertTrue(all(stream.closed for stream in stt.streams))

    async def test_turn_final_transcript_survives_the_close(self) -> None:
        _, _, events = await self._drive(turns=[3], settings=make_settings())

        # end_input() -> drain -> aclose(), so the turn's last words are kept.
        self.assertIn("final", events)

    async def test_stream_stays_open_within_a_turn(self) -> None:
        clock = FakeClock()
        stt = FakeSTT()
        settings = make_settings(idle_close_seconds=5.0)

        async def audio() -> AsyncIterator[FakeFrame]:
            for index in range(6):
                yield FakeFrame(index)
                await asyncio.sleep(0)
                # Frames keep arriving inside the turn, so idle never trips.
                clock.now += 0.05
                await runner.close_if_idle()

        runner = SttActivityGateRunner(
            audio=audio(),
            stt=stt,
            settings=settings,
            label="test",
            monotonic=clock,
        )
        async for _ in runner.run():
            pass

        self.assertEqual(len(stt.streams), 1)
        self.assertEqual(runner.opens, 1)

    async def test_failed_stream_reopens_without_going_deaf(self) -> None:
        runner, stt, _ = await self._drive(
            turns=[3, 3],
            settings=make_settings(),
            stt=FakeSTT(fail_streams={0}),
        )

        # A blown stream costs the frames already in flight, not the rest of
        # the meeting: the next frame reopens, even mid-turn.
        self.assertGreater(len(stt.streams), 1)
        self.assertGreaterEqual(runner.opens, 2)
        self.assertEqual([frame.index for frame in stt.streams[-1].frames], [3, 4, 5])
        # Every frame after the failure still reached some live stream.
        delivered = sorted(
            frame.index for stream in stt.streams for frame in stream.frames
        )
        self.assertEqual(delivered, list(range(6)))


class SttActivityGateTeardownTests(unittest.IsolatedAsyncioTestCase):
    """Regressions for the lifecycle bugs found in review."""

    async def test_trailing_final_survives_shutdown_mid_turn(self) -> None:
        stt = FakeSTT()
        clock = FakeClock()
        events: List[Any] = []

        async def audio() -> AsyncIterator[FakeFrame]:
            # Audio ends while the turn is still live — no idle close first.
            for index in range(4):
                yield FakeFrame(index)
                await asyncio.sleep(0)

        runner = SttActivityGateRunner(
            audio=audio(),
            stt=stt,
            settings=make_settings(),
            label="test",
            monotonic=clock,
        )
        async for event in runner.run():
            events.append(event)

        # The sentinel must be queued after the drain, or the turn's last words
        # land behind it and never reach the transcript.
        self.assertIn("final", events)
        self.assertTrue(stt.streams[0].closed)

    async def test_new_turn_is_not_blocked_by_an_in_flight_drain(self) -> None:
        stt = FakeSTT(block_drain_streams={0})
        clock = FakeClock()
        runner_holder: dict = {}

        async def audio() -> AsyncIterator[FakeFrame]:
            runner = runner_holder["runner"]
            yield FakeFrame(0)
            await asyncio.sleep(0)

            # Turn one ends; its drain will hang on the provider.
            clock.now += make_settings().idle_close_seconds + 1
            await runner.close_if_idle()
            await asyncio.sleep(0)

            # close_if_idle() must have returned without waiting for the drain.
            # The old lock-holding close path only returned once the drain had
            # finished or timed out, so the stream would already be closed.
            assert not stt.streams[0].closed, (
                "close_if_idle blocked until the drain completed"
            )

            # Turn two starts while that drain is still in flight.
            yield FakeFrame(1)
            await asyncio.sleep(0)

            # A second stream must already exist: the close path must not sit
            # on the push-to-talk latency budget.
            assert len(stt.streams) == 2, (
                f"new turn blocked behind drain; streams={len(stt.streams)}"
            )
            stt.streams[0].release_drain()

        runner = SttActivityGateRunner(
            audio=audio(),
            stt=stt,
            settings=make_settings(),
            label="test",
            monotonic=clock,
        )
        runner_holder["runner"] = runner

        async for _ in runner.run():
            pass

        self.assertEqual(len(stt.streams), 2)
        self.assertEqual([frame.index for frame in stt.streams[1].frames], [1])
        self.assertTrue(all(stream.closed for stream in stt.streams))

    async def test_failed_stream_is_closed_not_just_forgotten(self) -> None:
        _, stt, _ = await SttActivityGateTests()._drive(
            turns=[3, 3],
            settings=make_settings(),
            stt=FakeSTT(fail_streams={0}),
        )

        # The dead stream's provider session must actually be closed rather
        # than left alive while a replacement opens alongside it.
        self.assertTrue(all(stream.closed for stream in stt.streams))


class SttActivityGateRaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_frame_is_lost_when_teardown_races_every_frame(self) -> None:
        """The watchdog and the pump contend for the same record.

        The idle window is shorter than the inter-frame gap and the watchdog
        polls far faster than frames arrive, so an idle teardown is racing the
        next frame continuously — every frame arrives to find its predecessor's
        stream being closed. If teardown could win that race against an
        in-flight push, the first frame of a turn would be pushed into a
        closing stream and lost.
        """

        stt = FakeSTT()
        total = 150
        settings = SttActivityGateSettings(
            enabled=True,
            idle_close_seconds=0.0005,
            poll_interval_seconds=0.0001,
        )

        async def audio() -> AsyncIterator[FakeFrame]:
            for index in range(total):
                yield FakeFrame(index)
                # Gap deliberately exceeds the idle window.
                await asyncio.sleep(0.001)

        runner = SttActivityGateRunner(
            audio=audio(),
            stt=stt,
            settings=settings,
            label="race",
        )
        async for _ in runner.run():
            pass

        delivered = sorted(
            frame.index for stream in stt.streams for frame in stream.frames
        )
        self.assertEqual(delivered, list(range(total)))
        # Confirm the race was actually exercised rather than the churn being
        # optimised away: near-total open/close cycling.
        self.assertGreater(runner.opens, total // 2)
        self.assertTrue(all(stream.closed for stream in stt.streams))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class SttActivityGateSeventhRoundTests(unittest.IsolatedAsyncioTestCase):
    async def test_clean_stream_eof_reopens_for_the_next_frames(self) -> None:
        """A provider EOF must not leave a dead stream published.

        Only exceptions triggered teardown; a clean EOF left `_open` pointing
        at the dead stream, so `_ensure_stream_open()` refused to reopen and
        the next turn pushed into a corpse. This is the meeting-agent port of
        the realtime clean-EOF fix from an earlier round.
        """

        stt = FakeSTT()
        clock = FakeClock()
        ended = False

        async def audio() -> AsyncIterator[FakeFrame]:
            nonlocal ended
            for index in range(12):
                yield FakeFrame(index)
                await asyncio.sleep(0)
                await asyncio.sleep(0)
                if not ended and index == 4:
                    # Provider closes the stream mid-turn, cleanly.
                    ended = True
                    stt.streams[0].end_cleanly()
                    for _ in range(6):
                        await asyncio.sleep(0)

        runner = SttActivityGateRunner(
            audio=audio(),
            stt=stt,
            settings=make_settings(),
            label="clean-eof",
            monotonic=clock,
        )
        async for _ in runner.run():
            pass

        # A replacement stream must exist and carry the post-EOF audio.
        self.assertGreaterEqual(len(stt.streams), 2)
        tail = [frame.index for frame in stt.streams[-1].frames]
        self.assertIn(11, tail)
        self.assertTrue(all(stream.closed for stream in stt.streams))

    async def test_previous_turn_final_lands_before_next_turn_events(self) -> None:
        """A draining stream's trailing final must not reorder behind turn 2.

        `_begin_teardown()` detaches `_open` before the graceful drain
        finishes, so a new turn could open a replacement while the old
        forwarder was still emitting its trailing final into the same output
        queue — turn 1's last words arriving after turn 2's events.
        """

        stt = FakeSTT(block_drain_streams={0})
        clock = FakeClock()
        events: List[Any] = []
        runner_holder: dict = {}

        async def audio() -> AsyncIterator[FakeFrame]:
            runner = runner_holder["runner"]
            # Turn 1.
            yield FakeFrame(0)
            await asyncio.sleep(0)

            # Turn 1 idles; its graceful drain hangs on the provider.
            clock.now += make_settings().idle_close_seconds + 1
            await runner.close_if_idle()
            await asyncio.sleep(0)

            # Turn 2 starts while the drain is still in flight.
            yield FakeFrame(1)
            await asyncio.sleep(0)
            assert len(stt.streams) == 2, "turn 2 should have its own stream"

            # Turn 2 produces an event while turn 1 is still draining.
            stt.streams[1].emit("turn2-interim")
            for _ in range(6):
                await asyncio.sleep(0)

            # Provider finally finishes turn 1's drain.
            stt.streams[0].release_drain()
            for _ in range(6):
                await asyncio.sleep(0)

        runner = SttActivityGateRunner(
            audio=audio(),
            stt=stt,
            settings=make_settings(),
            label="turn-order",
            monotonic=clock,
        )
        runner_holder["runner"] = runner
        async for event in runner.run():
            events.append(event)

        self.assertIn("final", events)
        self.assertIn("turn2-interim", events)
        # Turn 1's trailing final must precede anything from turn 2.
        self.assertLess(events.index("final"), events.index("turn2-interim"))
