from __future__ import annotations

import ast
import inspect
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from openai.types.responses import ResponseFunctionToolCall

for key, value in {"ASSISTANT_SERVICE_SECRET": "test-secret", "LIVEKIT_URL": "wss://example.test",
                   "LIVEKIT_API_KEY": "test-key", "LIVEKIT_API_SECRET": "test-secret",
                   "OPENAI_API_KEY": "test-key", "ELEVEN_API_KEY": "test-key"}.items():
    os.environ.setdefault(key, value)

from meeting_agent import worker
from meeting_agent.api_repository import InsufficientAiCreditsError
from meeting_agent.credit_usage import CreditUsageContext


def entrypoint_functions(names, namespace):
    """Execute the real nested seams without connecting a LiveKit job."""
    tree = ast.parse(inspect.getsource(worker.entrypoint))
    functions = [node for node in tree.body[0].body
                 if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    class ClosureGlobals(ast.NodeTransformer):
        def visit_Nonlocal(self, node):
            return ast.copy_location(ast.Global(names=node.names), node)
    module = ClosureGlobals().visit(ast.Module(body=functions, type_ignores=[]))
    exec(compile(module, worker.__file__, "exec"), namespace)


class WorkerCreditUsageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.repository = SimpleNamespace(
            reserve_credit_usage=AsyncMock(return_value={"reservationId": "r1", "workspaceId": "w1",
                "included": False, "maxInputTokens": 128000, "maxOutputTokens": 8192}),
            settle_credit_usage=AsyncMock(), release_credit_usage=AsyncMock(),
            get_meeting_by_id=AsyncMock(return_value={"created_by_user_id": "host-member"}))
        self.scope = CreditUsageContext(self.repository, "meeting-1", "requesting-member", "meeting-agent-help")

    async def test_help_reserves_and_settles_every_tool_continuation_with_finite_cap(self):
        usage = {"input_tokens": 21, "output_tokens": 8}
        self.repository.reserve_credit_usage.side_effect = [
            {**self.repository.reserve_credit_usage.return_value, "reservationId": reservation_id}
            for reservation_id in ["call-1", "call-2"]]
        client = SimpleNamespace(close=AsyncMock(), responses=SimpleNamespace(create=AsyncMock(side_effect=[
            SimpleNamespace(usage=usage, output_text="", output=[ResponseFunctionToolCall(type="function_call",
                name="web_search", call_id="call-1", arguments='{"query":"launch news"}')]),
            SimpleNamespace(usage=usage, output_text="The launch is Friday.", output=[]),
        ])))
        with patch.object(worker.openai, "AsyncClient", return_value=client) as factory, patch.object(
            worker, "build_agent_help_messages", return_value=[]
        ):
            result = await worker.generate_agent_help_participation(
                SimpleNamespace(screen_share_image_data_url=None), credit_usage=self.scope,
                web_search_runner=AsyncMock(return_value={"answer": "Friday"}))
        self.assertEqual(result, "The launch is Friday.")
        self.assertEqual(factory.call_args.kwargs["max_retries"], 0)
        self.assertEqual(self.repository.reserve_credit_usage.await_count, 2)
        self.assertEqual(self.repository.settle_credit_usage.await_count, 2)
        self.assertEqual([call.kwargs["reservation_id"]
                          for call in self.repository.settle_credit_usage.await_args_list], ["call-1", "call-2"])
        self.assertTrue(all(call.kwargs["max_output_tokens"] == 8192
                            for call in client.responses.create.await_args_list))
        self.assertTrue(all(call.kwargs["user_id"] == "requesting-member"
                            for call in self.repository.reserve_credit_usage.await_args_list))

    async def test_help_denied_before_provider_fetch(self):
        self.repository.reserve_credit_usage.side_effect = InsufficientAiCreditsError()
        client = SimpleNamespace(close=AsyncMock(), responses=SimpleNamespace(create=AsyncMock()))
        with patch.object(worker.openai, "AsyncClient", return_value=client), patch.object(
            worker, "build_agent_help_messages", return_value=[]
        ):
            with self.assertRaises(InsufficientAiCreditsError):
                await worker.generate_agent_help_participation(
                    SimpleNamespace(screen_share_image_data_url=None), credit_usage=self.scope)
        client.responses.create.assert_not_awaited()

    async def test_paid_sessions_refused_before_start_for_pipeline_realtime_and_gpt_live(self):
        for mode in [worker.ASSISTANT_MODE_GROUP, worker.ASSISTANT_MODE_SOLO]:
            for response_mode in [worker.SOLO_RESPONSE_MODE_PIPELINE, worker.SOLO_RESPONSE_MODE_REALTIME, "gpt_live"]:
                with self.subTest(mode=mode, response_mode=response_mode):
                    session = SimpleNamespace(start=AsyncMock())
                    self.repository.reserve_credit_usage.reset_mock()
                    self.repository.reserve_credit_usage.side_effect = InsufficientAiCreditsError()
                    namespace = dict(vars(worker), REPOSITORY=self.repository, meeting_id="meeting-1",
                        ctx=SimpleNamespace(room=object()), collect_human_participant_names=lambda room: [],
                        build_agent_session_for_mode=lambda mode: session,
                        solo_turn={"value": SimpleNamespace(owner_context=SimpleNamespace(user_id="solo-member"))},
                        is_solo_realtime_response_mode=lambda mode: response_mode != worker.SOLO_RESPONSE_MODE_PIPELINE)
                    entrypoint_functions({"authorize_session_owner", "start_assistant_session"}, namespace)
                    with self.assertRaises(InsufficientAiCreditsError):
                        await namespace["start_assistant_session"](mode, SimpleNamespace(identity="unrelated-first-human"))
                    session.start.assert_not_awaited()
                    authorization = self.repository.reserve_credit_usage.await_args.kwargs
                    self.assertTrue(authorization["is_unbounded"])
                    self.assertEqual(authorization["user_id"],
                        "host-member" if mode == worker.ASSISTANT_MODE_GROUP else "solo-member")

    async def test_included_group_session_starts_with_host_authorization(self):
        self.repository.reserve_credit_usage.return_value = {
            "reservationId": "included-r", "workspaceId": "w1", "included": True,
            "maxInputTokens": None, "maxOutputTokens": None}
        session = SimpleNamespace(start=AsyncMock(), input=Mock(), output=Mock())
        namespace = dict(vars(worker), REPOSITORY=self.repository, meeting_id="meeting-1", room_name="room-1",
            ctx=SimpleNamespace(room=object()), collect_human_participant_names=lambda room: [],
            build_agent_session_for_mode=lambda mode: session, solo_turn={"value": None},
            conversation_mode_disconnect_revisions={}, assistant_mode={"value": worker.ASSISTANT_MODE_IDLE},
            session_started={"value": False}, attach_session_handlers=Mock(), attach_audio_output_handlers=Mock(),
            get_turn_capability_context=Mock(), get_captured_tool_execution_context=Mock(),
            handle_committed_user_turn=AsyncMock(), is_agent_intro_meeting=False,
            build_meeting_assistant_agent=Mock(return_value="agent"), build_room_options_for_mode=Mock(),
            local_participant=SimpleNamespace(identity="assistant"), set_assistant_presence=AsyncMock(),
            publish_assistant_presence=AsyncMock(), log_assistant_debug=AsyncMock())
        entrypoint_functions({"authorize_session_owner", "start_assistant_session"}, namespace)
        await namespace["start_assistant_session"](worker.ASSISTANT_MODE_GROUP, SimpleNamespace(identity="guest"))
        session.start.assert_awaited_once()
        self.assertTrue(namespace["session_started"]["value"])
        self.assertIn("host-member", session.ready_credit_authorizations)
        self.repository.settle_credit_usage.assert_not_awaited()

    async def test_group_owner_entitlement_checked_before_tools_or_audio_attach(self):
        self.repository.reserve_credit_usage.side_effect = InsufficientAiCreditsError()
        session = SimpleNamespace()
        capabilities = AsyncMock()
        namespace = dict(vars(worker), REPOSITORY=self.repository, meeting_id="meeting-1",
            require_session=lambda: session, get_turn_capability_context=capabilities,
            assistant_mode={"value": worker.ASSISTANT_MODE_GROUP})
        entrypoint_functions({"authorize_session_owner", "apply_active_agent"}, namespace)
        turn = SimpleNamespace(owner_context=SimpleNamespace(user_id="actual-owner"))
        with self.assertRaises(InsufficientAiCreditsError):
            await namespace["apply_active_agent"](turn)
        capabilities.assert_not_awaited()
        self.assertEqual(self.repository.reserve_credit_usage.await_args.kwargs["user_id"], "actual-owner")

    async def test_included_authorization_released_only_after_confirmed_session_close(self):
        reservation = {"reservationId": "included-r", "workspaceId": "w1", "included": True}
        session = SimpleNamespace(aclose=AsyncMock(), ready_credit_authorizations={
            "requesting-member": (self.scope, reservation)})
        namespace = dict(vars(worker), transcript_context_task=None)
        entrypoint_functions({"close_assistant_session"}, namespace)
        session.aclose.side_effect = RuntimeError("close unknown")
        with self.assertRaises(RuntimeError):
            await namespace["close_assistant_session"](session, drain=False)
        self.repository.release_credit_usage.assert_not_awaited()
        session.aclose.side_effect = None
        await namespace["close_assistant_session"](session, drain=False)
        self.repository.release_credit_usage.assert_awaited_once_with(
            reservation_id="included-r", workspace_id="w1", user_id="requesting-member")
        self.assertEqual(session.ready_credit_authorizations, {})

    def test_final_cleanup_awaits_session_close_and_authorization_release(self):
        tree = ast.parse(inspect.getsource(worker.entrypoint))
        cleanup = next(node for node in tree.body[0].body
                       if isinstance(node, ast.Try) and node.finalbody)
        calls = [node.value.func.id for statement in cleanup.finalbody for node in ast.walk(statement)
                 if isinstance(node, ast.Await) and isinstance(node.value, ast.Call)
                 and isinstance(node.value.func, ast.Name)]
        self.assertIn("close_assistant_session", calls)

    def test_raw_session_usage_reports_preserved_for_all_modes_and_repeated_snapshots(self):
        for mode in [worker.ASSISTANT_MODE_GROUP, worker.ASSISTANT_MODE_SOLO]:
            handlers = {}
            session = SimpleNamespace(on=lambda event, handler: handlers.update({event: handler}))
            logger = Mock()
            namespace = dict(vars(worker), LOGGER=logger, meeting_id="meeting-1", room_name="room-1",
                             session=session, assistant_mode={"value": mode})
            for name in ["on_error", "on_function_tools_executed", "on_conversation_item_added", "on_user_input_transcribed"]:
                namespace[name] = Mock()
            entrypoint_functions({"attach_session_handlers"}, namespace)
            namespace["attach_session_handlers"](session)
            usage = SimpleNamespace(type="gpt_live", model="gpt-live-1", session_duration=12.5,
                                    input_tokens=31, input_cached_tokens=3, output_tokens=8)
            event = SimpleNamespace(usage=SimpleNamespace(model_usage=[usage]))
            handlers["session_usage_updated"](event)
            handlers["session_usage_updated"](event)
            reports = [json.loads(call.args[1]) for call in logger.info.call_args_list]
            self.assertEqual(reports[0], reports[1])
            self.assertTrue(reports[0]["cumulative"])
            self.assertEqual(reports[0]["models"], [{"usageType": "gpt_live", "model": "gpt-live-1",
                "sessionSeconds": 12.5, "inputTokens": 31, "cachedInputTokens": 3, "outputTokens": 8}])
