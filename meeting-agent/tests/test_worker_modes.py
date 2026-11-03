from __future__ import annotations

import os
import json
import logging
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from dataclasses import replace
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID
import asyncio
import ast
import inspect
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch


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

from credit_usage_fakes import ProviderOnlyCreditUsage
import meeting_agent.worker as worker
from livekit import rtc
from livekit.agents.llm import ChatContext, StopResponse

from meeting_agent.env import DEFAULT_MEETING_ASSISTANT_STT_MODEL
from meeting_agent.worker import (
    ASSISTANT_MODE_GROUP,
    ASSISTANT_MODE_IDLE,
    ASSISTANT_MODE_SOLO,
    ActiveTurnLease,
    MeetingTools,
    PUSH_TO_TALK_STT_FLUSH_DURATION_S,
    SOLO_RESPONSE_MODE_PIPELINE,
    SOLO_RESPONSE_MODE_REALTIME,
    SOLO_ENDPOINTING_MIN_DELAY_S,
    ToolExecutionContext,
    TurnOwnerContext,
    TurnCapabilityContext,
    WebSearchResearchTools,
    AGENT_HELP_DEEP_PROMPT,
    AGENT_HELP_EMPTY_TRANSCRIPT_TEXT,
    AGENT_HELP_SCREEN_SHARE_CONTEXT_NOTE,
    AGENT_HELP_WEB_SEARCH_GUIDANCE,
    SOLO_SCREEN_SHARE_SNAPSHOT_MESSAGE,
    AGENT_HELP_WEB_SEARCH_TOOL_DEFINITION,
    capture_screen_share_image_data_url,
    persist_contextual_screen_capture,
    find_active_screen_share_publication,
    select_contextual_visual_evidence_segment,
    should_capture_visual_evidence,
    visual_evidence_context_segments,
    build_agent_intro_opening_instructions,
    build_agent_intro_opening_script,
    build_agent_server,
    build_agent_help_context_pack,
    build_agent_help_messages,
    build_meeting_assistant_agent,
    build_meeting_assistant_realtime_model,
    build_room_options_for_mode,
    build_runtime_fingerprint,
    build_turn_handling_for_mode,
    build_livekit_recent_context_hint,
    build_railway_log_handlers,
    build_meeting_assistant_instructions,
    build_meeting_assistant_stt,
    build_meeting_assistant_tools,
    build_turn_response_style_hint,
    collect_livekit_chat_history_messages,
    compact_web_search_panel_payload,
    connected_provider_names,
    expire_active_turn_lease,
    format_personal_assistant_display_name,
    generate_agent_help_participation,
    is_current_agent_help_request,
    is_turn_owner_connection_current,
    is_agent_intro_opening_pending,
    is_phantom_user_turn,
    is_web_search_allowed_for_mode,
    persist_assistant_transcript_segment,
    persist_human_transcript_segment_from_session,
    publish_assistant_presence,
    resolve_live_assistant_display_name,
    select_assistant_mode,
    session_close_transcript_timeout_for_mode,
    set_assistant_presence,
    show_web_search_panel_for_meeting,
    select_active_transcript_turn,
    should_persist_session_user_transcript,
    should_stop_on_empty_user_turn,
    start_agent_intro_opening,
)


DEFAULT_TEST_STT_MODEL = "scribe_v2_realtime"


class GPTLiveWorkerTests(unittest.TestCase):
    def test_live_factory_uses_duplex_api_and_separate_backend(self):
        settings = replace(worker.SETTINGS, openai_meeting_assistant_realtime_model="gpt-live-1")
        with patch.object(worker, "SETTINGS", settings):
            model = build_meeting_assistant_realtime_model("Keep the original tool permissions.")
            self.assertIsInstance(model, worker.livekit_openai.realtime.GPTLiveModel)
            self.assertEqual(model._opts.responses["instructions"], "Keep the original tool permissions.")
            self.assertEqual(model._opts.responses["model"], settings.openai_meeting_assistant_live_backend_model)
            self.assertEqual(build_turn_handling_for_mode(ASSISTANT_MODE_SOLO)["turn_detection"], "realtime_llm")
            self.assertEqual(build_turn_handling_for_mode(ASSISTANT_MODE_GROUP)["turn_detection"], "manual")
            self.assertFalse(should_persist_session_user_transcript(ASSISTANT_MODE_SOLO))
            fingerprint = build_runtime_fingerprint(ASSISTANT_MODE_SOLO)
            self.assertEqual(fingerprint["turnDetection"], "gpt-live-full-duplex")
            self.assertEqual(fingerprint["assistantBackendModel"], settings.openai_meeting_assistant_live_backend_model)

    def test_live_agent_splits_voice_persona_and_backend_business_instructions(self):
        settings = replace(worker.SETTINGS, openai_meeting_assistant_realtime_model="gpt-live-1")
        with patch.object(worker, "SETTINGS", settings):
            agent = build_meeting_assistant_agent(
                "meeting-test", lambda: None, participant_names=["Papia"],
                assistant_mode=ASSISTANT_MODE_SOLO,
                personal_system_prompt="Prefer short replies about design.",
            )
        self.assertTrue(worker.is_live_agent(agent))
        self.assertIn("Delegate", agent.instructions)
        self.assertIn("Prefer short replies about design.", agent.llm.duplex_model._opts.responses["instructions"])


