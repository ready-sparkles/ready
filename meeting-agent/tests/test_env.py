from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from meeting_agent.env import load_settings  # noqa: E402


BASE_ENV = {
    "DATABASE_URL": "postgresql://readymeet.test/readymeet",
    "ASSISTANT_SERVICE_SECRET": "test-assistant-secret",
    "LIVEKIT_URL": "wss://example.livekit.cloud",
    "LIVEKIT_API_KEY": "test-livekit-key",
    "LIVEKIT_API_SECRET": "test-livekit-secret",
    "OPENAI_API_KEY": "test-openai-key",
}


class MeetingAgentEnvironmentTests(unittest.TestCase):
    def test_voice_defaults_to_gpt_live_with_separate_backend(self) -> None:
        with patch.dict(os.environ, {**BASE_ENV, "ELEVEN_API_KEY": "test"}, clear=True):
            settings = load_settings()
        self.assertEqual(settings.openai_meeting_assistant_realtime_model, "gpt-live-1")
        self.assertEqual(settings.openai_meeting_assistant_live_backend_model, "gpt-5.6-luna")

    def test_legacy_inference_model_is_normalized_for_elevenlabs_plugin(self) -> None:
        with patch.dict(
            os.environ,
            {
                **BASE_ENV,
                "ELEVEN_API_KEY": "test-eleven-key",
                "MEETING_ASSISTANT_STT_MODEL": "elevenlabs/scribe_v2_realtime",
            },
            clear=True,
        ):
            settings = load_settings()

        self.assertEqual(settings.meeting_assistant_stt_model, "scribe_v2_realtime")
        self.assertEqual(settings.eleven_api_key, "test-eleven-key")
        self.assertNotIn("test-eleven-key", repr(settings))

    def test_unsupported_plugin_model_is_rejected_at_startup(self) -> None:
        with patch.dict(
            os.environ,
            {
                **BASE_ENV,
                "ELEVEN_API_KEY": "test-eleven-key",
                "MEETING_ASSISTANT_STT_MODEL": "deepgram/nova-3:multi",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "MEETING_ASSISTANT_STT_MODEL"):
                load_settings()

    def test_missing_elevenlabs_key_fails_at_startup(self) -> None:
        with patch.dict(os.environ, BASE_ENV, clear=True):
            with self.assertRaisesRegex(RuntimeError, "ELEVEN_API_KEY"):
                load_settings()


if __name__ == "__main__":
    unittest.main()
