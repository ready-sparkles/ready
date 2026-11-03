from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

os.environ.setdefault("DATABASE_URL", "postgresql://readymeet.test/readymeet")
os.environ.setdefault("LIVEKIT_URL", "wss://example.livekit.cloud")
os.environ.setdefault("LIVEKIT_API_KEY", "test-key")
os.environ.setdefault("LIVEKIT_API_SECRET", "test-secret")
os.environ.setdefault("OPENAI_API_KEY", "test-openai-key")
os.environ.setdefault("ELEVEN_API_KEY", "test-eleven-key")
os.environ.setdefault("ASSISTANT_SERVICE_SECRET", "test-assistant-secret")

from meeting_agent.worker import link_room_participant, linked_room_participant  # noqa: E402


class _SessionWithoutRoom:
    @property
    def room_io(self):
        raise RuntimeError("Cannot access room_io: the AgentSession was not started with a room.")


class LinkedRoomParticipantTest(unittest.TestCase):
    def test_none_while_session_has_no_room_io(self) -> None:
        self.assertIsNone(linked_room_participant(None))
        self.assertIsNone(linked_room_participant(_SessionWithoutRoom()))

    def test_returns_linked_participant(self) -> None:
        participant = SimpleNamespace(identity="user-1")
        session = SimpleNamespace(room_io=SimpleNamespace(linked_participant=participant))
        self.assertIs(linked_room_participant(session), participant)

    def test_link_skips_session_without_room_io(self) -> None:
        self.assertFalse(link_room_participant(_SessionWithoutRoom(), "user-1"))

    def test_link_sets_participant(self) -> None:
        calls = []
        session = SimpleNamespace(room_io=SimpleNamespace(set_participant=calls.append))
        self.assertTrue(link_room_participant(session, "user-1"))
        self.assertEqual(calls, ["user-1"])


if __name__ == "__main__":
    unittest.main()