class SoloSessionStartupTests(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.turn = ActiveTurnLease(
            meeting_turn_id="turn-1", agent_profile_id="profile-1",
            owner_context=TurnOwnerContext("participant-1", "user-1", "Papia", "Papia's agent"),
            voice_id="marin", started_at=datetime.now(timezone.utc),
        )
        self.state = {"turn": self.turn, "prompt": "Prefer concise design advice."}
        self.capabilities = TurnCapabilityContext(
            active_turn=self.turn, memories=[],
            connectors=[{"provider": "linear"}], tool_policies=[],
        )
        self.catalog = [{
            "name": "list_issue_statuses", "description": "List issue workflow states.",
            "inputSchema": {"type": "object", "properties": {}},
        }]
        self.catalog_loader = AsyncMock(return_value=self.catalog)

    async def test_broker_context_and_catalog_capture_exact_turn_and_connection(self):
        context = worker.make_tool_execution_context(meeting_id="meeting-1", active_turn=self.turn)
        # A later turn for the same user must not mutate already captured context.
        next_turn = replace(self.turn, meeting_turn_id="turn-2",
                            owner_context=replace(self.turn.owner_context, participant_identity="participant-2"))
        self.assertEqual(context.to_api_context()["meetingTurnId"], "turn-1")
        self.assertEqual(context.to_api_context()["participantIdentity"], "participant-1")
        next_context = worker.make_tool_execution_context(meeting_id="meeting-1", active_turn=next_turn)
        self.assertEqual(next_context.to_api_context()["meetingTurnId"], "turn-2")
        self.assertEqual(next_context.to_api_context()["participantIdentity"], "participant-2")
        with patch.dict(worker._LINEAR_MCP_CATALOG_CACHE, {}, clear=True), patch.object(
            worker, "call_agent_tool_broker", new=AsyncMock(return_value={"tools": []})
        ) as broker:
            await worker.fetch_linear_mcp_tool_catalog(worker.SETTINGS, "meeting-1", "user-1", active_turn=self.turn)
            sent_context = broker.await_args.args[2]["context"]
            self.assertEqual(sent_context["meetingTurnId"], "turn-1")
            self.assertEqual(sent_context["participantIdentity"], "participant-1")

    async def prepare(self, loader, model="gpt-live-1", response_mode=SOLO_RESPONSE_MODE_REALTIME):
        settings = replace(worker.SETTINGS, openai_meeting_assistant_realtime_model=model)
        with patch.object(worker, "SETTINGS", settings), patch.object(
            worker, "get_assistant_response_mode_for_mode", return_value=response_mode
        ):
            return await worker.prepare_solo_session_startup(
                "participant-1", mode=ASSISTANT_MODE_SOLO,
                get_turn=lambda: self.state["turn"],
                get_personal_prompt=lambda: self.state["prompt"],
                load_capabilities=loader,
                load_linear_mcp_tools=self.catalog_loader,
            )

    async def test_realtime_rollback_starts_with_unavailable_capabilities(self):
        loader = AsyncMock(side_effect=RuntimeError("capability backend unavailable"))
        startup = await self.prepare(loader, model="gpt-realtime")
        loader.assert_not_called()
        self.catalog_loader.assert_not_called()
        self.assertIs(startup.turn, self.turn)
        self.assertEqual(startup.personal_system_prompt, self.state["prompt"])
        self.assertIsNone(startup.capabilities)
        self.assertEqual(connected_provider_names(startup.capabilities), [])

    async def test_pipeline_starts_with_unavailable_capabilities_even_with_live_model_configured(self):
        loader = AsyncMock(side_effect=RuntimeError("capability backend unavailable"))
        startup = await self.prepare(
            loader, response_mode=SOLO_RESPONSE_MODE_PIPELINE
        )
        loader.assert_not_called()
        self.catalog_loader.assert_not_called()
        self.assertIs(startup.turn, self.turn)
        self.assertIsNone(startup.capabilities)
        self.assertEqual(connected_provider_names(startup.capabilities), [])

    async def test_missing_bootstrap_blocks_start_until_context_is_ready(self):
        self.state["turn"] = None
        loader = AsyncMock(return_value=self.capabilities)
        with self.assertRaisesRegex(RuntimeError, "matching active meeting turn"):
            await self.prepare(loader)
        loader.assert_not_awaited()
        self.state["turn"] = self.turn
        startup = await self.prepare(loader)
        self.assertIs(startup.turn, self.turn)
        self.assertEqual(startup.personal_system_prompt, self.state["prompt"])
        settings = replace(worker.SETTINGS, openai_meeting_assistant_realtime_model="gpt-live-1")
        with patch.object(worker, "SETTINGS", settings):
            agent = build_meeting_assistant_agent(
                "meeting-1", loader, participant_names=["Papia"],
                owner_context=startup.turn.owner_context,
                personal_system_prompt=startup.personal_system_prompt,
                connected_providers=connected_provider_names(startup.capabilities),
                assistant_mode=ASSISTANT_MODE_SOLO,
            )
        self.assertIn("Papia's agent", agent.instructions)
        backend = agent.llm.duplex_model._opts.responses["instructions"]
        self.assertIn(self.state["prompt"], backend)
        self.assertIn("Linear", backend)

    async def test_rejects_mismatched_owner_before_loading(self):
        self.turn.owner_context.participant_identity = "someone-else"
        loader = AsyncMock()
        with self.assertRaisesRegex(RuntimeError, "matching active meeting turn"):
            await self.prepare(loader)
        loader.assert_not_awaited()

    async def test_turn_or_prompt_changes_during_loading_abort_start(self):
        for field, value in [("turn", None), ("turn", replace(self.turn)), ("prompt", "New persona")]:
            self.state = {"turn": self.turn, "prompt": "Original persona"}
            async def load():
                self.state[field] = value
                return self.capabilities
            with self.assertRaisesRegex(RuntimeError, "changed during startup"):
                await self.prepare(load)

    async def test_missing_or_wrong_capabilities_abort_start(self):
        for context in [None, replace(self.capabilities, active_turn=replace(self.turn))]:
            with self.assertRaisesRegex(RuntimeError, "matching capability context"):
                await self.prepare(AsyncMock(return_value=context))


    async def test_disconnected_linear_skips_catalog_loading(self):
        startup = await self.prepare(AsyncMock(return_value=self.capabilities))
        self.catalog_loader.assert_not_called()
        self.assertIsNone(startup.linear_mcp_tools)

    async def test_owner_change_during_catalog_loading_aborts_start(self):
        self.capabilities.connectors = [{"provider": "linear", "status": "connected"}]

        async def load_catalog(turn):
            self.assertIs(turn, self.turn)
            self.state["prompt"] = "Changed persona"
            return self.catalog

        self.catalog_loader.side_effect = load_catalog
        with self.assertRaisesRegex(RuntimeError, "changed during startup"):
            await self.prepare(AsyncMock(return_value=self.capabilities))













class MeetingAgentLoggingTests(unittest.TestCase):
    def test_debug_logging_discards_content_and_never_writes_a_file(self) -> None:
        sentinel = "private meeting transcript and search query"
        with tempfile.TemporaryDirectory() as directory:
            debug_path = Path(directory) / "debug.log"
            settings = replace(worker.SETTINGS, debug_log_path=str(debug_path))
            with patch.object(worker, "SETTINGS", settings), patch.object(worker.LOGGER, "info") as log:
                asyncio.run(worker.log_assistant_debug("user-input-transcribed", {"transcript": sentinel}))

            self.assertEqual(log.call_count, 1)
            self.assertNotIn(sentinel, str(log.call_args))
            self.assertFalse(debug_path.exists())

    def test_railway_handlers_keep_info_on_stdout_and_warnings_on_stderr(self) -> None:
        stdout = StringIO()
        stderr = StringIO()
        logger = logging.getLogger("readymeet.meeting_agent.logging-test")
        original_handlers = list(logger.handlers)
        original_level = logger.level
        original_propagate = logger.propagate

        try:
            logger.handlers = build_railway_log_handlers(stdout=stdout, stderr=stderr)
            logger.setLevel(logging.INFO)
            logger.propagate = False

            logger.info("healthy-session")
            logger.warning("degraded-session")

            for handler in logger.handlers:
                handler.flush()

            self.assertIn("healthy-session", stdout.getvalue())
            self.assertNotIn("degraded-session", stdout.getvalue())
            self.assertIn("degraded-session", stderr.getvalue())
            self.assertNotIn("healthy-session", stderr.getvalue())
        finally:
            logger.handlers = original_handlers
            logger.setLevel(original_level)
            logger.propagate = original_propagate


class MeetingAgentSttConfigTests(unittest.TestCase):
    def test_default_stt_model_is_scribe_v2_realtime(self) -> None:
        self.assertEqual(DEFAULT_MEETING_ASSISTANT_STT_MODEL, DEFAULT_TEST_STT_MODEL)


class FakeChatContext:
    def __init__(self, *messages: object) -> None:
        self.items = list(messages)

    def messages(self) -> list[object]:
        return [
            item
            for item in self.items
            if getattr(item, "type", None) == "message"
        ]


def make_message(role: str, text: str, message_id: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=message_id,
        type="message",
        role=role,
        text_content=text,
    )


def make_agent_help_requester() -> TurnOwnerContext:
    return TurnOwnerContext(
        participant_identity="11111111-1111-4111-8111-111111111111:browser",
        user_id="11111111-1111-4111-8111-111111111111",
        display_name="Personqc",
        assistant_display_name="Personqc's Assistant",
    )


class AgentHelpParticipationTests(unittest.IsolatedAsyncioTestCase):
    def test_context_pack_splits_recent_verbatim_and_older_context(self) -> None:
        requester = make_agent_help_requester()
        transcript_segments = [
            {
                "speaker_name": "Personqc" if index % 2 else "Personqo",
                "speaker_role": "human",
                "content": f"Decision point {index}",
                "started_at": datetime(2026, 6, 1, 12, index % 60, tzinfo=timezone.utc),
            }
            for index in range(1, 31)
        ]

        context_pack = build_agent_help_context_pack(
            meeting={"title": "Pricing review"},
            participants=[
                {"display_name": "Personqc", "role": "host"},
                {"display_name": "Personqo", "role": "guest"},
            ],
            transcript_segments=transcript_segments,
            requester=requester,
        )

        self.assertEqual(context_pack.meeting_title, "Pricing review")
        self.assertIn("Personqc (host)", context_pack.participant_lines)
        self.assertIn("Personqo (guest)", context_pack.participant_lines)
        self.assertIn("Decision point 1", context_pack.older_transcript_context)
        self.assertFalse(
            any(line.endswith("Decision point 1") for line in context_pack.recent_transcript_lines)
        )
        self.assertIn("Decision point 30", "\n".join(context_pack.recent_transcript_lines))
        self.assertEqual(context_pack.transcript_segment_count, 30)

    def test_no_transcript_context_still_prompts_for_useful_contribution(self) -> None:
        context_pack = build_agent_help_context_pack(
            meeting={"title": "New meeting"},
            participants=[],
            transcript_segments=[],
            requester=make_agent_help_requester(),
        )
        messages = build_agent_help_messages(context_pack)

        self.assertIn(AGENT_HELP_EMPTY_TRANSCRIPT_TEXT, messages[1]["content"])
        self.assertIn("If there is little or no transcript", messages[0]["content"])
        self.assertIn("useful question", messages[0]["content"])

    def test_deep_prompt_allows_situation_appropriate_length(self) -> None:
        self.assertIn("Choose the length that fits the situation", AGENT_HELP_DEEP_PROMPT)
        self.assertIn("Do not monologue", AGENT_HELP_DEEP_PROMPT)
        self.assertNotIn("under roughly 30 words", AGENT_HELP_DEEP_PROMPT)
        self.assertNotIn("at most two short sentences", AGENT_HELP_DEEP_PROMPT)

    async def test_agent_help_generation_calls_configured_gpt55_model(self) -> None:
        context_pack = build_agent_help_context_pack(
            meeting={"title": "Roadmap"},
            participants=[{"display_name": "Personqc", "role": "host"}],
            transcript_segments=[
                {
                    "speaker_name": "Personqc",
                    "speaker_role": "human",
                    "content": "We are choosing between quality and launch speed.",
                    "started_at": None,
                }
            ],
            requester=make_agent_help_requester(),
        )
        fake_responses = SimpleNamespace(
            create=AsyncMock(
                return_value=SimpleNamespace(
                    output_text="I would decide which risk is more expensive: shipping late or shipping thin."
                )
            )
        )
        fake_client = SimpleNamespace(responses=fake_responses, close=AsyncMock())
        settings = SimpleNamespace(
            openai_api_key="test-openai-key",
            openai_meeting_agent_help_model="gpt-5.5",
            openai_meeting_agent_help_timeout_ms=12000,
        )

        with patch.object(worker, "SETTINGS", settings), patch(
            "meeting_agent.worker.openai.AsyncClient",
            return_value=fake_client,
        ) as client_factory:
            answer = await generate_agent_help_participation(context_pack, credit_usage=ProviderOnlyCreditUsage())

        self.assertEqual(
            answer,
            "I would decide which risk is more expensive: shipping late or shipping thin.",
        )
        client_factory.assert_called_once_with(api_key="test-openai-key", max_retries=0)
        fake_responses.create.assert_awaited_once()
        create_kwargs = fake_responses.create.await_args.kwargs
        self.assertEqual(create_kwargs["model"], "gpt-5.5")
        self.assertEqual(create_kwargs["extra_body"], {})
        self.assertIn("Read the meeting transcript", create_kwargs["input"][0]["content"])
        self.assertIn("Recent verbatim transcript", create_kwargs["input"][1]["content"])
        self.assertNotIn("tools", create_kwargs)
        self.assertNotIn(
            AGENT_HELP_WEB_SEARCH_GUIDANCE, create_kwargs["input"][0]["content"]
        )
        fake_client.close.assert_awaited_once()

    def test_agent_help_messages_include_web_search_guidance_only_when_enabled(self) -> None:
        context_pack = build_agent_help_context_pack(
            meeting={"title": "Roadmap"},
            participants=[],
            transcript_segments=[],
            requester=make_agent_help_requester(),
        )

        without_search = build_agent_help_messages(context_pack)
        with_search = build_agent_help_messages(context_pack, web_search_enabled=True)

        self.assertNotIn(AGENT_HELP_WEB_SEARCH_GUIDANCE, without_search[0]["content"])
        self.assertIn(AGENT_HELP_WEB_SEARCH_GUIDANCE, with_search[0]["content"])
        self.assertIn(AGENT_HELP_DEEP_PROMPT, with_search[0]["content"])

    async def test_agent_help_generation_runs_web_search_tool_round(self) -> None:
        context_pack = build_agent_help_context_pack(
            meeting={"title": "Pricing review"},
            participants=[{"display_name": "Personqc", "role": "host"}],
            transcript_segments=[
                {
                    "speaker_name": "Personqc",
                    "speaker_role": "human",
                    "content": "What is the competitor charging today?",
                    "started_at": None,
                }
            ],
            requester=make_agent_help_requester(),
        )
        web_search_call = SimpleNamespace(
            type="function_call",
            name="web_search",
            call_id="call-1",
            arguments=json.dumps({"query": "competitor pricing today"}),
        )
        first_response = SimpleNamespace(output_text="", output=[web_search_call])
        final_response = SimpleNamespace(
            output_text="They moved to twenty dollars a seat this week.",
            output=[],
        )
        fake_responses = SimpleNamespace(
            create=AsyncMock(side_effect=[first_response, final_response])
        )
        fake_client = SimpleNamespace(responses=fake_responses, close=AsyncMock())
        settings = SimpleNamespace(
            openai_api_key="test-openai-key",
            openai_meeting_agent_help_model="gpt-5.5",
            openai_meeting_agent_help_timeout_ms=12000,
        )
        web_search_runner = AsyncMock(
            return_value={"voiceAnswer": "They moved to twenty dollars a seat this week."}
        )

        with patch.object(worker, "SETTINGS", settings), patch(
            "meeting_agent.worker.openai.AsyncClient",
            return_value=fake_client,
        ):
            answer = await generate_agent_help_participation(context_pack, credit_usage=ProviderOnlyCreditUsage(),
                web_search_runner=web_search_runner,
            )

        self.assertEqual(answer, "They moved to twenty dollars a seat this week.")
        web_search_runner.assert_awaited_once_with("competitor pricing today")
        self.assertEqual(fake_responses.create.await_count, 2)
        first_kwargs = fake_responses.create.await_args_list[0].kwargs
        self.assertEqual(first_kwargs["tools"], [AGENT_HELP_WEB_SEARCH_TOOL_DEFINITION])
        self.assertIn(AGENT_HELP_WEB_SEARCH_GUIDANCE, first_kwargs["input"][0]["content"])
        second_input = fake_responses.create.await_args_list[1].kwargs["input"]
        self.assertIn(web_search_call, second_input)
        tool_outputs = [
            item
            for item in second_input
            if isinstance(item, dict) and item.get("type") == "function_call_output"
        ]
        self.assertEqual(len(tool_outputs), 1)
        self.assertEqual(tool_outputs[0]["call_id"], "call-1")
        self.assertIn("voiceAnswer", tool_outputs[0]["output"])
        fake_client.close.assert_awaited_once()

    async def test_agent_help_generation_recovers_when_web_search_fails(self) -> None:
        context_pack = build_agent_help_context_pack(
            meeting={"title": "Pricing review"},
            participants=[],
            transcript_segments=[],
            requester=make_agent_help_requester(),
        )
        web_search_call = SimpleNamespace(
            type="function_call",
            name="web_search",
            call_id="call-1",
            arguments=json.dumps({"query": "competitor pricing today"}),
        )
        first_response = SimpleNamespace(output_text="", output=[web_search_call])
        final_response = SimpleNamespace(
            output_text="I could not verify the current price, but I would frame the decision around our own cost floor.",
            output=[],
        )
        fake_responses = SimpleNamespace(
            create=AsyncMock(side_effect=[first_response, final_response])
        )
        fake_client = SimpleNamespace(responses=fake_responses, close=AsyncMock())
        settings = SimpleNamespace(
            openai_api_key="test-openai-key",
            openai_meeting_agent_help_model="gpt-5.5",
            openai_meeting_agent_help_timeout_ms=12000,
        )
        web_search_runner = AsyncMock(side_effect=RuntimeError("broker down"))

        with patch.object(worker, "SETTINGS", settings), patch(
            "meeting_agent.worker.openai.AsyncClient",
            return_value=fake_client,
        ):
            answer = await generate_agent_help_participation(context_pack, credit_usage=ProviderOnlyCreditUsage(),
                web_search_runner=web_search_runner,
            )

        self.assertEqual(
            answer,
            "I could not verify the current price, but I would frame the decision around our own cost floor.",
        )
        second_input = fake_responses.create.await_args_list[1].kwargs["input"]
        tool_outputs = [
            item
            for item in second_input
            if isinstance(item, dict) and item.get("type") == "function_call_output"
        ]
        self.assertEqual(len(tool_outputs), 1)
        self.assertIn("web_search_failed", tool_outputs[0]["output"])


class WebSearchPanelBroadcastTests(unittest.IsolatedAsyncioTestCase):
    def test_panel_payload_stays_below_livekit_rpc_limit(self) -> None:
        payload = compact_web_search_panel_payload({
            "status": "completed",
            "query": "weather in San Francisco",
            "searchId": "utterance-1",
            "researchRunId": "550e8400-e29b-41d4-a716-446655440001",
            "answer": {
                "summary": "Sunny with a light breeze.",
                "confidence": "high",
            },
            "answerDisplay": {
                "lead": "Sunny with a light breeze.",
                "confidence": "high",
                "citationCoverage": "complete",
                "sections": [
                    {
                        "heading": f"Forecast {section_index}",
                        "paragraphs": [
                            {
                                "text": "Weather detail " + ("x" * 700),
                                "bold": [],
                                "citationIds": [f"citation-{item_index}"],
                            }
                            for item_index in range(8)
                        ],
                    }
                    for section_index in range(6)
                ],
                "citations": [
                    {
                        "id": f"citation-{index}",
                        "label": "Forecast",
                        "title": "Detailed weather forecast " + ("y" * 300),
                        "url": f"https://example.com/weather/{index}?detail={'z' * 700}",
                        "domain": "example.com",
                    }
                    for index in range(12)
                ],
            },
            "results": [
                {
                    "kind": "source",
                    "title": "Forecast " + ("a" * 300),
                    "url": f"https://example.com/source/{index}?detail={'b' * 700}",
                    "excerpt": "c" * 500,
                }
                for index in range(8)
            ],
        })

        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.assertLessEqual(len(encoded), worker.WEB_SEARCH_RESULTS_RPC_TARGET_BYTES)
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["searchId"], "utterance-1")
        self.assertEqual(payload["answerDisplay"]["lead"], "Sunny with a light breeze.")

    def test_panel_payload_hard_caps_oversized_unicode_fields(self) -> None:
        unicode_text = "🌦️" * 10_000
        payload = compact_web_search_panel_payload({
            "status": "completed",
            "query": unicode_text,
            "searchId": "utterance-unicode",
            "meetingId": "550e8400-e29b-41d4-a716-446655440001",
            "message": unicode_text,
            "answerPreview": unicode_text,
            "answer": {
                "summary": unicode_text,
                "confidence": "high",
                "caveat": unicode_text,
                "facts": [
                    {"text": unicode_text, "citations": []}
                    for _ in range(8)
                ],
            },
            "progress": {
                "phase": unicode_text,
                "statusLabel": unicode_text,
                "message": unicode_text,
                "detail": unicode_text,
                "stats": {
                    f"{unicode_text}-{index}": unicode_text
                    for index in range(8)
                },
                "history": [
                    {
                        "phase": unicode_text,
                        "message": unicode_text,
                        "at": unicode_text,
                    }
                    for _ in range(8)
                ],
            },
        })

        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.assertLessEqual(len(encoded), worker.WEB_SEARCH_RESULTS_RPC_TARGET_BYTES)
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["searchId"], "utterance-unicode")

    async def test_panel_is_sent_to_every_human_participant(self) -> None:
        owner_context = make_agent_help_requester()
        local_participant = SimpleNamespace(
            perform_rpc=AsyncMock(return_value=json.dumps({"status": "shown"}))
        )
        room = SimpleNamespace(
            local_participant=local_participant,
            remote_participants={
                "11111111-1111-4111-8111-111111111111:browser": SimpleNamespace(
                    identity="11111111-1111-4111-8111-111111111111:browser",
                    attributes={"userId": "11111111-1111-4111-8111-111111111111"},
                    metadata="",
                ),
                "22222222-2222-4222-8222-222222222222:browser": SimpleNamespace(
                    identity="22222222-2222-4222-8222-222222222222:browser",
                    attributes={"userId": "22222222-2222-4222-8222-222222222222"},
                    metadata="",
                ),
                "assistant": SimpleNamespace(
                    identity="assistant-1",
                    attributes={"assistantRole": "meeting-agent", "userId": "user-agent"},
                    metadata="",
                ),
                "anonymous": SimpleNamespace(
                    identity="anonymous-1",
                    attributes={},
                    metadata="",
                ),
            },
        )

        with patch(
            "meeting_agent.worker.get_job_context",
            return_value=SimpleNamespace(room=room),
        ):
            result = await show_web_search_panel_for_meeting(
                meeting_id="meeting-1",
                owner_context=owner_context,
                payload={
                    "status": "searching",
                    "query": "competitor pricing today",
                    "searchId": "search-1",
                    "meetingId": "meeting-1",
                    "requestingUserId": owner_context.user_id,
                },
            )

        self.assertEqual(result["status"], "shown")
        destinations = sorted(
            call.kwargs["destination_identity"]
            for call in local_participant.perform_rpc.await_args_list
        )
        self.assertEqual(destinations, ["11111111-1111-4111-8111-111111111111:browser", "22222222-2222-4222-8222-222222222222:browser"])
        for call in local_participant.perform_rpc.await_args_list:
            self.assertEqual(call.kwargs["method"], "readymeet.web_search.show_results")
            self.assertEqual(json.loads(call.kwargs["payload"])["status"], "searching")

    async def test_owner_still_gets_panel_when_another_participant_rpc_fails(self) -> None:
        owner_context = make_agent_help_requester()

        async def perform_rpc(**kwargs: object) -> str:
            if kwargs["destination_identity"] == "22222222-2222-4222-8222-222222222222:browser":
                raise RuntimeError("participant unreachable")
            return json.dumps({"status": "shown"})

        local_participant = SimpleNamespace(perform_rpc=AsyncMock(side_effect=perform_rpc))
        room = SimpleNamespace(
            local_participant=local_participant,
            remote_participants={
                "22222222-2222-4222-8222-222222222222:browser": SimpleNamespace(
                    identity="22222222-2222-4222-8222-222222222222:browser",
                    attributes={"userId": "22222222-2222-4222-8222-222222222222"},
                    metadata="",
                ),
            },
        )

        with patch(
            "meeting_agent.worker.get_job_context",
            return_value=SimpleNamespace(room=room),
        ), patch.object(worker, "log_assistant_debug", new=AsyncMock()):
            result = await show_web_search_panel_for_meeting(
                meeting_id="meeting-1",
                owner_context=owner_context,
                payload={
                    "status": "searching",
                    "query": "competitor pricing today",
                    "searchId": "search-1",
                    "meetingId": "meeting-1",
                    "requestingUserId": owner_context.user_id,
                },
            )

        self.assertEqual(result["status"], "shown")
        self.assertEqual(local_participant.perform_rpc.await_count, 2)

    def test_agent_help_messages_attach_screen_share_image(self) -> None:
        context_pack = build_agent_help_context_pack(
            meeting={"title": "Design review"},
            participants=[{"display_name": "Personqc", "role": "host"}],
            transcript_segments=[
                {
                    "speaker_name": "Personqc",
                    "speaker_role": "human",
                    "content": "Look at this dashboard mock.",
                    "started_at": None,
                }
            ],
            requester=make_agent_help_requester(),
            screen_share_image_data_url="data:image/jpeg;base64,ZmFrZQ==",
        )

        messages = build_agent_help_messages(context_pack)

        user_content = messages[1]["content"]
        self.assertIsInstance(user_content, list)
        self.assertEqual(user_content[0]["type"], "input_text")
        self.assertIn(AGENT_HELP_SCREEN_SHARE_CONTEXT_NOTE, user_content[0]["text"])
        self.assertIn("Recent verbatim transcript", user_content[0]["text"])
        self.assertEqual(
            user_content[1],
            {
                "type": "input_image",
                "image_url": "data:image/jpeg;base64,ZmFrZQ==",
            },
        )

    def test_agent_help_messages_stay_text_only_without_screen_share(self) -> None:
        context_pack = build_agent_help_context_pack(
            meeting={"title": "Standup"},
            participants=[],
            transcript_segments=[],
            requester=make_agent_help_requester(),
        )

        messages = build_agent_help_messages(context_pack)

        self.assertIsInstance(messages[1]["content"], str)
        self.assertNotIn(
            AGENT_HELP_SCREEN_SHARE_CONTEXT_NOTE, messages[1]["content"]
        )

    def test_newer_agent_help_request_supersedes_older_answer(self) -> None:
        active_turn = SimpleNamespace(meeting_turn_id="turn-1")
        ambient_state = {"request_id": "request-1", "turn_id": "turn-1"}

        self.assertTrue(
            is_current_agent_help_request(
                ambient_help_state=ambient_state,
                request_id="request-1",
                active_turn=active_turn,
                current_turn=active_turn,
                push_to_talk_active=False,
            )
        )

        ambient_state["request_id"] = "request-2"
        self.assertFalse(
            is_current_agent_help_request(
                ambient_help_state=ambient_state,
                request_id="request-1",
                active_turn=active_turn,
                current_turn=active_turn,
                push_to_talk_active=False,
            )
        )
        ambient_state["request_id"] = "request-1"
        self.assertFalse(
            is_current_agent_help_request(
                ambient_help_state=ambient_state,
                request_id="request-1",
                active_turn=active_turn,
                current_turn=active_turn,
                push_to_talk_active=True,
            )
        )


