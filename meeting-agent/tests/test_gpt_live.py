from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from meeting_agent.gpt_live import build_voice_instructions, is_live_agent, speak_live_text, summarize_usage


class GPTLiveTests(unittest.TestCase):
    def test_detects_livekit_duplex_adapter(self):
        from livekit.agents import Agent
        from livekit.plugins.openai.realtime import GPTLiveModel
        agent = Agent(instructions="test", llm=GPTLiveModel(api_key="test"))
        self.assertTrue(is_live_agent(agent))
        self.assertFalse(is_live_agent(SimpleNamespace()))

    def test_voice_prompt_routes_actions_and_preserves_owner_identity(self):
        prompt = build_voice_instructions("Papia's agent", "Papia")
        self.assertIn("Papia's agent", prompt)
        self.assertIn("Delegate", prompt)
        self.assertIn("confirmed success", prompt)
        self.assertIn("summarize the meeting so far", prompt)
        self.assertIn("before saying", prompt)
        self.assertIn("Do not answer other participants' questions", prompt)
        self.assertIn("Respond only to the activating user's live audio", prompt)
        self.assertIn("not a user turn", prompt)

    def test_speech_uses_live_reply_and_surfaces_declined_generation(self):
        class Handle:
            def __await__(self):
                return asyncio.sleep(0).__await__()

            def exception(self):
                return RuntimeError("voice declined")

        session = SimpleNamespace(generate_reply=lambda **kwargs: Handle(), say=AsyncMock())
        with self.assertRaisesRegex(RuntimeError, "voice declined"):
            asyncio.run(speak_live_text(session, "Welcome to Ready"))
        session.say.assert_not_called()

    def test_usage_keeps_duration_separate_from_backend_tokens(self):
        event = SimpleNamespace(type="llm_usage", session_duration=12.5,
                                model="gpt-live-1", input_tokens=0, output_tokens=0)
        self.assertEqual(summarize_usage(event)["sessionSeconds"], 12.5)
        backend = SimpleNamespace(type="llm_usage", model="gpt-5.6-luna",
                                  input_tokens=100, output_tokens=20)
        result = summarize_usage(backend)
        self.assertEqual(result["inputTokens"], 100)
        self.assertEqual(result["outputTokens"], 20)
        self.assertEqual(result["sessionSeconds"], 0)
