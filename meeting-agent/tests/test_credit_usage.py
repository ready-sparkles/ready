from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import openai
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meeting_agent.api_repository import InsufficientAiCreditsError, MeetingAgentRepository
from meeting_agent.credit_usage import CreditSettlementError, CreditUsageContext, CreditUsageError
from meeting_agent.summary import SummaryGenerationInput, generate_summary_and_action_items


def reservation(*, included=False, **bounds):
    return {"reservationId": "reservation-1", "workspaceId": "workspace-1", "included": included,
            "maxInputTokens": 128000, "maxOutputTokens": 8192, **bounds}


def provider_response(**values):
    return SimpleNamespace(usage={"input_tokens": 101, "output_tokens": 23,
                                 "input_tokens_details": {"cached_tokens": 11}}, **values)


class CreditUsageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.repository = SimpleNamespace(
            reserve_credit_usage=AsyncMock(return_value=reservation()),
            settle_credit_usage=AsyncMock(), release_credit_usage=AsyncMock())
        self.scope = CreditUsageContext(self.repository, "meeting-1", "member-1", "meeting-agent-answer")
        self.client = SimpleNamespace(responses=SimpleNamespace(create=AsyncMock(return_value=provider_response())))
        self.request = {"model": "gpt-5.4-mini", "max_output_tokens": 8192, "input": "hello"}

    async def test_denied_reservation_never_reaches_provider(self):
        self.repository.reserve_credit_usage.side_effect = InsufficientAiCreditsError()
        with self.assertRaises(InsufficientAiCreditsError):
            await self.scope.create_response(self.client, **self.request)
        self.client.responses.create.assert_not_awaited()
        self.repository.release_credit_usage.assert_not_awaited()

    async def test_raw_usage_settles_once_with_authorized_identity(self):
        response = await self.scope.create_response(self.client, **self.request)
        self.assertEqual(response.usage["output_tokens"], 23)
        self.repository.reserve_credit_usage.assert_awaited_once_with(
            meeting_id="meeting-1", user_id="member-1", model="gpt-5.4-mini",
            feature="meeting-agent-answer", max_output_tokens=8192, is_unbounded=False,
            request_body=self.request)
        self.repository.settle_credit_usage.assert_awaited_once_with(
            reservation_id="reservation-1", workspace_id="workspace-1", user_id="member-1",
            usage={"input_tokens": 101, "output_tokens": 23, "input_tokens_details": {"cached_tokens": 11}})
        self.client.responses.create.assert_awaited_once_with(**self.request)
        self.repository.release_credit_usage.assert_not_awaited()

    async def test_cache_write_usage_reaches_api_without_repricing_in_python(self):
        response = provider_response()
        response.usage["input_tokens_details"]["cache_write_tokens"] = 7
        self.client.responses.create.return_value = response
        await self.scope.create_response(self.client, **self.request)
        usage = self.repository.settle_credit_usage.await_args.kwargs["usage"]
        self.assertEqual(usage["input_tokens_details"], {"cached_tokens": 11, "cache_write_tokens": 7})

    async def test_settlement_network_retry_reuses_identity_not_provider(self):
        self.repository.settle_credit_usage.side_effect = [httpx.ReadTimeout("lost reply"), None]
        with patch("meeting_agent.credit_usage.asyncio.sleep", new=AsyncMock()):
            await self.scope.create_response(self.client, **self.request)
        attempts = self.repository.settle_credit_usage.await_args_list
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.repository.reserve_credit_usage.assert_awaited_once()
        self.client.responses.create.assert_awaited_once()
        self.repository.release_credit_usage.assert_not_awaited()

    async def test_unresolved_settlement_keeps_hold_without_rebuying_work(self):
        self.repository.settle_credit_usage.side_effect = httpx.ReadTimeout("lost reply")
        with patch("meeting_agent.credit_usage.asyncio.sleep", new=AsyncMock()):
            with self.assertRaises(CreditSettlementError):
                await self.scope.create_response(self.client, **self.request)
        self.assertEqual(self.repository.settle_credit_usage.await_count, 3)
        self.client.responses.create.assert_awaited_once()
        self.repository.release_credit_usage.assert_not_awaited()

    async def test_unknown_provider_outcomes_and_missing_usage_keep_hold(self):
        for error in [httpx.ReadTimeout("timeout"), asyncio.CancelledError(), RuntimeError("disconnected")]:
            with self.subTest(error=type(error).__name__):
                self.client.responses.create.side_effect = error
                with self.assertRaises(type(error)):
                    await self.scope.create_response(self.client, **self.request)
        self.client.responses.create.side_effect = None
        self.client.responses.create.return_value = SimpleNamespace(output_text="consumed but usage absent")
        with self.assertRaises(CreditSettlementError):
            await self.scope.create_response(self.client, **self.request)
        self.repository.release_credit_usage.assert_not_awaited()
        self.repository.settle_credit_usage.assert_not_awaited()

    async def test_only_definitive_provider_rejection_releases(self):
        for status in [400, 401, 402, 403, 404, 413, 422, 429, 500, 408]:
            with self.subTest(status=status):
                self.repository.release_credit_usage.reset_mock()
                response = httpx.Response(status, request=httpx.Request("POST", "https://provider.test"))
                self.client.responses.create.side_effect = openai.APIStatusError("rejected", response=response, body=None)
                with self.assertRaises(openai.APIStatusError):
                    await self.scope.create_response(self.client, **self.request)
                self.assertEqual(self.repository.release_credit_usage.await_count, int(status in {400, 401, 402, 403, 404, 413, 422, 429}))
        self.repository.settle_credit_usage.assert_not_awaited()

    async def test_rejected_response_with_usage_settles_instead_of_releasing(self):
        response = httpx.Response(400, request=httpx.Request("POST", "https://provider.test"))
        self.client.responses.create.side_effect = openai.APIStatusError(
            "rejected", response=response, body={"usage": {"input_tokens": 12, "output_tokens": 0}})
        with self.assertRaises(openai.APIStatusError):
            await self.scope.create_response(self.client, **self.request)
        self.repository.release_credit_usage.assert_not_awaited()
        usage = self.repository.settle_credit_usage.await_args.kwargs["usage"]
        self.assertEqual(usage["input_tokens"], 12)
        self.assertEqual(usage["output_tokens"], 0)

    async def test_rejected_response_with_malformed_usage_keeps_hold(self):
        response = httpx.Response(422, request=httpx.Request("POST", "https://provider.test"))
        self.client.responses.create.side_effect = openai.APIStatusError(
            "rejected", response=response, body={"usage": {"input_tokens": "12", "output_tokens": 0}})
        with self.assertRaises(openai.APIStatusError):
            await self.scope.create_response(self.client, **self.request)
        self.repository.release_credit_usage.assert_not_awaited()
        self.repository.settle_credit_usage.assert_not_awaited()

    async def test_invalid_paid_bounds_release_before_fetch(self):
        for bounds in [{"maxInputTokens": None}, {"maxInputTokens": -1},
                       {"maxInputTokens": True}, {"maxOutputTokens": None}, {"maxOutputTokens": 1}]:
            self.repository.reserve_credit_usage.return_value = reservation(**bounds)
            with self.assertRaises(CreditUsageError):
                await self.scope.create_response(self.client, **self.request)
        self.client.responses.create.assert_not_awaited()
        self.assertEqual(self.repository.release_credit_usage.await_count, 5)

    async def test_zero_count_is_a_valid_paid_bound(self):
        self.repository.reserve_credit_usage.return_value = reservation(maxInputTokens=0)
        self.client.responses.create.return_value = SimpleNamespace(usage={"input_tokens": 0, "output_tokens": 23})
        await self.scope.create_response(self.client, **{**self.request, "input": []})
        self.client.responses.create.assert_awaited_once()
        self.repository.settle_credit_usage.assert_awaited_once()

    async def test_included_unpriced_text_preserves_api_policy_and_worker_output_cap(self):
        self.repository.reserve_credit_usage.return_value = reservation(
            included=True, maxInputTokens=None, maxOutputTokens=None)
        await self.scope.create_response(self.client, **self.request)
        self.assertEqual(self.client.responses.create.await_args.kwargs["max_output_tokens"], 8192)
        self.repository.settle_credit_usage.assert_awaited_once()

    async def test_unbounded_modalities_and_sessions_require_included_authorization(self):
        with self.assertRaises(CreditUsageError):
            await self.scope.create_response(self.client, is_unbounded=True, **self.request)
        with self.assertRaises(CreditUsageError):
            await self.scope.authorize_included_session("gpt-live-1")
        self.client.responses.create.assert_not_awaited()
        self.repository.reserve_credit_usage.return_value = reservation(
            included=True, maxInputTokens=None, maxOutputTokens=None)
        session = await self.scope.authorize_included_session("gpt-live-1")
        await self.scope.release_included_session(session)
        self.repository.reserve_credit_usage.assert_awaited_with(
            meeting_id="meeting-1", user_id="member-1", model="gpt-live-1",
            feature="meeting-agent-answer", is_unbounded=True)
        self.repository.settle_credit_usage.assert_not_awaited()

    async def test_unbounded_or_streaming_text_not_dispatched(self):
        for maximum in [None, 0, -1, True]:
            with self.assertRaises(CreditUsageError):
                await self.scope.create_response(self.client, **{**self.request, "max_output_tokens": maximum})
        with self.assertRaises(CreditUsageError):
            await self.scope.create_response(self.client, **self.request, stream=True)
        self.repository.reserve_credit_usage.assert_not_awaited()
        self.client.responses.create.assert_not_awaited()

    async def test_snapshot_survives_mutation_during_authorization(self):
        history = [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}]
        schema = {"format": {"type": "json_object"}}
        extra = {"prompt_cache_options": {"mode": "explicit"}}
        started, proceed = asyncio.Event(), asyncio.Event()

        async def authorize(**kwargs):
            started.set()
            await proceed.wait()
            # Even a repository mutating its argument cannot alter the generation snapshot.
            kwargs["request_body"]["input"].clear()
            return reservation()

        self.repository.reserve_credit_usage.side_effect = authorize
        task = asyncio.create_task(self.scope.create_response(
            self.client, **{**self.request, "input": history}, text=schema, extra_body=extra))
        await started.wait()
        authorized = self.repository.reserve_credit_usage.await_args.kwargs["request_body"]
        self.assertEqual(authorized["input"], history)
        history[0]["content"][0]["text"] = "changed"
        schema["format"]["type"] = "text"
        extra["prompt_cache_options"]["mode"] = "changed"
        proceed.set()
        await task
        self.client.responses.create.assert_awaited_once_with(
            **{**self.request, "input": [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}]},
            text={"format": {"type": "json_object"}},
            extra_body={"prompt_cache_options": {"mode": "explicit"}})

    async def test_pydantic_history_and_raw_sdk_json_match_authorized_body(self):
        history = [
            ResponseFunctionToolCall(id="fc-1", type="function_call", call_id="call-1",
                                     name="search", arguments='{"query":"launch"}', status="completed"),
            {"type": "function_call_output", "call_id": "call-1", "output": "Friday"},
            ResponseOutputMessage(id="msg-1", type="message", role="assistant", status="completed",
                                  content=[{"type": "output_text", "text": "Friday", "annotations": []}]),
        ]
        original = history[0].model_dump(mode="json", exclude_unset=True)
        seen = []

        def handle(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "resp-1", "object": "response", "created_at": 1,
                "model": "gpt-5.4-mini", "status": "completed", "output": [],
                "usage": {"input_tokens": 101, "output_tokens": 23, "total_tokens": 124}})

        async with openai.AsyncClient(api_key="test", max_retries=0,
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(handle))) as client:
            await self.scope.create_response(client, **{**self.request, "input": history},
                instructions="Help", tools=[{"type": "function", "name": "search", "parameters": {"type": "object"}}],
                text={"format": {"type": "json_object"}},
                extra_body={"prompt_cache_options": {"mode": "explicit"}, "reasoning": {"effort": "low"}},
                timeout=httpx.Timeout(10))
        authorized = self.repository.reserve_credit_usage.await_args.kwargs["request_body"]
        self.assertEqual(seen, [authorized])
        self.assertNotIn("timeout", authorized)
        self.assertNotIn("extra_body", authorized)
        self.assertEqual(authorized["input"][0], original)
        self.assertEqual(history[0].model_dump(mode="json", exclude_unset=True), original)
        self.assertIsInstance(history[2], ResponseOutputMessage)

    async def test_timeout_remains_only_a_transport_option(self):
        await self.scope.create_response(self.client, **self.request, timeout=20)
        self.client.responses.create.assert_awaited_once_with(**self.request, timeout=20)
        self.assertNotIn("timeout", self.repository.reserve_credit_usage.await_args.kwargs["request_body"])

    async def test_malformed_requests_fail_before_admission(self):
        cases = [
            {"input": object()}, {"input": [object()]}, {"input": {"text": "hello"}},
            {"input": [{1: "non-string key"}]}, {"temperature": float("nan")},
            {"temperature": float("inf")}, {"extra_body": {"model": "other"}},
            {"extra_body": {"input": "other"}}, {"extra_body": {"max_output_tokens": 1}},
            {"extra_body": {"stream": True}}, {"extra_body": {"unknown": "value"}},
            {"extra_body": []}, {"extra_body": {"prompt_cache_options": {"mode": "unknown"}}},
            {"extra_body": {"prompt_cache_options": {"mode": "explicit"}},
             "prompt_cache_options": {"mode": "explicit"}},
            {"extra_body": {"instructions": "changed"}, "instructions": "original"},
            {"extra_query": {}}, {"extra_headers": {}}, {"cast_to": dict}, {"unknown": "value"},
            {"stream": None}, {"stream": 0}, {"model": None},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides), self.assertRaises(CreditUsageError):
                await self.scope.create_response(self.client, **{**self.request, **overrides})
        self.repository.reserve_credit_usage.assert_not_awaited()
        self.client.responses.create.assert_not_awaited()

    async def test_included_image_does_not_request_counting(self):
        self.repository.reserve_credit_usage.return_value = reservation(
            included=True, maxInputTokens=None, maxOutputTokens=None)
        await self.scope.create_response(self.client, is_unbounded=True, **{**self.request,
            "input": [{"role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,AA=="}]}]})
        self.assertNotIn("request_body", self.repository.reserve_credit_usage.await_args.kwargs)
        self.client.responses.create.assert_awaited_once()

    async def test_summary_settles_successful_consumption_before_invalid_json_fallback(self):
        self.client.close = AsyncMock()
        self.client.responses.create.return_value = provider_response(output_text="not JSON")
        data = SummaryGenerationInput(meeting_id="meeting-1", model="gpt-5.4-mini", api_key="test",
            timeout_ms=1000, transcript=[
                {"speakerName": "Personbr", "content": "We agreed to launch on Friday after the release review."},
                {"speakerName": "Personah", "content": "I will prepare the release notes and finish testing."}])
        with patch("meeting_agent.summary.openai.AsyncClient", return_value=self.client) as factory:
            result = await generate_summary_and_action_items(data, credit_usage=self.scope)
        self.assertEqual(result.mode, "fallback")
        factory.assert_called_once_with(api_key="test", max_retries=0)
        self.repository.settle_credit_usage.assert_awaited_once()
        self.repository.release_credit_usage.assert_not_awaited()


class CreditBridgeProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_actions_use_existing_authenticated_result_envelope(self):
        seen = []
        def handle(request):
            seen.append((dict(request.headers), json.loads(request.content)))
            return httpx.Response(200, json={"result": reservation()})
        settings = SimpleNamespace(api_base_url="https://api.test", assistant_service_secret="secret")
        repository = MeetingAgentRepository(settings)
        for operation in [
            lambda: repository.reserve_credit_usage(meeting_id="meeting-1", user_id="member-1",
                model="gpt-5.4-mini", feature="meeting-agent-answer", max_output_tokens=8192, request_body=None),
            lambda: repository.settle_credit_usage(reservation_id="reservation-1", workspace_id="workspace-1",
                user_id="member-1", usage={"input_tokens": 101, "output_tokens": 23}),
            lambda: repository.release_credit_usage(reservation_id="reservation-1", workspace_id="workspace-1", user_id="member-1"),
        ]:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
            with patch("meeting_agent.api_repository.httpx.AsyncClient", return_value=client):
                result = await operation()
            self.assertEqual(result["reservationId"], "reservation-1")
        self.assertEqual([item[1]["action"] for item in seen],
                         ["reserveCreditUsage", "settleCreditUsage", "releaseCreditUsage"])
        self.assertTrue(all(item[0]["x-assistant-service-secret"] == "secret" for item in seen))
        self.assertEqual(seen[0][1], {"action": "reserveCreditUsage", "meetingId": "meeting-1",
            "userId": "member-1", "provider": "openai", "model": "gpt-5.4-mini",
            "feature": "meeting-agent-answer", "maxOutputTokens": 8192})
        self.assertEqual(seen[1][1]["usage"], {"input_tokens": 101, "output_tokens": 23})

    async def test_reservation_sends_request_body_but_no_claimed_count(self):
        seen = []
        body = {"model": "gpt-5.4-mini", "input": [], "max_output_tokens": 8192}
        repository = MeetingAgentRepository(SimpleNamespace(api_base_url="https://api.test", assistant_service_secret="secret"))

        def handle(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200, json={"result": reservation(maxInputTokens=0)})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with patch("meeting_agent.api_repository.httpx.AsyncClient", return_value=client):
            await repository.reserve_credit_usage(meeting_id="meeting-1", user_id="member-1",
                model=body["model"], feature="meeting-agent-answer", max_output_tokens=8192, request_body=body)
        self.assertEqual(seen, [{"action": "reserveCreditUsage", "meetingId": "meeting-1",
            "userId": "member-1", "provider": "openai", "model": body["model"],
            "feature": "meeting-agent-answer", "maxOutputTokens": 8192, "requestBody": body}])

    async def test_402_response_maps_to_existing_denial(self):
        repository = MeetingAgentRepository(SimpleNamespace(api_base_url="https://api.test", assistant_service_secret="secret"))
        for code in ["insufficient_credits", "unbounded_usage_not_supported"]:
            client = httpx.AsyncClient(transport=httpx.MockTransport(
                lambda request: httpx.Response(402, json={"code": code})))
            with patch("meeting_agent.api_repository.httpx.AsyncClient", return_value=client):
                with self.assertRaises(InsufficientAiCreditsError) as caught:
                    await repository.reserve_credit_usage(meeting_id="meeting-1", user_id="member-1",
                        model="gpt-live-1", feature="meeting-agent-session", is_unbounded=True)
            self.assertEqual(caught.exception.reason, code)