def make_fake_screen_share_publication(
    *,
    source: object,
    muted: bool = False,
    subscribed: bool = True,
    track: object = None,
) -> SimpleNamespace:
    publication = SimpleNamespace(
        source=source,
        muted=muted,
        subscribed=subscribed,
        track=track,
        set_subscribed_calls=[],
    )

    def set_subscribed(value: bool) -> None:
        publication.set_subscribed_calls.append(value)
        publication.subscribed = value

    publication.set_subscribed = set_subscribed
    return publication


def make_fake_room(*publications: SimpleNamespace) -> SimpleNamespace:
    participant = SimpleNamespace(
        track_publications={
            f"pub-{index}": publication
            for index, publication in enumerate(publications)
        }
    )
    return SimpleNamespace(remote_participants={"participant-1": participant})


class FakeVideoStream:
    def __init__(self, track: object, **kwargs: object) -> None:
        self.track = track
        self.closed = False

    async def __anext__(self) -> SimpleNamespace:
        return SimpleNamespace(frame="fake-frame")

    async def aclose(self) -> None:
        self.closed = True


class AgentHelpScreenShareCaptureTests(unittest.IsolatedAsyncioTestCase):
    def test_visual_evidence_requires_task_or_problem_intent_and_screen_context(self) -> None:
        self.assertTrue(
            should_capture_visual_evidence(
                "When I click this button, the checkout freezes on this screen."
            )
        )
        self.assertTrue(
            should_capture_visual_evidence(
                "You can see the modal is cut off here and it should fit."
            )
        )
        self.assertTrue(
            should_capture_visual_evidence(
                "The checkout button does not work for customer accounts."
            )
        )
        self.assertTrue(
            should_capture_visual_evidence(
                "Can we add a date filter to this dashboard?"
            )
        )
        self.assertTrue(
            should_capture_visual_evidence(
                "We should move this icon below the form."
            )
        )
        self.assertFalse(
            should_capture_visual_evidence("Here is the new dashboard design we shipped.")
        )
        self.assertFalse(
            should_capture_visual_evidence("We should schedule a follow-up call next week.")
        )
        self.assertFalse(
            should_capture_visual_evidence("We already fixed this bug last week.")
        )

    def test_visual_evidence_selects_latest_grounded_human_segment(self) -> None:
        selected = select_contextual_visual_evidence_segment([
            {
                "id": "segment-1",
                "speaker_role": "assistant",
                "content": "You can see this issue here.",
            },
            {
                "id": "segment-2",
                "speaker_role": "human",
                "content": "This is a normal product walkthrough.",
            },
            {
                "id": "segment-3",
                "speaker_role": "human",
                "content": "When I open this menu, it overlaps the save button.",
            },
        ])

        self.assertEqual(selected["id"], "segment-3")

    def test_visual_evidence_context_keeps_a_bounded_transcript_window(self) -> None:
        segments = [
            {
                "id": f"00000000-0000-4000-8000-00000000000{index}",
                "speaker_role": "human",
                "content": f"Segment {index}",
            }
            for index in range(6)
        ]

        context = visual_evidence_context_segments(segments, segments[3], radius=2)

        self.assertEqual(
            [segment["id"] for segment in context],
            [segments[index]["id"] for index in range(1, 6)],
        )

    async def test_contextual_capture_persists_transcript_provenance(self) -> None:
        broker = AsyncMock(return_value={"asset": {"id": "asset-1"}})
        segment_id = "33333333-3333-4333-8333-333333333333"
        segment = {
            "id": segment_id,
            "speaker_role": "human",
            "speaker_name": "Customer",
            "content": "When I click this button, the page is stuck here.",
            "started_at": datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc),
        }

        with patch("meeting_agent.worker.call_agent_tool_broker", new=broker):
            result = await persist_contextual_screen_capture(
                settings=worker.SETTINGS,
                meeting_id="11111111-1111-4111-8111-111111111111",
                image_data_url="data:image/jpeg;base64,ZmFrZQ==",
                segment=segment,
                context_segments=[
                    {
                        "id": "22222222-2222-4222-8222-222222222222",
                        "speaker_role": "human",
                        "content": "Let me show the checkout flow.",
                    },
                    segment,
                ],
                screen_share={
                    "participantIdentity": "customer-browser",
                    "trackSid": "TR_screen",
                },
            )

        self.assertEqual(result["asset"]["id"], "asset-1")
        broker.assert_awaited_once()
        args = broker.await_args.args
        payload = args[2]
        self.assertEqual(args[1], "meeting-assets")
        self.assertEqual(payload["transcriptSegmentId"], segment_id)
        self.assertEqual(payload["transcriptSegmentIds"], [
            "22222222-2222-4222-8222-222222222222",
            segment_id,
        ])
        self.assertEqual(payload["speakerName"], "Customer")
        self.assertEqual(payload["participantIdentity"], "customer-browser")
        self.assertEqual(payload["trigger"], "automatic_task_context")

    def test_find_active_screen_share_skips_camera_and_muted_tracks(self) -> None:
        camera = make_fake_screen_share_publication(
            source=rtc.TrackSource.SOURCE_CAMERA
        )
        muted_share = make_fake_screen_share_publication(
            source=rtc.TrackSource.SOURCE_SCREENSHARE, muted=True
        )
        active_share = make_fake_screen_share_publication(
            source=rtc.TrackSource.SOURCE_SCREENSHARE
        )

        self.assertIsNone(
            find_active_screen_share_publication(make_fake_room(camera, muted_share))
        )
        self.assertIs(
            find_active_screen_share_publication(
                make_fake_room(camera, muted_share, active_share)
            ),
            active_share,
        )

    async def test_capture_returns_none_without_active_screen_share(self) -> None:
        room = make_fake_room(
            make_fake_screen_share_publication(source=rtc.TrackSource.SOURCE_CAMERA)
        )

        self.assertIsNone(await capture_screen_share_image_data_url(room))

    async def test_capture_subscribes_encodes_frame_and_restores_subscription(
        self,
    ) -> None:
        publication = make_fake_screen_share_publication(
            source=rtc.TrackSource.SOURCE_SCREENSHARE,
            subscribed=False,
            track="fake-track",
        )
        room = make_fake_room(publication)
        fake_images = SimpleNamespace(
            encode=MagicMock(return_value=b"fake-bytes"),
            EncodeOptions=MagicMock(),
            ResizeOptions=MagicMock(),
        )

        with patch.object(worker, "video_frame_images", fake_images), patch.object(
            worker.rtc, "VideoStream", FakeVideoStream
        ):
            data_url = await capture_screen_share_image_data_url(room)

        self.assertEqual(data_url, "data:image/jpeg;base64,ZmFrZS1ieXRlcw==")
        self.assertEqual(fake_images.encode.call_args.args[0], "fake-frame")
        self.assertEqual(publication.set_subscribed_calls, [True, False])
        self.assertFalse(publication.subscribed)

    async def test_capture_keeps_existing_subscription(self) -> None:
        publication = make_fake_screen_share_publication(
            source=rtc.TrackSource.SOURCE_SCREENSHARE,
            subscribed=True,
            track="fake-track",
        )
        room = make_fake_room(publication)
        fake_images = SimpleNamespace(
            encode=MagicMock(return_value=b"fake-bytes"),
            EncodeOptions=MagicMock(),
            ResizeOptions=MagicMock(),
        )

        with patch.object(worker, "video_frame_images", fake_images), patch.object(
            worker.rtc, "VideoStream", FakeVideoStream
        ):
            data_url = await capture_screen_share_image_data_url(room)

        self.assertEqual(data_url, "data:image/jpeg;base64,ZmFrZS1ieXRlcw==")
        self.assertEqual(publication.set_subscribed_calls, [])


