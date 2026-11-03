from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from livekit.agents.llm import ChatContext
from livekit.plugins import openai as livekit_openai

from credit_usage_fakes import ProviderOnlyCreditUsage
from meeting_agent.prompt_cache import UncachedResponsesLLM, openai_prompt_cache_options
from meeting_agent.summary import SummaryGenerationInput, generate_summary_and_action_items


class PromptCacheTests(unittest.IsolatedAsyncioTestCase):
    def test_model_compatibility(self):
        for model in ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-luna-2026-09-01", "gpt-5.10", "gpt-6-astra"]:
            self.assertEqual(openai_prompt_cache_options(model), {"prompt_cache_options": {"mode": "explicit"}})
        for model in ["gpt-4.1", "gpt-5", "gpt-5.4-mini", "gpt-5.5", "gpt-live-1", "gpt-realtime", "o3"]:
            self.assertEqual(openai_prompt_cache_options(model), {})

    async def test_streaming_turns_apply_policy_and_preserve_other_options(self):
        for websocket in [True, False]:
            model = UncachedResponsesLLM(model="gpt-5.6-luna", api_key="fixture", use_websocket=websocket)
            try:
                with patch.object(livekit_openai.responses.LLM, "chat") as chat:
                    for _ in range(2):  # Include the next tool/response turn.
                        model.chat(chat_ctx=ChatContext.empty(), extra_kwargs={"max_output_tokens": 500})
                        extra = chat.call_args.kwargs["extra_kwargs"]
                        self.assertEqual(extra["max_output_tokens"], 500)
                        policy = extra if websocket else extra["extra_body"]
                        self.assertEqual(policy["prompt_cache_options"], {"mode": "explicit"})
            finally:
                await model.aclose()

    async def test_legacy_streaming_request_has_no_unsupported_control(self):
        model = UncachedResponsesLLM(model="gpt-5.4-mini", api_key="fixture")
        try:
            with patch.object(livekit_openai.responses.LLM, "chat") as chat:
                model.chat(chat_ctx=ChatContext.empty())
                self.assertEqual(chat.call_args.kwargs["extra_kwargs"], {})
        finally:
            await model.aclose()

    async def test_summary_sends_cache_policy(self):
        client = SimpleNamespace(
            responses=SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(output_parsed={"summary": "Reviewed launch timing.", "actionItems": []}))),
            close=AsyncMock(),
        )
        with patch("meeting_agent.summary.openai.AsyncClient", return_value=client):
            result = await generate_summary_and_action_items(SummaryGenerationInput(
                meeting_id="fixture", model="gpt-5.6-sol", api_key="fixture", timeout_ms=1000,
                transcript=[
                    {"speakerName": "Personbr", "content": "The launch is planned for Friday after we finish the review."},
                    {"speakerName": "Personah", "content": "I agree with that schedule and will prepare the release notes."},
                ],
            ), credit_usage=ProviderOnlyCreditUsage())
        self.assertEqual(result.mode, "model")
        self.assertEqual(client.responses.create.call_args.kwargs["extra_body"], {"prompt_cache_options": {"mode": "explicit"}})
