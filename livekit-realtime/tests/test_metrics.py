from __future__ import annotations

import sys
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.metrics import RealtimeMetrics  # noqa: E402


class RealtimeMetricsTestCase(unittest.TestCase):
    def test_render_prometheus_includes_counters_and_gauges(self) -> None:
        metrics = RealtimeMetrics()
        metrics.record_service_ready(True)
        metrics.record_active_sessions(2)
        metrics.record_start_request("started")
        metrics.record_stop_request("stopped")
        metrics.record_session_started()
        metrics.record_track_worker_started()
        metrics.record_track_worker_stopped()
        metrics.record_assistant_callback(event_type="live_transcript", outcome="success")
        metrics.record_participant_suppression_update(suppressed=True, updated=False)
        metrics.record_caption_publish(outcome="timeout")
        metrics.record_caption_interim_coalesced()
        metrics.record_caption_pending_finals(2)
        metrics.record_caption_pending_finals(1)

        rendered = metrics.render_prometheus()

        self.assertIn("readymeet_livekit_realtime_service_ready 1", rendered)
        self.assertIn("readymeet_livekit_realtime_active_sessions 2", rendered)
        self.assertIn(
            'readymeet_livekit_realtime_start_requests_total{outcome="started"} 1',
            rendered,
        )
        self.assertIn(
            'readymeet_livekit_realtime_assistant_callbacks_total{event_type="live_transcript",outcome="success"} 1',
            rendered,
        )
        self.assertIn(
            'readymeet_livekit_realtime_participant_suppression_total{suppressed="true",updated="false"} 1',
            rendered,
        )
        self.assertIn(
            'readymeet_livekit_realtime_caption_publish_total{outcome="timeout"} 1',
            rendered,
        )
        self.assertIn(
            "readymeet_livekit_realtime_caption_interims_coalesced_total 1",
            rendered,
        )
        self.assertNotIn("caption_direct_fallback", rendered)
        self.assertIn(
            "readymeet_livekit_realtime_caption_pending_finals_peak 2",
            rendered,
        )


if __name__ == "__main__":
    unittest.main()