class MeetingAssistantModeTests(unittest.TestCase):
    def test_guest_and_sip_user_ids_require_canonical_uuid_strings(self):
        user_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        for identity, kind in [("guest:request", None), ("sip_call", rtc.ParticipantKind.PARTICIPANT_KIND_SIP)]:
            for bad_id in ["not-a-uuid", user_id + "junk", user_id.replace("-", ""), 123, None]:
                participant = SimpleNamespace(identity=identity, kind=kind,
                    attributes={"userId": bad_id}, metadata="{}")
                self.assertIsNone(worker.get_participant_user_id(participant))
                participant.metadata = '{"userId":"' + user_id.upper() + '"}'
                self.assertEqual(worker.get_participant_user_id(participant), user_id)
            for metadata in ["[]", "null", "123", '{"userId":123}', '{"userId":"bad"}', "invalid json"]:
                participant = SimpleNamespace(identity=identity, kind=kind, attributes={}, metadata=metadata)
                self.assertIsNone(worker.get_participant_user_id(participant))

    def test_identity_cannot_be_changed_by_attributes_or_metadata(self) -> None:
        user_id = "11111111-1111-4111-8111-111111111111"
        victim_id = "22222222-2222-4222-8222-222222222222"
        participant = SimpleNamespace(identity=f"{user_id}:browser", name="Caller",
            attributes={"userId": victim_id}, metadata=json.dumps({"userId": victim_id}))
        room = SimpleNamespace(remote_participants={participant.identity: participant})
        owner = worker.resolve_turn_owner_context(room, participant.identity)
        self.assertEqual(owner.user_id, user_id)
        forged_owner = replace(owner, user_id=victim_id)
        self.assertFalse(worker.is_turn_owner_connection_current(room, forged_owner,
            expected_disconnect_revision=0, disconnect_revisions={}))
        participant.attributes = {}
        self.assertEqual(worker.get_participant_user_id(participant), user_id)
        participant.identity = "unknown-worker"
        self.assertIsNone(worker.get_participant_user_id(participant))

    def test_readonly_guest_and_sip_identity_metadata_is_preserved(self) -> None:
        user_id = "11111111-1111-4111-8111-111111111111"
        for identity, kind in [("guest:join-request", None), ("sip_call", rtc.ParticipantKind.PARTICIPANT_KIND_SIP)]:
            participant = SimpleNamespace(identity=identity, kind=kind,
                attributes={"userId": user_id}, metadata="")
            self.assertEqual(worker.get_participant_user_id(participant), user_id)

    def test_group_session_closes_without_waiting_for_an_unused_stt_transcript(self) -> None:
        self.assertEqual(
            session_close_transcript_timeout_for_mode(ASSISTANT_MODE_GROUP),
            0.0,
        )

    def test_voice_session_keeps_its_final_transcript_grace_period(self) -> None:
        self.assertGreater(
            session_close_transcript_timeout_for_mode(ASSISTANT_MODE_SOLO),
            0.0,
        )

    def test_turn_owner_connection_requires_owner_to_remain_in_room(self) -> None:
        owner_context = make_agent_help_requester()
        room = SimpleNamespace(remote_participants={})

        self.assertFalse(
            is_turn_owner_connection_current(
                room,
                owner_context,
                expected_disconnect_revision=0,
                disconnect_revisions={},
            )
        )

    def test_turn_owner_connection_rejects_old_start_after_same_identity_reconnects(
        self,
    ) -> None:
        owner_context = make_agent_help_requester()
        reconnected_participant = SimpleNamespace(
            identity=owner_context.participant_identity,
            name=owner_context.display_name,
            attributes={"userId": owner_context.user_id},
            metadata="",
        )
        room = SimpleNamespace(
            remote_participants={
                owner_context.participant_identity: reconnected_participant,
            }
        )

        self.assertFalse(
            is_turn_owner_connection_current(
                room,
                owner_context,
                expected_disconnect_revision=0,
                disconnect_revisions={owner_context.participant_identity: 1},
            )
        )
        self.assertTrue(
            is_turn_owner_connection_current(
                room,
                owner_context,
                expected_disconnect_revision=1,
                disconnect_revisions={owner_context.participant_identity: 1},
            )
        )

    def test_expiring_active_turn_persists_and_updates_in_memory_status(self) -> None:
        active_turn = ActiveTurnLease(
            meeting_turn_id="turn-voice-1",
            agent_profile_id="profile-personqc",
            owner_context=make_agent_help_requester(),
            voice_id="marin",
            started_at=datetime.now(timezone.utc),
        )
        repository = SimpleNamespace(
            update_meeting_turn_lease=AsyncMock(
                return_value=SimpleNamespace(status="expired")
            )
        )

        asyncio.run(expire_active_turn_lease(repository, active_turn))

        repository.update_meeting_turn_lease.assert_awaited_once_with(
            meeting_turn_id="turn-voice-1",
            owner_user_id=active_turn.owner_context.user_id,
            owner_participant_identity=active_turn.owner_context.participant_identity,
            status="expired",
        )
        self.assertEqual(active_turn.status, "expired")

    def test_select_assistant_mode_from_human_count(self) -> None:
        self.assertEqual(select_assistant_mode(0), ASSISTANT_MODE_IDLE)
        self.assertEqual(select_assistant_mode(1), ASSISTANT_MODE_GROUP)
        self.assertEqual(select_assistant_mode(2), ASSISTANT_MODE_GROUP)
        self.assertEqual(select_assistant_mode(5), ASSISTANT_MODE_GROUP)

    def test_conversation_mode_requires_exactly_one_human(self) -> None:
        self.assertEqual(
            select_assistant_mode(1, conversation_mode_active=True),
            ASSISTANT_MODE_SOLO,
        )
        self.assertEqual(
            select_assistant_mode(4, conversation_mode_active=True),
            ASSISTANT_MODE_GROUP,
        )
        self.assertEqual(
            select_assistant_mode(0, conversation_mode_active=True),
            ASSISTANT_MODE_IDLE,
        )

    def test_group_instructions_keep_push_to_talk_gate(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP
        )

        self.assertIn("push-to-talk", instructions)
        self.assertIn("only answer", instructions)
        self.assertIn("answer the speaking participant's current utterance directly", instructions)
        self.assertIn("Use the meeting transcript, tools, and recent context only", instructions)

    def test_personal_assistant_display_name_matches_presence_panel_style(self) -> None:
        self.assertEqual(
            format_personal_assistant_display_name("Personqc Personqd"),
            "Personqc's Assistant",
        )
        self.assertEqual(
            format_personal_assistant_display_name("James Personqs"),
            "James's Assistant",
        )

    def test_live_assistant_display_name_converts_legacy_default_profile_name(self) -> None:
        self.assertEqual(
            resolve_live_assistant_display_name(
                owner_display_name="Personqc Personqd",
                profile_display_name="Personqc Personqd's Assistant",
            ),
            "Personqc's Assistant",
        )
        self.assertEqual(
            resolve_live_assistant_display_name(
                owner_display_name="Personqc Personqd",
                profile_display_name="Personri",
            ),
            "Personri",
        )

    def test_assistant_presence_can_publish_thinking_phase(self) -> None:
        owner_context = make_agent_help_requester()
        local_participant = SimpleNamespace(
            identity="readymeet-assistant-test",
            set_name=AsyncMock(),
            set_attributes=AsyncMock(),
            publish_data=AsyncMock(),
        )

        asyncio.run(
            set_assistant_presence(
                local_participant,
                owner_context,
                phase="thinking",
            )
        )

        local_participant.set_attributes.assert_awaited_once()
        attributes = local_participant.set_attributes.await_args.args[0]
        self.assertEqual(attributes["assistantPhase"], "thinking")

        asyncio.run(publish_assistant_presence(local_participant, owner_context, phase="thinking"))

        local_participant.publish_data.assert_awaited_once()
        payload = json.loads(local_participant.publish_data.await_args.args[0])
        self.assertEqual(payload["assistantIdentity"], "readymeet-assistant-test")
        self.assertEqual(payload["assistantDisplayName"], "Personqc's Assistant")
        self.assertTrue(payload["active"])
        self.assertEqual(payload["phase"], "thinking")

    def test_assistant_presence_publishes_conversation_mode_state(self) -> None:
        owner_context = make_agent_help_requester()
        local_participant = SimpleNamespace(
            identity="readymeet-assistant-test",
            set_name=AsyncMock(),
            set_attributes=AsyncMock(),
            publish_data=AsyncMock(),
        )

        asyncio.run(
            set_assistant_presence(
                local_participant,
                owner_context,
                conversation_mode_active=True,
            )
        )

        attributes = local_participant.set_attributes.await_args.args[0]
        self.assertEqual(attributes["assistantConversationMode"], "active")

        asyncio.run(
            publish_assistant_presence(
                local_participant,
                owner_context,
                conversation_mode_active=True,
            )
        )

        payload = json.loads(local_participant.publish_data.await_args.args[0])
        self.assertTrue(payload["conversationModeActive"])
        self.assertEqual(
            payload["assistantOwnerParticipantIdentity"],
            owner_context.participant_identity,
        )

        local_participant.set_attributes.reset_mock()
        asyncio.run(set_assistant_presence(local_participant, None))
        cleared_attributes = local_participant.set_attributes.await_args.args[0]
        self.assertEqual(cleared_attributes["assistantConversationMode"], "")

    def test_solo_assistant_transcript_uses_solo_turn_name_context(self) -> None:
        solo_turn = ActiveTurnLease(
            meeting_turn_id="solo:meeting-1:11111111-1111-4111-8111-111111111111",
            agent_profile_id="profile-personqc",
            owner_context=make_agent_help_requester(),
            voice_id="marin",
            started_at=datetime.now(timezone.utc),
        )
        current_turn = ActiveTurnLease(
            meeting_turn_id="turn-1",
            agent_profile_id="profile-personqc",
            owner_context=make_agent_help_requester(),
            voice_id="marin",
            started_at=datetime.now(timezone.utc),
        )

        self.assertIs(
            select_active_transcript_turn(
                assistant_mode=ASSISTANT_MODE_SOLO,
                current_turn=None,
                solo_turn=solo_turn,
            ),
            solo_turn,
        )
        self.assertIs(
            select_active_transcript_turn(
                assistant_mode=ASSISTANT_MODE_GROUP,
                current_turn=current_turn,
                solo_turn=solo_turn,
            ),
            current_turn,
        )
        self.assertIsNone(
            select_active_transcript_turn(
                assistant_mode=ASSISTANT_MODE_GROUP,
                current_turn=None,
                solo_turn=solo_turn,
            )
        )

    def test_solo_instructions_remove_push_to_talk_gate(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_SOLO
        )

        self.assertIn("without requiring push-to-talk", instructions)
        self.assertIn("recent LiveKit chat history", instructions)
        self.assertIn("do not tell the user to check meeting notes", instructions)
        self.assertNotIn("You only answer when a participant explicitly uses push-to-talk", instructions)

    def test_solo_instructions_gate_view_shared_screen_on_screen_references(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_SOLO
        )

        self.assertIn("call view_shared_screen first", instructions)
        self.assertIn(
            "Do not call view_shared_screen when no screen share is active or the turn "
            "has nothing to do with visible content",
            instructions,
        )
        self.assertIn(
            "treat requests about items that are plausibly visible as screen references",
            instructions,
        )
        self.assertIn(
            "you cannot see screens or slides unless you have called view_shared_screen",
            instructions,
        )
        self.assertIn(
            "Never describe or claim to see screen content without a snapshot",
            instructions,
        )
        self.assertNotIn("You do not have vision", instructions)

    def test_group_instructions_keep_no_vision_statement(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP
        )

        self.assertIn("You do not have vision", instructions)
        self.assertNotIn("view_shared_screen", instructions)

    def test_instructions_do_not_name_a_specific_reply_language(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_SOLO
        )

        self.assertNotIn("Finnish", instructions)
        self.assertIn("default to English when there is no clear signal", instructions)
        self.assertIn("stay silent and produce no reply", instructions)

    def test_agent_intro_opening_script_uses_first_name_and_exact_copy(self) -> None:
        script = build_agent_intro_opening_script("Personqb Personqd")

        self.assertEqual(
            script,
            "Hey Personqb, welcome to Ready.\n\n"
            "I stay quiet until you turn on voice mode. Then we can talk naturally, and I’ll respond to what you say. Turn it off whenever you want me to stop listening.\n\n"
            "I can search the web and use the tools you connect, so I can bring the right context into the conversation when you need it.",
        )

    def test_agent_intro_opening_instructions_require_verbatim_delivery(self) -> None:
        instructions = build_agent_intro_opening_instructions("Personqb")

        self.assertIn("Say the following opening script verbatim", instructions)
        self.assertIn("Hey Personqb, welcome to Ready.", instructions)
        self.assertIn("Do not add, remove, or reword anything", instructions)
        self.assertNotIn("Linear", instructions)
        self.assertNotIn("Salesforce", instructions)
        self.assertNotIn("Notion", instructions)

    def test_agent_intro_opening_speaks_through_manual_agent_help_path(self) -> None:
        session = SimpleNamespace(
            say=MagicMock(),
            generate_reply=MagicMock(),
        )

        asyncio.run(start_agent_intro_opening(session, "Personqb"))

        session.say.assert_called_once_with(
            "Hey Personqb, welcome to Ready.\n\n"
            "I stay quiet until you turn on voice mode. Then we can talk naturally, and I’ll respond to what you say. Turn it off whenever you want me to stop listening.\n\n"
            "I can search the web and use the tools you connect, so I can bring the right context into the conversation when you need it.",
            allow_interruptions=True,
        )
        session.generate_reply.assert_not_called()

    def test_agent_intro_opening_is_pending_only_before_first_intro_use(self) -> None:
        self.assertTrue(
            is_agent_intro_opening_pending(
                is_agent_intro_meeting=True,
                agent_intro_opening_sent=False,
            )
        )
        self.assertFalse(
            is_agent_intro_opening_pending(
                is_agent_intro_meeting=True,
                agent_intro_opening_sent=True,
            )
        )
        self.assertFalse(
            is_agent_intro_opening_pending(
                is_agent_intro_meeting=False,
                agent_intro_opening_sent=False,
            )
        )

    def test_agent_intro_instructions_keep_product_insider_tone(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            agent_intro_mode=True,
        )

        self.assertIn("first-run Meet your agent room", instructions)
        self.assertIn("calm Silicon Valley product insider", instructions)
        self.assertIn("turn on voice mode", instructions)
        self.assertIn("You only answer when a participant explicitly uses push-to-talk", instructions)
        self.assertNotIn("private one-on-one asides stay separate", instructions)
        self.assertNotIn("Want to connect your calendar now?", instructions)
        self.assertIn("Do not use customer-support openings", instructions)

    def test_agent_intro_explains_more_tool_help_only_when_asked(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            agent_intro_mode=True,
        )

        self.assertIn("If, and only if, the user asks how you can help", instructions)
        self.assertIn("any tool you've allowed me to use", instructions)
        self.assertIn("product questions from Linear", instructions)
        self.assertIn("weekly sales call with Salesforce context", instructions)
        self.assertIn("Notion docs while the conversation is happening", instructions)
        self.assertIn("do not offer this longer capability rundown unless the user asks for it", instructions)

    def test_agent_intro_does_not_force_calendar_question(self) -> None:
        disconnected_instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            agent_intro_mode=True,
        )
        connected_instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["google_calendar"],
            agent_intro_mode=True,
        )

        self.assertNotIn("Want to connect your calendar now?", disconnected_instructions)
        self.assertNotIn("every substantive reply in this intro room must end", disconnected_instructions)
        self.assertNotIn("Want to connect your calendar now?", connected_instructions)
        self.assertNotIn("every substantive reply in this intro room must end", connected_instructions)

    def test_instructions_require_tool_grounding_for_task_claims(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_SOLO
        )

        self.assertIn("get_meeting_context or list_action_items result", instructions)
        self.assertIn("Never invent, estimate, or recall them from memory", instructions)
        self.assertIn("say nothing is tracked yet", instructions)

    def test_phantom_user_turn_detection(self) -> None:
        self.assertTrue(is_phantom_user_turn("Son of a..."))
        self.assertTrue(is_phantom_user_turn("Son of a…"))
        self.assertTrue(is_phantom_user_turn("Thanks for watching!"))
        self.assertTrue(is_phantom_user_turn("THANK YOU FOR WATCHING."))

        self.assertFalse(is_phantom_user_turn(""))
        self.assertFalse(is_phantom_user_turn("Stop."))
        self.assertFalse(is_phantom_user_turn("What tasks do we have open?"))
        # Real speech that trails off keeps getting answered.
        self.assertFalse(
            is_phantom_user_turn(
                "Voitko tehdä yhteenvedon kokouksen avoimista tehtävistä ja..."
            )
        )

    def test_phantom_turn_suppresses_reply_before_realtime_generation(self) -> None:
        agent = build_meeting_assistant_agent(
            "11111111-1111-1111-1111-111111111111",
            lambda: None,
            participant_names=["Personqc Personqd"],
            assistant_mode=ASSISTANT_MODE_SOLO,
        )
        message = SimpleNamespace(text_content="Son of a...")

        with self.assertRaises(StopResponse):
            asyncio.run(agent.on_user_turn_completed(SimpleNamespace(), message))

    def test_real_turn_is_not_suppressed_as_phantom(self) -> None:
        agent = build_meeting_assistant_agent(
            "11111111-1111-1111-1111-111111111111",
            lambda: None,
            participant_names=["Personqc Personqd"],
            assistant_mode=ASSISTANT_MODE_SOLO,
        )
        fake_session = SimpleNamespace(interrupt=AsyncMock(), history=None)
        message = SimpleNamespace(text_content="What tasks do we have open?")
        turn_ctx = SimpleNamespace(add_message=lambda **kwargs: None)

        with patch.object(
            type(agent), "session", new_callable=PropertyMock, return_value=fake_session
        ):
            asyncio.run(agent.on_user_turn_completed(turn_ctx, message))

        fake_session.interrupt.assert_not_awaited()

    def test_linear_instructions_are_omitted_when_linear_is_disconnected(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=[],
        )

        self.assertNotIn("Linear is connected for the requesting participant", instructions)
        self.assertNotIn("search_linear", instructions)

    def test_linear_instructions_are_included_when_linear_is_connected(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["linear"],
        )

        self.assertIn("Linear is connected for the requesting participant", instructions)
        self.assertIn("tickets, issues, bugs, projects, initiatives", instructions)
        self.assertIn("use search_linear", instructions)
        self.assertIn("ticket-specific language, prioritize issues", instructions)
        self.assertIn("roadmap or planning language", instructions)
        self.assertIn("plan/spec/decision language", instructions)
        self.assertIn("prepare_linear_issue", instructions)
        self.assertIn("confirm_linear_issue", instructions)
        self.assertIn("Never create or update Linear objects", instructions)

    def test_calendar_connection_instructions_are_included_when_disconnected(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=[],
        )

        self.assertIn("connect or disable a calendar skill", instructions)
        self.assertIn("Google Calendar or Outlook", instructions)
        self.assertIn("show_tool_connect_panel", instructions)
        self.assertIn("action disable", instructions)
        self.assertIn("Connect or Disable button", instructions)
        self.assertIn("Do not claim a browser opened", instructions)

    def test_calendar_lookup_instructions_are_included_when_connected(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["google_calendar"],
        )

        self.assertIn("Calendar is connected for the requesting participant", instructions)
        self.assertIn("list_calendar_events", instructions)
        self.assertIn("search_calendar_events", instructions)
        self.assertIn("get_calendar_event", instructions)
        self.assertIn("action disable", instructions)

    def test_web_search_instructions_do_not_request_agent_skills(self) -> None:
        instructions = build_meeting_assistant_instructions(
            assistant_mode=ASSISTANT_MODE_GROUP,
            web_search_enabled=True,
        )

        self.assertIn("use web search before answering", instructions)
        self.assertIn("Do not open the Agent skills panel for web search", instructions)

    def test_meeting_assistant_stt_uses_elevenlabs_plugin_with_auto_language(self) -> None:
        settings = SimpleNamespace(
            meeting_assistant_stt_model=DEFAULT_TEST_STT_MODEL,
            meeting_assistant_stt_language="",
            eleven_api_key="test-eleven-key",
        )
        with patch.object(worker, "SETTINGS", settings), patch(
            "meeting_agent.worker.elevenlabs.STT", return_value=object()
        ) as stt_factory:
            build_meeting_assistant_stt(participant_names=["Personqc"])

        stt_factory.assert_called_once_with(
            api_key="test-eleven-key",
            model=DEFAULT_TEST_STT_MODEL,
        )

    def test_meeting_assistant_stt_maps_explicit_language_to_plugin_parameter(self) -> None:
        settings = SimpleNamespace(
            meeting_assistant_stt_model=DEFAULT_TEST_STT_MODEL,
            meeting_assistant_stt_language="en",
            eleven_api_key="test-eleven-key",
        )
        with patch.object(worker, "SETTINGS", settings), patch(
            "meeting_agent.worker.elevenlabs.STT", return_value=object()
        ) as stt_factory:
            build_meeting_assistant_stt(participant_names=["Personqc"])

        stt_factory.assert_called_once_with(
            api_key="test-eleven-key",
            model=DEFAULT_TEST_STT_MODEL,
            language_code="en",
        )

    def test_solo_response_mode_is_always_realtime(self) -> None:
        self.assertEqual(
            worker.get_assistant_response_mode_for_mode(ASSISTANT_MODE_SOLO),
            SOLO_RESPONSE_MODE_REALTIME,
        )
        self.assertTrue(worker.is_solo_realtime_response_mode(ASSISTANT_MODE_SOLO))

    def test_solo_turn_handling_uses_livekit_audio_turn_detector(self) -> None:
        turn_detector = object()
        with patch(
            "meeting_agent.worker.inference.TurnDetector", return_value=turn_detector
        ), patch.object(worker, "SETTINGS", replace(worker.SETTINGS, openai_meeting_assistant_realtime_model="gpt-realtime")):
            turn_handling = build_turn_handling_for_mode(ASSISTANT_MODE_SOLO)

        self.assertIs(turn_handling["turn_detection"], turn_detector)

    def test_group_turn_handling_stays_manual(self) -> None:
        turn_handling = build_turn_handling_for_mode(ASSISTANT_MODE_GROUP)

        self.assertEqual(turn_handling["turn_detection"], "manual")
        self.assertFalse(turn_handling["preemptive_generation"]["enabled"])

    def test_group_push_to_talk_flush_matches_solo_low_latency_endpoint(self) -> None:
        self.assertEqual(PUSH_TO_TALK_STT_FLUSH_DURATION_S, SOLO_ENDPOINTING_MIN_DELAY_S)

    def test_runtime_fingerprint_reports_realtime_for_solo(self) -> None:
        settings = SimpleNamespace(
            openai_meeting_assistant_realtime_model="gpt-realtime",
            openai_meeting_assistant_model="gpt-4o-mini",
            meeting_assistant_stt_model=DEFAULT_TEST_STT_MODEL,
            meeting_assistant_stt_language="",
        )
        with patch.object(worker, "SETTINGS", settings):
            fingerprint = build_runtime_fingerprint(ASSISTANT_MODE_SOLO)

        self.assertTrue(fingerprint["workerFile"].endswith("meeting_agent/worker.py"))
        self.assertEqual(fingerprint["assistantResponseMode"], "realtime")
        self.assertEqual(fingerprint["assistantResponseModel"], "gpt-realtime")
        self.assertEqual(fingerprint["sttModel"], DEFAULT_TEST_STT_MODEL)
        self.assertEqual(fingerprint["languageMode"], "auto")
        self.assertEqual(fingerprint["turnDetection"], "livekit-audio-turn-detector")
        self.assertEqual(fingerprint["durableTranscriptSource"], "livekit-realtime-scribe-sidecar")
        self.assertEqual(
            fingerprint["turnHandling"]["turnDetection"],
            "livekit-audio-turn-detector",
        )

    def test_realtime_solo_fingerprint_uses_realtime_model_and_sidecar_transcript(self) -> None:
        settings = SimpleNamespace(
            openai_meeting_assistant_realtime_model="gpt-realtime",
            openai_meeting_assistant_model="gpt-4o-mini",
            meeting_assistant_stt_model=DEFAULT_TEST_STT_MODEL,
            meeting_assistant_stt_language="",
        )

        with patch.object(worker, "SETTINGS", settings):
            fingerprint = build_runtime_fingerprint(ASSISTANT_MODE_SOLO)

        self.assertEqual(fingerprint["assistantResponseMode"], "realtime")
        self.assertEqual(fingerprint["assistantResponseModel"], "gpt-realtime")
        self.assertEqual(fingerprint["sttModel"], DEFAULT_TEST_STT_MODEL)
        self.assertEqual(fingerprint["turnDetection"], "livekit-audio-turn-detector")
        self.assertEqual(
            fingerprint["turnHandling"]["providerTurnDetection"],
            "disabled",
        )
        self.assertEqual(fingerprint["durableTranscriptSource"], "livekit-realtime-scribe-sidecar")

    def test_group_mode_stays_pipeline(self) -> None:
        self.assertEqual(
            worker.get_assistant_response_mode_for_mode(ASSISTANT_MODE_GROUP),
            SOLO_RESPONSE_MODE_PIPELINE,
        )
        self.assertFalse(worker.is_solo_realtime_response_mode(ASSISTANT_MODE_GROUP))

    def test_realtime_solo_does_not_persist_session_user_transcript(self) -> None:
        self.assertFalse(should_persist_session_user_transcript(ASSISTANT_MODE_SOLO))
        self.assertFalse(should_persist_session_user_transcript(ASSISTANT_MODE_GROUP))

    def test_group_room_options_disable_agent_transcription_output(self) -> None:
        room_options = build_room_options_for_mode(ASSISTANT_MODE_GROUP, "participant-1")

        self.assertFalse(room_options.text_output)
        self.assertTrue(room_options.audio_output)
        self.assertEqual(room_options.participant_identity, "participant-1")
        self.assertFalse(room_options.close_on_disconnect)

    def test_solo_room_options_keep_agent_transcription_output(self) -> None:
        room_options = build_room_options_for_mode(ASSISTANT_MODE_SOLO, "participant-1")

        self.assertTrue(room_options.text_output.sync_transcription)
        self.assertTrue(room_options.audio_output)
        self.assertEqual(room_options.participant_identity, "participant-1")
        self.assertFalse(room_options.close_on_disconnect)

    def test_realtime_solo_does_not_stop_while_final_transcript_is_delayed(self) -> None:
        self.assertFalse(should_stop_on_empty_user_turn(ASSISTANT_MODE_SOLO))
        self.assertTrue(should_stop_on_empty_user_turn(ASSISTANT_MODE_GROUP))

    def test_realtime_solo_empty_provisional_turn_reaches_generation(self) -> None:
        agent = build_meeting_assistant_agent(
            "11111111-1111-1111-1111-111111111111",
            lambda: None,
            participant_names=["Personqc Personqd"],
            assistant_mode=ASSISTANT_MODE_SOLO,
        )
        message = SimpleNamespace(text_content="")

        # LiveKit invokes this hook before OpenAI emits the final realtime
        # transcript. Returning normally lets the SDK generate from the audio
        # it already committed to the realtime session.
        asyncio.run(agent.on_user_turn_completed(SimpleNamespace(), message))

    def test_agent_server_registers_meeting_entrypoint_and_request_handler(self) -> None:
        server = build_agent_server()

        self.assertEqual(server._agent_name, worker.SETTINGS.livekit_room_assistant_name)
        self.assertIs(server._entrypoint_fnc, worker.entrypoint)
        self.assertIs(server._request_fnc, worker.on_request)

    def test_realtime_solo_model_factory_uses_openai_realtime_config(self) -> None:
        settings = SimpleNamespace(
            openai_meeting_assistant_realtime_model="gpt-realtime",
            openai_meeting_assistant_voice="marin",
        )
        realtime_model = object()

        with patch.object(worker, "SETTINGS", settings), patch(
            "meeting_agent.worker.livekit_openai.realtime.RealtimeModel",
            return_value=realtime_model,
        ) as realtime_factory:
            result = build_meeting_assistant_realtime_model()

        self.assertIs(result, realtime_model)
        realtime_factory.assert_called_once()
        kwargs = realtime_factory.call_args.kwargs
        self.assertEqual(kwargs["model"], "gpt-realtime")
        self.assertEqual(kwargs["voice"], "marin")
        self.assertIsNone(kwargs["turn_detection"])
        self.assertEqual(kwargs["input_audio_noise_reduction"], "near_field")

    def test_generic_turn_style_hint_does_not_mutate_every_turn(self) -> None:
        self.assertIsNone(build_turn_response_style_hint("Tell me something useful."))


