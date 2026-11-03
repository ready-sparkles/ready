from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, Mock


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from livekit.agents.types import (  # noqa: E402
    ATTRIBUTE_TRANSCRIPTION_FINAL,
    ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID,
    ATTRIBUTE_TRANSCRIPTION_TRACK_ID,
    TOPIC_TRANSCRIPTION,
)

from app.caption_publisher import (  # noqa: E402
    ATTRIBUTE_CAPTION_SOURCE,
    CAPTION_SOURCE_SCRIBE,
    CaptionPublisher,
)


class CaptionPublisherTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_final_uses_livekit_transcription_text_stream_contract(self) -> None:
        writer = SimpleNamespace(write=AsyncMock(), aclose=AsyncMock())
        local_participant = SimpleNamespace(
            stream_text=AsyncMock(return_value=writer)
        )
        room = SimpleNamespace(
            isconnected=lambda: True,
            local_participant=local_participant,
        )
        metrics = Mock()
        publisher = CaptionPublisher(
            room_provider=lambda: room,
            sender_identity="human-1",
            metrics=metrics,
            log_context={"meetingId": "meeting-1"},
        )

        publisher.enqueue(
            "Hello from LiveKit",
            is_final=True,
            track_sid="TR_microphone",
        )
        await publisher.aclose(drain=True)

        writer.write.assert_awaited_once_with("Hello from LiveKit")
        writer.aclose.assert_awaited_once()
        stream_kwargs = local_participant.stream_text.await_args.kwargs
        self.assertEqual(stream_kwargs["topic"], TOPIC_TRANSCRIPTION)
        self.assertEqual(stream_kwargs["sender_identity"], "human-1")
        self.assertEqual(
            stream_kwargs["attributes"],
            {
                ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID: ANY,
                ATTRIBUTE_TRANSCRIPTION_FINAL: "true",
                ATTRIBUTE_TRANSCRIPTION_TRACK_ID: "TR_microphone",
                ATTRIBUTE_CAPTION_SOURCE: CAPTION_SOURCE_SCRIBE,
            },
        )
        metrics.record_caption_publish.assert_called_once_with(outcome="success")
        metrics.record_caption_pending_finals.assert_called_once_with(1)

    async def test_segment_ids_follow_event_order_across_coalesced_interims_and_finals(self) -> None:
        writers = [SimpleNamespace(write=AsyncMock(), aclose=AsyncMock()) for _ in range(4)]
        stream_text = AsyncMock(side_effect=writers)
        room = SimpleNamespace(
            isconnected=lambda: True,
            local_participant=SimpleNamespace(stream_text=stream_text),
        )
        metrics = Mock()
        publisher = CaptionPublisher(
            room_provider=lambda: room,
            sender_identity="human-1",
            metrics=metrics,
        )

        publisher.enqueue("obsolete", is_final=False, track_sid=None)
        publisher.enqueue("interim A", is_final=False, track_sid=None)
        publisher.enqueue("final A", is_final=True, track_sid=None)
        publisher.enqueue("interim B", is_final=False, track_sid=None)
        publisher.enqueue("final B", is_final=True, track_sid=None)
        await publisher.aclose(drain=True)

        ids = [
            call.kwargs["attributes"][ATTRIBUTE_TRANSCRIPTION_SEGMENT_ID]
            for call in stream_text.await_args_list
        ]
        self.assertEqual(ids[0], ids[1])
        self.assertEqual(ids[2], ids[3])
        self.assertNotEqual(ids[0], ids[2])
        self.assertTrue(all(segment_id.startswith("SG_") for segment_id in ids))
        for writer, text in zip(writers, ["interim A", "final A", "interim B", "final B"]):
            writer.write.assert_awaited_once_with(text)
            writer.aclose.assert_awaited_once()
        metrics.record_caption_interim_coalesced.assert_called_once_with()

    async def test_close_failure_records_failure_after_successful_write(self) -> None:
        writer = SimpleNamespace(
            write=AsyncMock(),
            aclose=AsyncMock(side_effect=RuntimeError("trailer rejected")),
        )
        room = SimpleNamespace(
            isconnected=lambda: True,
            local_participant=SimpleNamespace(
                stream_text=AsyncMock(return_value=writer)
            ),
        )
        metrics = Mock()
        publisher = CaptionPublisher(
            room_provider=lambda: room,
            sender_identity="human-1",
            metrics=metrics,
        )

        publisher.enqueue(
            "Written, but not closed",
            is_final=True,
            track_sid="TR_microphone",
        )
        await publisher.aclose(drain=True)

        writer.write.assert_awaited_once_with("Written, but not closed")
        writer.aclose.assert_awaited_once()
        metrics.record_caption_publish.assert_called_once_with(
            outcome="close_failed"
        )


if __name__ == "__main__":
    unittest.main()

class CaptionCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_close_joins_worker_and_drains_queued_captions(self):
        publisher = CaptionPublisher(room_provider=Mock(), sender_identity='human', metrics=Mock())
        started, release = asyncio.Event(), asyncio.Event()
        published = []
        async def publish(text, **kwargs):
            started.set()
            await release.wait()
            published.append(text)
            return 'success'
        publisher._publish_caption = publish
        publisher.enqueue('first', is_final=True, track_sid=None)
        publisher.enqueue('second', is_final=True, track_sid=None)
        await started.wait()
        worker = publisher.worker_task
        closing = asyncio.create_task(publisher.aclose(drain=True))
        await asyncio.sleep(0)
        closing.cancel()
        await asyncio.sleep(0)
        closing.cancel()  # A second cancellation cannot interrupt the finalizer.
        concurrent = asyncio.create_task(publisher.aclose(drain=True))
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(closing, 0.5)
        await asyncio.wait_for(concurrent, 0.5)
        self.assertTrue(worker.done())
        self.assertIsNone(publisher.worker_task)
        self.assertEqual(publisher.pending_count, 0)
        self.assertEqual(published, ['first', 'second'])