class LiveKitChatContextRecallTests(unittest.TestCase):
    def test_recent_context_hint_includes_turn_context_and_current_question(self) -> None:
        turn_ctx = FakeChatContext(
            make_message("user", "He came in around three minutes ago.", "m1"),
            make_message("assistant", "Got it.", "m2"),
        )
        new_message = make_message("user", "What time did he arrive?", "m3")

        hint = build_livekit_recent_context_hint(
            "What time did he arrive?",
            turn_ctx,
            new_message,
        )

        self.assertIsNotNone(hint)
        self.assertIn("He came in around three minutes ago.", hint or "")
        self.assertIn("What time did he arrive?", hint or "")
        self.assertIn("without saying the transcript is unavailable", hint or "")

    def test_recent_context_uses_session_history_when_turn_context_is_sparse(self) -> None:
        turn_ctx = FakeChatContext()
        session_history = FakeChatContext(
            make_message("user", "No niin, toimiiko nyt suomen kieli?", "m1"),
            make_message("assistant", "Kyllä, ymmärrän suomea.", "m2"),
        )
        new_message = make_message("user", "Mitä sanoin äsken?", "m3")

        rows = collect_livekit_chat_history_messages(
            turn_ctx,
            new_message,
            session_history=session_history,
        )
        hint = build_livekit_recent_context_hint(
            "Mitä sanoin äsken?",
            turn_ctx,
            new_message,
            session_history=session_history,
        )

        self.assertEqual([row["content"] for row in rows], [
            "No niin, toimiiko nyt suomen kieli?",
            "Kyllä, ymmärrän suomea.",
            "Mitä sanoin äsken?",
        ])
        self.assertIsNotNone(hint)
        self.assertIn("No niin, toimiiko nyt suomen kieli?", hint or "")

    def test_recent_context_hint_ignores_unrelated_questions(self) -> None:
        turn_ctx = FakeChatContext(
            make_message("user", "We should send the proposal tomorrow.", "m1"),
        )
        new_message = make_message("user", "What is the weather?", "m2")

        hint = build_livekit_recent_context_hint(
            "What is the weather?",
            turn_ctx,
            new_message,
        )

        self.assertIsNone(hint)


class MeetingToolsSoloFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_live_shared_screen_returns_vision_text_without_mutating_context(self):
        settings = SimpleNamespace(openai_api_key="test", openai_meeting_assistant_live_backend_model="gpt-5.6-luna")
        tools = MeetingTools("meeting-1", settings, AsyncMock(return_value=None), assistant_mode=ASSISTANT_MODE_SOLO)
        agent = SimpleNamespace(llm=SimpleNamespace(model="gpt-live-1"), update_chat_ctx=AsyncMock())
        context = SimpleNamespace(session=SimpleNamespace(current_agent=agent))
        client = AsyncMock()
        client.responses.create.return_value = SimpleNamespace(output_text="Issue READY-42 is visible.")
        client.__aenter__.return_value = client
        with patch.object(worker, "get_job_context", return_value=SimpleNamespace(room=object())), patch.object(
            worker, "capture_screen_share_image_data_url", AsyncMock(return_value="data:image/jpeg;base64,test")
        ), patch.object(worker.openai, "AsyncClient", return_value=client), patch.object(
            tools, "_require_tool_execution_context", AsyncMock(return_value=SimpleNamespace(requesting_user_id="personqc"))
        ), patch.object(worker, "CreditUsageContext", return_value=ProviderOnlyCreditUsage()):
            result = await tools.view_shared_screen(context, "Which issue is shown?")
            self.assertEqual(result["description"], "Issue READY-42 is visible.")
            self.assertEqual(client.responses.create.call_args.kwargs["input"][0]["content"][0]["text"], "Which issue is shown?")
            self.assertEqual(client.responses.create.call_args.kwargs["extra_body"], {"prompt_cache_options": {"mode": "explicit"}})
            agent.update_chat_ctx.assert_not_called()
            client.responses.create.side_effect = RuntimeError("vision unavailable")
            failed = await tools.view_shared_screen(context)
            self.assertEqual(failed["error"], "screen_analysis_failed")

    async def test_recent_transcript_works_without_active_push_to_talk_turn(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_SOLO,
        )

        with patch(
            "meeting_agent.worker.REPOSITORY.get_transcript_for_meeting",
            new=AsyncMock(
                return_value={
                    "segments": [
                        {
                            "speaker_name": "Personqc",
                            "speaker_role": "human",
                            "content": "Hei, testataan suomea.",
                            "started_at": None,
                        }
                    ]
                }
            ),
        ):
            transcript = await tools.get_recent_transcript()

        self.assertEqual(transcript["source"], "durable-db-fallback")
        self.assertEqual(transcript["segments"][0]["content"], "Hei, testataan suomea.")

    async def test_recap_transcript_reports_coverage_and_bounds_reads(self) -> None:
        tools = MeetingTools("meeting-1", object(), AsyncMock(return_value=None),
                             assistant_mode=ASSISTANT_MODE_SOLO)
        rows = [{"content": f"Decision {i}"} for i in range(250)]
        with patch.object(worker.REPOSITORY, "get_transcript_for_meeting",
                          AsyncMock(return_value={"segments": rows})) as read:
            result = await tools.get_recent_transcript(max_segments=10000)
            read.assert_awaited_once_with("meeting-1")
            self.assertEqual(len(result["segments"]), 200)
            self.assertEqual(result["totalSegments"], 250)
            self.assertEqual(result["omittedEarlierSegments"], 50)
            self.assertEqual(result["segments"][0]["content"], "Decision 50")
            bounded = await tools.get_recent_transcript(max_segments=0)
            self.assertEqual(len(bounded["segments"]), 1)
        with patch.object(worker.REPOSITORY, "get_transcript_for_meeting",
                          AsyncMock(return_value=None)):
            empty = await tools.get_recent_transcript()
            self.assertEqual(empty["status"], "empty")
            self.assertEqual(empty["totalSegments"], 0)
        with patch.object(worker.REPOSITORY, "get_transcript_for_meeting",
                          AsyncMock(side_effect=RuntimeError("database unavailable"))):
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                await tools.get_recent_transcript()

    async def test_solo_action_item_works_without_active_push_to_talk_turn(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_SOLO,
        )

        with patch(
            "meeting_agent.worker.REPOSITORY.create_action_item_for_meeting",
            new=AsyncMock(
                return_value={
                    "id": "item-1",
                    "text": "Email Personrb next week",
                    "assignee": None,
                    "status": "open",
                }
            ),
        ) as create_mock:
            result = await tools.add_action_item("Email Personrb next week")

        create_mock.assert_awaited_once_with("meeting-1", "Email Personrb next week", None)
        self.assertEqual(result["actionItem"]["text"], "Email Personrb next week")

    async def test_group_action_item_still_requires_push_to_talk_context(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_GROUP,
        )

        with self.assertRaisesRegex(RuntimeError, "No active personal agent turn"):
            await tools.add_action_item("Email Personrb next week")

    def test_solo_toolset_excludes_heavy_group_only_tools(self) -> None:
        group_prompt = worker.build_meeting_assistant_instructions(assistant_mode=ASSISTANT_MODE_GROUP)
        self.assertIn("get_recent_transcript with max_segments=200", group_prompt)
        solo_prompt = worker.build_meeting_assistant_instructions(assistant_mode=ASSISTANT_MODE_SOLO)
        self.assertNotIn("get_recent_transcript with max_segments=200", solo_prompt)
        self.assertIn("call answer_meeting_question once", solo_prompt)
        self.assertIn("Choose scope='recent'", solo_prompt)
        self.assertIn("Choose scope='full'", solo_prompt)
        self.assertIn("answer_meeting_question using scope='full'", solo_prompt)
        self.assertNotIn("Choose scope='recent'", group_prompt)
        solo_tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_SOLO,
        ).tools
        group_tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_GROUP,
        ).tools

        self.assertEqual(len(solo_tools), 9)
        self.assertEqual(len(group_tools), 9)
        disconnected_tool_ids = {getattr(tool, "id", None) for tool in group_tools}
        self.assertIn("get_calendar_status", disconnected_tool_ids)
        self.assertIn("show_tool_connect_panel", disconnected_tool_ids)
        solo_tool_ids = {getattr(tool, "id", None) for tool in solo_tools}
        self.assertIn("view_shared_screen", solo_tool_ids)
        self.assertIn("answer_meeting_question", solo_tool_ids)
        self.assertNotIn("answer_meeting_question", disconnected_tool_ids)
        self.assertNotIn("view_shared_screen", disconnected_tool_ids)

    def test_linear_tools_are_only_exposed_when_linear_is_connected(self) -> None:
        disconnected_tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_GROUP,
        ).tools
        connected_tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["linear"],
        ).tools

        self.assertEqual(len(disconnected_tools), 9)
        self.assertEqual(len(connected_tools), 14)
        connected_tool_ids = {getattr(tool, "id", None) for tool in connected_tools}
        self.assertIn("search_linear", connected_tool_ids)
        self.assertIn("prepare_linear_issue", connected_tool_ids)
        self.assertIn("confirm_linear_issue", connected_tool_ids)
        self.assertIn("confirm_linear_action", connected_tool_ids)
        self.assertIn("linear_run_batch", connected_tool_ids)

    def test_dynamic_linear_mcp_tools_are_exposed_when_catalog_present(self) -> None:
        toolset = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["linear"],
            linear_mcp_tools=[
                {
                    "name": "save_issue",
                    "description": "Create or update an issue.",
                    "inputSchema": {"type": "object", "properties": {}},
                },
                {
                    "name": "list_issue_statuses",
                    "description": "List issue workflow states.",
                    "inputSchema": {"type": "object", "properties": {}},
                },
            ],
        )
        tool_ids = {getattr(tool, "id", None) for tool in toolset.tools}
        self.assertIn("linear_save_issue", tool_ids)
        self.assertIn("linear_list_issue_statuses", tool_ids)
        # Agent.update_tools dedupes toolsets by id, so the base initializer
        # must have run (this was skipped historically).
        self.assertEqual(toolset.id, "meeting_tools")

    def test_linear_batch_result_stats_extracts_counts_and_failed_actions(self) -> None:
        stats = MeetingTools._linear_batch_result_stats(
            {
                "invocationId": "inv-1",
                "result": {
                    "tool": "batch",
                    "total": 3,
                    "succeeded": 2,
                    "failed": 1,
                    "results": [
                        {"action": "Mark REA-1 done", "ok": True},
                        {"action": "Mark REA-2 done", "ok": False, "error": "not found"},
                        {"action": "Mark REA-3 done", "ok": True},
                    ],
                },
            }
        )
        self.assertEqual(
            stats,
            {
                "total": 3,
                "succeeded": 2,
                "failed": 1,
                "failedActions": ["Mark REA-2 done"],
            },
        )
        # Single (non-batch) results carry no counts, so the panel treats the
        # completion as clean.
        self.assertIsNone(
            MeetingTools._linear_batch_result_stats({"invocationId": "inv-2", "result": {"ok": True}})
        )

    def test_calendar_read_tools_are_only_exposed_when_calendar_is_connected(self) -> None:
        disconnected_tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_GROUP,
        ).tools
        connected_tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["outlook_calendar"],
        ).tools

        disconnected_tool_ids = {getattr(tool, "id", None) for tool in disconnected_tools}
        connected_tool_ids = {getattr(tool, "id", None) for tool in connected_tools}
        self.assertNotIn("list_calendar_events", disconnected_tool_ids)
        self.assertNotIn("search_calendar_events", disconnected_tool_ids)
        self.assertNotIn("get_calendar_event", disconnected_tool_ids)
        self.assertIn("list_calendar_events", connected_tool_ids)
        self.assertIn("search_calendar_events", connected_tool_ids)
        self.assertIn("get_calendar_event", connected_tool_ids)

    async def test_view_shared_screen_reports_missing_screen_share(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_SOLO,
        )
        room = make_fake_room(
            make_fake_screen_share_publication(source=rtc.TrackSource.SOURCE_CAMERA)
        )
        run_context = SimpleNamespace(session=SimpleNamespace(current_agent=None))

        with patch(
            "meeting_agent.worker.get_job_context",
            return_value=SimpleNamespace(room=room),
        ):
            result = await tools.view_shared_screen(run_context)

        self.assertEqual(result["error"], "no_active_screen_share")

    def _make_snapshot_agent(self) -> SimpleNamespace:
        agent = SimpleNamespace(chat_ctx=ChatContext())

        async def apply_update(updated_ctx: ChatContext) -> None:
            agent.chat_ctx = updated_ctx

        agent.update_chat_ctx = AsyncMock(side_effect=apply_update)
        return agent

    @staticmethod
    def _snapshot_messages(chat_ctx: ChatContext) -> list[object]:
        return [
            item
            for item in chat_ctx.items
            if worker.is_solo_screen_snapshot_item(item)
        ]

    async def test_view_shared_screen_attaches_snapshot_to_chat_context(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_SOLO,
        )
        agent = self._make_snapshot_agent()
        agent.chat_ctx.add_message(
            role="user", content=["what do you think of this slide?"]
        )
        run_context = SimpleNamespace(session=SimpleNamespace(current_agent=agent))
        data_url = "data:image/jpeg;base64,ZmFrZS1ieXRlcw=="

        with patch(
            "meeting_agent.worker.get_job_context",
            return_value=SimpleNamespace(room=SimpleNamespace()),
        ), patch(
            "meeting_agent.worker.capture_screen_share_image_data_url",
            AsyncMock(return_value=data_url),
        ):
            result = await tools.view_shared_screen(run_context)

        self.assertEqual(result["status"], "screenshot_attached")
        agent.update_chat_ctx.assert_awaited_once()
        snapshots = self._snapshot_messages(agent.chat_ctx)
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].role, "user")
        self.assertEqual(snapshots[0].content[0], SOLO_SCREEN_SHARE_SNAPSHOT_MESSAGE)
        self.assertEqual(snapshots[0].content[1].image, data_url)
        self.assertEqual(len(agent.chat_ctx.items), 2)

    async def test_view_shared_screen_replaces_stale_snapshot(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_SOLO,
        )
        agent = self._make_snapshot_agent()
        run_context = SimpleNamespace(session=SimpleNamespace(current_agent=agent))
        first_url = "data:image/jpeg;base64,Zmlyc3Q="
        second_url = "data:image/jpeg;base64,c2Vjb25k"

        with patch(
            "meeting_agent.worker.get_job_context",
            return_value=SimpleNamespace(room=SimpleNamespace()),
        ), patch(
            "meeting_agent.worker.capture_screen_share_image_data_url",
            AsyncMock(side_effect=[first_url, second_url]),
        ):
            await tools.view_shared_screen(run_context)
            agent.chat_ctx.add_message(role="user", content=["and this new page?"])
            await tools.view_shared_screen(run_context)

        snapshots = self._snapshot_messages(agent.chat_ctx)
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0].content[1].image, second_url)

    async def test_turn_boundary_cleanup_clears_snapshot_but_keeps_conversation(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_SOLO,
        )
        agent = self._make_snapshot_agent()
        agent.chat_ctx.add_message(role="user", content=["look at this chart"])
        run_context = SimpleNamespace(session=SimpleNamespace(current_agent=agent))

        with patch(
            "meeting_agent.worker.get_job_context",
            return_value=SimpleNamespace(room=SimpleNamespace()),
        ), patch(
            "meeting_agent.worker.capture_screen_share_image_data_url",
            AsyncMock(return_value="data:image/jpeg;base64,ZmFrZS1ieXRlcw=="),
        ):
            await tools.view_shared_screen(run_context)

        removed = await worker.clear_solo_screen_snapshots_from_agent(agent)

        self.assertTrue(removed)
        self.assertEqual(len(self._snapshot_messages(agent.chat_ctx)), 0)
        self.assertEqual(len(agent.chat_ctx.items), 1)
        self.assertEqual(agent.update_chat_ctx.await_count, 2)

        removed_again = await worker.clear_solo_screen_snapshots_from_agent(agent)

        self.assertFalse(removed_again)
        self.assertEqual(agent.update_chat_ctx.await_count, 2)

    async def test_view_shared_screen_reports_missing_share_when_capture_fails(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=None),
            assistant_mode=ASSISTANT_MODE_SOLO,
        )
        run_context = SimpleNamespace(session=SimpleNamespace(current_agent=None))

        with patch(
            "meeting_agent.worker.get_job_context",
            return_value=SimpleNamespace(room=SimpleNamespace()),
        ), patch(
            "meeting_agent.worker.capture_screen_share_image_data_url",
            AsyncMock(side_effect=RuntimeError("track timeout")),
        ):
            result = await tools.view_shared_screen(run_context)

        self.assertEqual(result["error"], "no_active_screen_share")

    async def test_calendar_status_uses_personal_connectors(self) -> None:
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(
                return_value=TurnCapabilityContext(
                    active_turn=object(),
                    memories=[],
                    connectors=[
                        {"provider": "google_calendar", "status": "connected"},
                        {"provider": "outlook_calendar", "status": "disconnected"},
                    ],
                    tool_policies=[],
                )
            ),
            assistant_mode=ASSISTANT_MODE_GROUP,
        )

        status = await tools.get_calendar_status()

        self.assertTrue(status["connected"])
        self.assertEqual(status["connectedProviders"], ["google_calendar"])

    async def test_show_tool_connect_panel_uses_frontend_rpc_and_requester_context(self) -> None:
        owner_context = TurnOwnerContext(
            participant_identity="11111111-1111-4111-8111-111111111111:browser",
            user_id="11111111-1111-4111-8111-111111111111",
            display_name="Personqc",
            assistant_display_name="Personqc's agent",
        )
        capability_context = TurnCapabilityContext(
            active_turn=SimpleNamespace(owner_context=owner_context),
            memories=[],
            connectors=[],
            tool_policies=[],
        )
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=capability_context),
            assistant_mode=ASSISTANT_MODE_GROUP,
        )
        local_participant = SimpleNamespace(
            perform_rpc=AsyncMock(return_value=json.dumps({"status": "shown"}))
        )
        room = SimpleNamespace(local_participant=local_participant)

        with patch("meeting_agent.worker.get_job_context", return_value=SimpleNamespace(room=room)):
            result = await tools.show_tool_connect_panel(tool="Google Calendar")

        local_participant.perform_rpc.assert_awaited_once()
        call_kwargs = local_participant.perform_rpc.await_args.kwargs
        payload = json.loads(call_kwargs["payload"])
        self.assertEqual(call_kwargs["destination_identity"], "11111111-1111-4111-8111-111111111111:browser")
        self.assertEqual(call_kwargs["method"], "readymeet.tools.request_connection")
        self.assertEqual(payload["tool"], "calendar")
        self.assertEqual(payload["provider"], "google_calendar")
        self.assertEqual(payload["action"], None)
        self.assertEqual(payload["requestingUserId"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(result["status"], "shown")

    async def test_show_tool_connect_panel_allows_calendar_disable_without_provider(self) -> None:
        owner_context = TurnOwnerContext(
            participant_identity="11111111-1111-4111-8111-111111111111:browser",
            user_id="11111111-1111-4111-8111-111111111111",
            display_name="Personqc",
            assistant_display_name="Personqc's agent",
        )
        capability_context = TurnCapabilityContext(
            active_turn=SimpleNamespace(owner_context=owner_context),
            memories=[],
            connectors=[
                {"provider": "google_calendar", "status": "connected"},
            ],
            tool_policies=[],
        )
        tools = MeetingTools(
            "meeting-1",
            object(),
            AsyncMock(return_value=capability_context),
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["google_calendar"],
        )
        local_participant = SimpleNamespace(
            perform_rpc=AsyncMock(return_value=json.dumps({"status": "shown"}))
        )
        room = SimpleNamespace(local_participant=local_participant)

        with patch("meeting_agent.worker.get_job_context", return_value=SimpleNamespace(room=room)):
            result = await tools.show_tool_connect_panel(tool="calendar", action="disconnect")

        call_kwargs = local_participant.perform_rpc.await_args.kwargs
        payload = json.loads(call_kwargs["payload"])
        self.assertEqual(call_kwargs["method"], "readymeet.tools.request_connection")
        self.assertEqual(payload["tool"], "calendar")
        self.assertIsNone(payload["provider"])
        self.assertEqual(payload["action"], "disable")
        self.assertEqual(payload["requestingUserId"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(result["status"], "shown")

    async def test_show_tool_connect_panel_refuses_web_search_skill_request(self) -> None:
        get_capability_context = AsyncMock(return_value=None)
        tools = MeetingTools(
            "meeting-1",
            object(),
            get_capability_context,
            assistant_mode=ASSISTANT_MODE_GROUP,
        )

        result = await tools.show_tool_connect_panel(tool="Request web search")

        get_capability_context.assert_not_awaited()
        self.assertEqual(result["status"], "already_available")
        self.assertEqual(result["tool"], "web_search")

    def test_connected_provider_names_includes_calendar_connectors(self) -> None:
        context = TurnCapabilityContext(
            active_turn=object(),
            memories=[],
            connectors=[
                {"provider": "linear", "status": "connected"},
                {"provider": "google_calendar", "status": "connected"},
                {"provider": "outlook_calendar", "status": "disconnected"},
            ],
            tool_policies=[],
        )

        self.assertEqual(connected_provider_names(context), ["linear", "google_calendar"])

    def test_solo_web_search_survives_missing_default_access_bootstrap(self) -> None:
        original = worker.SETTINGS.openai_web_search_enabled
        object.__setattr__(worker.SETTINGS, "openai_web_search_enabled", True)
        try:
            self.assertTrue(is_web_search_allowed_for_mode(None, ASSISTANT_MODE_SOLO))
            self.assertFalse(is_web_search_allowed_for_mode(None, ASSISTANT_MODE_GROUP))

            missing_default_access_context = TurnCapabilityContext(
                active_turn=object(),
                memories=[],
                connectors=[],
                tool_policies=[],
            )
            self.assertTrue(
                is_web_search_allowed_for_mode(
                    missing_default_access_context,
                    ASSISTANT_MODE_SOLO,
                )
            )
            self.assertTrue(
                is_web_search_allowed_for_mode(
                    missing_default_access_context,
                    ASSISTANT_MODE_GROUP,
                )
            )
        finally:
            object.__setattr__(worker.SETTINGS, "openai_web_search_enabled", original)

    def test_solo_web_search_still_respects_explicit_disable(self) -> None:
        original = worker.SETTINGS.openai_web_search_enabled
        object.__setattr__(worker.SETTINGS, "openai_web_search_enabled", True)
        try:
            disabled_policy_context = TurnCapabilityContext(
                active_turn=object(),
                memories=[],
                connectors=[
                    {"provider": "web_search", "status": "connected"},
                ],
                tool_policies=[
                    {"tool_name": "web_search", "mode": "disabled", "config": {}},
                ],
            )
            disconnected_context = TurnCapabilityContext(
                active_turn=object(),
                memories=[],
                connectors=[
                    {"provider": "web_search", "status": "disconnected"},
                ],
                tool_policies=[],
            )

            self.assertFalse(
                is_web_search_allowed_for_mode(
                    disabled_policy_context,
                    ASSISTANT_MODE_SOLO,
                )
            )
            self.assertFalse(
                is_web_search_allowed_for_mode(
                    disconnected_context,
                    ASSISTANT_MODE_SOLO,
                )
            )
        finally:
            object.__setattr__(worker.SETTINGS, "openai_web_search_enabled", original)

    def test_solo_realtime_uses_function_web_search_tool(self) -> None:
        tools = build_meeting_assistant_tools(
            "meeting-1",
            AsyncMock(return_value=None),
            lambda: None,
            assistant_mode=ASSISTANT_MODE_SOLO,
            web_search_enabled=True,
        )
        tool_ids = {
            getattr(tool, "id", None)
            for toolset in tools
            for tool in getattr(toolset, "tools", [])
        }

        self.assertEqual(len(tools), 2)
        self.assertIn("web_search", tool_ids)
        self.assertNotIn("deepen_web_search", tool_ids)

    def test_group_pipeline_uses_function_web_search_tool(self) -> None:
        tools = build_meeting_assistant_tools(
            "meeting-1",
            AsyncMock(return_value=None),
            lambda: None,
            assistant_mode=ASSISTANT_MODE_GROUP,
            web_search_enabled=True,
        )
        tool_ids = {
            getattr(tool, "id", None)
            for toolset in tools
            for tool in getattr(toolset, "tools", [])
        }

        self.assertEqual(len(tools), 2)
        self.assertIn("web_search", tool_ids)
        self.assertNotIn("deepen_web_search", tool_ids)

    async def test_function_web_search_calls_broker_and_updates_frontend_panel(self) -> None:
        owner_context = TurnOwnerContext(
            participant_identity="11111111-1111-4111-8111-111111111111:browser",
            user_id="550e8400-e29b-41d4-a716-446655440010",
            display_name="Personqc",
            assistant_display_name="Personqc's agent",
        )
        capability_context = TurnCapabilityContext(
            active_turn=SimpleNamespace(owner_context=owner_context),
            memories=[],
            connectors=[
                {"provider": "web_search", "status": "connected"},
            ],
            tool_policies=[],
        )
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id="550e8400-e29b-41d4-a716-446655440001",
            utterance_id="utterance-web-1",
            requesting_user_id="550e8400-e29b-41d4-a716-446655440010",
            active_speaker_user_id="550e8400-e29b-41d4-a716-446655440010",
            agent_profile_id="550e8400-e29b-41d4-a716-446655440020",
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = WebSearchResearchTools(
            "550e8400-e29b-41d4-a716-446655440001",
            worker.SETTINGS,
            AsyncMock(return_value=capability_context),
            lambda: captured_context,
        )
        async_ctx = SimpleNamespace(update=AsyncMock())
        local_participant = SimpleNamespace(
            perform_rpc=AsyncMock(return_value=json.dumps({"status": "shown"}))
        )
        room = SimpleNamespace(local_participant=local_participant)

        with patch("meeting_agent.worker.get_job_context", return_value=SimpleNamespace(room=room)), patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(return_value={
                "result": {
                    "query": "weather in San Francisco today",
                    "mode": "search",
                    "status": "completed",
                    "searchId": "provider-search-1",
                    "researchRunId": "550e8400-e29b-41d4-a716-446655440030",
                    "answer": None,
                    "answerDisplay": {
                        "lead": "It is sunny in San Francisco.",
                        "confidence": "high",
                        "citationCoverage": "complete",
                        "sections": [
                            {
                                "paragraphs": [
                                    {
                                        "text": "It is sunny.",
                                        "bold": [],
                                        "citationIds": ["c1"],
                                    }
                                ]
                            }
                        ],
                        "citations": [
                            {
                                "id": "c1",
                                "label": "Forecast",
                                "title": "Forecast",
                                "url": "https://example.com/weather",
                                "domain": "example.com",
                            }
                        ],
                    },
                    "answerStatus": "not_requested",
                    "results": [
                        {
                            "kind": "source",
                            "title": "Forecast",
                            "url": "https://example.com/weather",
                            "domain": "example.com",
                            "publishDate": None,
                            "excerpt": "It is sunny."
                        }
                    ]
                }
            }),
        ) as broker_mock:
            result = await tools.search_web(async_ctx, "weather in San Francisco today")

        self.assertEqual(result["resultCount"], 1)
        self.assertEqual(result["mode"], "search")
        self.assertEqual(result["status"], "completed")
        self.assertIsNone(result["voiceAnswer"])
        self.assertEqual(result["answerDisplay"]["lead"], "It is sunny in San Francisco.")
        self.assertEqual(result["panel"], "pending")
        self.assertEqual(result["results"][0]["excerpt"], "It is sunny.")
        self.assertEqual(result["webSearchContext"]["answer"], "It is sunny in San Francisco.")
        self.assertIn("It is sunny.", result["webSearchContext"]["facts"])
        self.assertEqual(result["webSearchContext"]["sources"][0]["title"], "Forecast")
        self.assertIn("follow-up questions", result["webSearchContext"]["followupGuidance"])
        self.assertIn("your own reasoning", result["answerGuidance"])
        broker_payload = broker_mock.await_args.args[2]
        self.assertEqual(broker_payload["toolName"], "web_search")
        self.assertEqual(broker_payload["args"], {
            "query": "weather in San Francisco today",
            "deferPresentation": True,
            "limit": 8,
        })
        self.assertEqual(broker_mock.await_args.kwargs["timeout_s"], 75.0)
        self.assertGreaterEqual(local_participant.perform_rpc.await_count, 2)
        first_rpc = local_participant.perform_rpc.await_args_list[0].kwargs
        second_rpc = local_participant.perform_rpc.await_args_list[1].kwargs
        self.assertEqual(first_rpc["method"], "readymeet.web_search.show_results")
        self.assertEqual(json.loads(first_rpc["payload"])["status"], "searching")
        second_payload = json.loads(second_rpc["payload"])
        self.assertEqual(second_payload["status"], "partial")
        self.assertEqual(second_payload["searchId"], "utterance-web-1")
        self.assertEqual(
            second_payload["researchRunId"],
            "550e8400-e29b-41d4-a716-446655440030",
        )
        self.assertIsNone(second_payload.get("answer"))
        self.assertNotIn("answerDisplay", second_payload)
        self.assertNotIn("results", second_payload)

    async def test_function_web_search_surfaces_broker_limited_person_lookup(self) -> None:
        owner_context = TurnOwnerContext(
            participant_identity="11111111-1111-4111-8111-111111111111:browser",
            user_id="550e8400-e29b-41d4-a716-446655440010",
            display_name="Personqc",
            assistant_display_name="Personqc's agent",
        )
        capability_context = TurnCapabilityContext(
            active_turn=SimpleNamespace(owner_context=owner_context),
            memories=[],
            connectors=[
                {"provider": "web_search", "status": "connected"},
            ],
            tool_policies=[],
        )
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id="550e8400-e29b-41d4-a716-446655440001",
            utterance_id="utterance-web-private",
            requesting_user_id="550e8400-e29b-41d4-a716-446655440010",
            active_speaker_user_id="550e8400-e29b-41d4-a716-446655440010",
            agent_profile_id="550e8400-e29b-41d4-a716-446655440020",
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = WebSearchResearchTools(
            "550e8400-e29b-41d4-a716-446655440001",
            worker.SETTINGS,
            AsyncMock(return_value=capability_context),
            lambda: captured_context,
        )
        async_ctx = SimpleNamespace(update=AsyncMock())
        local_participant = SimpleNamespace(
            perform_rpc=AsyncMock(return_value=json.dumps({"status": "shown"}))
        )
        room = SimpleNamespace(local_participant=local_participant)

        with patch("meeting_agent.worker.get_job_context", return_value=SimpleNamespace(room=room)), patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(return_value={
                "result": {
                    "query": "find Personqy Public home address",
                    "mode": "blocked",
                    "status": "error",
                    "message": "I can search public professional information about people.",
                    "results": [],
                }
            }),
        ):
            result = await tools.search_web(async_ctx, "find Personqy Public home address")

        self.assertEqual(result["error"], "web_search_limited")
        self.assertEqual(result["panel"], "shown")
        error_rpc = local_participant.perform_rpc.await_args_list[1].kwargs
        self.assertEqual(json.loads(error_rpc["payload"])["status"], "error")

    async def test_function_web_search_opens_error_panel_when_broker_fails(self) -> None:
        owner_context = TurnOwnerContext(
            participant_identity="11111111-1111-4111-8111-111111111111:browser",
            user_id="550e8400-e29b-41d4-a716-446655440010",
            display_name="Personqc",
            assistant_display_name="Personqc's agent",
        )
        capability_context = TurnCapabilityContext(
            active_turn=SimpleNamespace(owner_context=owner_context),
            memories=[],
            connectors=[
                {"provider": "web_search", "status": "connected"},
            ],
            tool_policies=[],
        )
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id="550e8400-e29b-41d4-a716-446655440001",
            utterance_id="utterance-web-2",
            requesting_user_id="550e8400-e29b-41d4-a716-446655440010",
            active_speaker_user_id="550e8400-e29b-41d4-a716-446655440010",
            agent_profile_id="550e8400-e29b-41d4-a716-446655440020",
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = WebSearchResearchTools(
            "550e8400-e29b-41d4-a716-446655440001",
            worker.SETTINGS,
            AsyncMock(return_value=capability_context),
            lambda: captured_context,
        )
        async_ctx = SimpleNamespace(update=AsyncMock())
        local_participant = SimpleNamespace(
            perform_rpc=AsyncMock(return_value=json.dumps({"status": "shown"}))
        )
        room = SimpleNamespace(local_participant=local_participant)

        with patch("meeting_agent.worker.get_job_context", return_value=SimpleNamespace(room=room)), patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(side_effect=RuntimeError("Parallel is not configured for web search")),
        ):
            result = await tools.search_web(async_ctx, "latest React release")

        self.assertEqual(result["error"], "web_search_failed")
        self.assertEqual(local_participant.perform_rpc.await_count, 2)
        error_rpc = local_participant.perform_rpc.await_args_list[1].kwargs
        self.assertEqual(json.loads(error_rpc["payload"])["status"], "error")
        self.assertEqual(
            json.loads(error_rpc["payload"])["message"],
            "Web search is unavailable right now.",
        )

    async def test_linear_search_uses_captured_requesting_user_context(self) -> None:
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id="550e8400-e29b-41d4-a716-446655440001",
            utterance_id="utterance-personqc-1",
            requesting_user_id="550e8400-e29b-41d4-a716-446655440010",
            active_speaker_user_id="550e8400-e29b-41d4-a716-446655440010",
            agent_profile_id="550e8400-e29b-41d4-a716-446655440020",
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = MeetingTools(
            "550e8400-e29b-41d4-a716-446655440001",
            object(),
            AsyncMock(return_value=None),
            lambda: captured_context,
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["linear"],
        )

        with patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(return_value={"result": {"issues": []}}),
        ) as broker_mock:
            await tools.search_linear_issues("auth timeout")

        payload = broker_mock.await_args.args[2]
        self.assertEqual(payload["context"]["utteranceId"], "utterance-personqc-1")
        self.assertEqual(
            payload["context"]["requestingUserId"],
            "550e8400-e29b-41d4-a716-446655440010",
        )
        self.assertEqual(payload["toolName"], "linear.search")

    async def test_linear_search_serializes_uuid_context_values(self) -> None:
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id=UUID("550e8400-e29b-41d4-a716-446655440001"),
            utterance_id="utterance-personqc-uuid",
            requesting_user_id=UUID("550e8400-e29b-41d4-a716-446655440010"),
            active_speaker_user_id=UUID("550e8400-e29b-41d4-a716-446655440010"),
            agent_profile_id=UUID("550e8400-e29b-41d4-a716-446655440020"),
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = MeetingTools(
            "550e8400-e29b-41d4-a716-446655440001",
            object(),
            AsyncMock(return_value=None),
            lambda: captured_context,
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["linear"],
        )

        with patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(return_value={"result": {"results": []}}),
        ) as broker_mock:
            await tools.search_linear_issues("assigned to me")

        payload = broker_mock.await_args.args[2]
        self.assertEqual(payload["context"]["meetingId"], "550e8400-e29b-41d4-a716-446655440001")
        self.assertEqual(payload["context"]["requestingUserId"], "550e8400-e29b-41d4-a716-446655440010")
        self.assertEqual(payload["context"]["agentProfileId"], "550e8400-e29b-41d4-a716-446655440020")
        self.assertEqual(payload["user"]["id"], "550e8400-e29b-41d4-a716-446655440010")

    async def test_linear_search_keeps_voice_schema_simple(self) -> None:
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id="550e8400-e29b-41d4-a716-446655440001",
            utterance_id="utterance-personqc-2",
            requesting_user_id="550e8400-e29b-41d4-a716-446655440010",
            active_speaker_user_id="550e8400-e29b-41d4-a716-446655440010",
            agent_profile_id="550e8400-e29b-41d4-a716-446655440020",
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = MeetingTools(
            "550e8400-e29b-41d4-a716-446655440001",
            object(),
            AsyncMock(return_value=None),
            lambda: captured_context,
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["linear"],
        )

        with patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(return_value={"result": {"results": []}}),
        ) as broker_mock:
            await tools.search_linear_issues("Safari planning")

        payload = broker_mock.await_args.args[2]
        self.assertEqual(payload["toolName"], "linear.search")
        self.assertEqual(payload["args"], {"term": "Safari planning"})

    async def test_calendar_search_uses_captured_requesting_user_context(self) -> None:
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id="550e8400-e29b-41d4-a716-446655440001",
            utterance_id="utterance-calendar-1",
            requesting_user_id="550e8400-e29b-41d4-a716-446655440010",
            active_speaker_user_id="550e8400-e29b-41d4-a716-446655440010",
            agent_profile_id="550e8400-e29b-41d4-a716-446655440020",
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = MeetingTools(
            "550e8400-e29b-41d4-a716-446655440001",
            object(),
            AsyncMock(return_value=None),
            lambda: captured_context,
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["google_calendar"],
        )

        with patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(return_value={"result": {"events": []}}),
        ) as broker_mock:
            await tools.search_calendar_events("Safari planning", limit=3)

        payload = broker_mock.await_args.args[2]
        self.assertEqual(payload["context"]["utteranceId"], "utterance-calendar-1")
        self.assertEqual(
            payload["context"]["requestingUserId"],
            "550e8400-e29b-41d4-a716-446655440010",
        )
        self.assertEqual(payload["toolName"], "calendar.search_events")
        self.assertEqual(payload["args"], {"query": "Safari planning", "limit": 3})

    async def test_prepare_linear_issue_allows_natural_voice_request(self) -> None:
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id="550e8400-e29b-41d4-a716-446655440001",
            utterance_id="utterance-create-1",
            requesting_user_id="550e8400-e29b-41d4-a716-446655440010",
            active_speaker_user_id="550e8400-e29b-41d4-a716-446655440010",
            agent_profile_id="550e8400-e29b-41d4-a716-446655440020",
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = MeetingTools(
            "550e8400-e29b-41d4-a716-446655440001",
            object(),
            AsyncMock(return_value=None),
            lambda: captured_context,
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["linear"],
        )

        with patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(return_value={"pendingInvocationId": "pending-1"}),
        ) as broker_mock:
            await tools.prepare_linear_issue("Testing this now")

        payload = broker_mock.await_args.args[2]
        self.assertEqual(payload["toolName"], "linear.create_issue")
        self.assertEqual(payload["user"]["id"], "550e8400-e29b-41d4-a716-446655440010")
        self.assertEqual(payload["args"], {
            "title": "Testing this now",
            "description": "Testing this now",
        })
        self.assertIn(":default:testing this now", payload["idempotencyKey"])

    async def test_confirm_linear_issue_uses_last_prepared_invocation(self) -> None:
        captured_context = ToolExecutionContext(
            meeting_turn_id="550e8400-e29b-41d4-a716-446655440030",
            participant_identity="550e8400-e29b-41d4-a716-446655440010:browser",
            meeting_id="550e8400-e29b-41d4-a716-446655440001",
            utterance_id="utterance-create-2",
            requesting_user_id="550e8400-e29b-41d4-a716-446655440010",
            active_speaker_user_id="550e8400-e29b-41d4-a716-446655440010",
            agent_profile_id="550e8400-e29b-41d4-a716-446655440020",
            allowed_tool_scope="private",
            created_at="2026-05-05T20:00:00+00:00",
            requesting_user_display_name="Personqc",
        )
        tools = MeetingTools(
            "550e8400-e29b-41d4-a716-446655440001",
            object(),
            AsyncMock(return_value=None),
            lambda: captured_context,
            assistant_mode=ASSISTANT_MODE_GROUP,
            connected_providers=["linear"],
        )

        with patch(
            "meeting_agent.worker.call_agent_tool_broker",
            new=AsyncMock(side_effect=[
                {"pendingInvocationId": "550e8400-e29b-41d4-a716-446655440099"},
                {"result": {"issue": {"identifier": "REA-1"}}},
            ]),
        ) as broker_mock:
            await tools.prepare_linear_issue("Testing this now")
            await tools.confirm_linear_issue()

        confirm_payload = broker_mock.await_args_list[1].args[2]
        self.assertEqual(
            confirm_payload["pendingInvocationId"],
            "550e8400-e29b-41d4-a716-446655440099",
        )
        self.assertEqual(
            confirm_payload["confirmationActorUserId"],
            "550e8400-e29b-41d4-a716-446655440010",
        )

    async def test_session_human_transcript_persistence_skips_existing_livekit_row(self) -> None:
        item = SimpleNamespace(
            id="user-item-1",
            text_content="No niin, suomi toimii.",
            created_at=1_700_000_000,
            metrics={},
        )

        with patch(
            "meeting_agent.worker.REPOSITORY.get_transcript_for_meeting",
            new=AsyncMock(
                return_value={
                    "segments": [
                        {
                            "speaker_identity": "550e8400-e29b-41d4-a716-446655440000:browser",
                            "speaker_user_id": "550e8400-e29b-41d4-a716-446655440000",
                            "speaker_role": "human",
                            "source": "livekit-python-live",
                            "content": "No niin, suomi toimii.",
                            "started_at": None,
                        }
                    ]
                }
            ),
        ), patch(
            "meeting_agent.worker.REPOSITORY.append_transcript_segment",
            new=AsyncMock(),
        ) as append_mock:
            await persist_human_transcript_segment_from_session(
                meeting_id="meeting-1",
                speaker_identity="550e8400-e29b-41d4-a716-446655440000:browser",
                speaker_name="Personqc",
                speaker_user_id="550e8400-e29b-41d4-a716-446655440000",
                item=item,
                room_name="room-1",
            )

        append_mock.assert_not_awaited()

    async def test_skip_shared_transcript_flag_skips_persistence(self) -> None:
        user_item = SimpleNamespace(
            id="user-item-1",
            text_content="Can you help me prep?",
            created_at=1_700_000_000,
            metrics={},
        )
        assistant_item = SimpleNamespace(
            id="assistant-item-1",
            text_content="Yes. Start with the decision you want from the meeting.",
            created_at=1_700_000_001,
            metrics={},
        )

        with patch(
            "meeting_agent.worker.REPOSITORY.get_transcript_for_meeting",
            new=AsyncMock(),
        ) as transcript_mock, patch(
            "meeting_agent.worker.REPOSITORY.append_transcript_segment",
            new=AsyncMock(),
        ) as append_mock:
            await persist_human_transcript_segment_from_session(
                meeting_id="meeting-1",
                speaker_identity="550e8400-e29b-41d4-a716-446655440000:browser",
                speaker_name="Personqc",
                speaker_user_id="550e8400-e29b-41d4-a716-446655440000",
                item=user_item,
                room_name="room-1",
                skip_shared_transcript=True,
            )
            await persist_assistant_transcript_segment(
                "meeting-1",
                "readymeet-assistant",
                "Personqc's Assistant",
                assistant_item,
                "room-1",
                skip_shared_transcript=True,
            )

        transcript_mock.assert_not_awaited()
        append_mock.assert_not_awaited()


class MeetingAssistantSttGateWiringTests(unittest.TestCase):
    def _build_group_agent(self):
        with patch.object(worker, "build_meeting_assistant_stt", return_value=MagicMock()):
            return build_meeting_assistant_agent(
                "11111111-1111-1111-1111-111111111111",
                lambda: None,
                participant_names=["Personqc Personqd"],
                assistant_mode=worker.ASSISTANT_MODE_GROUP,
            )

    def test_gate_is_bypassed_when_disabled(self) -> None:
        with patch.object(
            worker,
            "build_meeting_assistant_stt_gate_settings",
            return_value=worker.SttActivityGateSettings(enabled=False),
        ):
            agent = self._build_group_agent()

        with patch.object(worker, "activity_gated_stt_stream") as gated:
            agent.stt_node(MagicMock(), MagicMock())

        gated.assert_not_called()

    def test_gate_wraps_group_stt_when_enabled(self) -> None:
        with patch.object(
            worker,
            "build_meeting_assistant_stt_gate_settings",
            return_value=worker.SttActivityGateSettings(
                enabled=True, idle_close_seconds=4.0
            ),
        ):
            agent = self._build_group_agent()

        with patch.object(worker, "activity_gated_stt_stream") as gated:
            agent.stt_node(MagicMock(), MagicMock())

        gated.assert_called_once()
        kwargs = gated.call_args.kwargs
        self.assertIs(kwargs["stt"], agent.stt)
        self.assertEqual(kwargs["settings"].idle_close_seconds, 4.0)

    def test_solo_realtime_agent_has_no_stt_to_gate(self) -> None:
        with patch.object(
            worker,
            "build_meeting_assistant_stt_gate_settings",
            return_value=worker.SttActivityGateSettings(enabled=True),
        ):
            agent = build_meeting_assistant_agent(
                "11111111-1111-1111-1111-111111111111",
                lambda: None,
                participant_names=["Personqc Personqd"],
                assistant_mode=ASSISTANT_MODE_SOLO,
            )

        # The realtime path has no STT node to gate; enabling the gate must not
        # make it try to wrap one.
        with patch.object(worker, "activity_gated_stt_stream") as gated:
            agent.stt_node(MagicMock(), MagicMock())

        gated.assert_not_called()


if __name__ == "__main__":
    unittest.main()






class SoloVoiceRosterTests(unittest.TestCase):
    def test_all_callers_count_even_before_user_metadata_is_available(self):
        owner = SimpleNamespace(attributes={}, kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD)
        guest = SimpleNamespace(attributes={}, kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD)
        agent = SimpleNamespace(attributes={}, kind=rtc.ParticipantKind.PARTICIPANT_KIND_AGENT)
        spoofed = SimpleNamespace(attributes={"assistantRole": "meeting-agent"},
                                  kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD)
        room = SimpleNamespace(remote_participants={"owner": owner, "agent": agent})
        self.assertTrue(worker.is_solo_voice_room(room))
        # A caller cannot hide by claiming the assistant role attribute.
        room.remote_participants["spoofed"] = spoofed
        self.assertFalse(worker.is_solo_voice_room(room))
        room.remote_participants.pop("spoofed")
        room.remote_participants["guest"] = guest
        self.assertFalse(worker.is_solo_voice_room(room))
        room.remote_participants.pop("guest")
        self.assertTrue(worker.is_solo_voice_room(room))
        room.remote_participants.pop("owner")
        self.assertFalse(worker.is_solo_voice_room(room))
