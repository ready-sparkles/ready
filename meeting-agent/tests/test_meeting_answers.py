from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from credit_usage_fakes import ProviderOnlyCreditUsage
from meeting_agent import meeting_answers as answers

ANSWER = {"spokenAnswer": "We agreed to launch on Friday.", "lead": "Friday launch",
          "sections": [{"heading": "Decision", "bullets": ["Personbr confirmed Friday after revising Monday."]}]}


def response(value, status="completed"):
    return SimpleNamespace(status=status, output_text=json.dumps(value))


class AnalysisTests(unittest.IsolatedAsyncioTestCase):
    def client(self, create):
        client = SimpleNamespace(responses=SimpleNamespace(create=create))
        context = AsyncMock()
        context.__aenter__.return_value = client
        return context

    def timed_rows(self):
        now = datetime(2026, 9, 24, 12, tzinfo=timezone.utc)
        return now, [
            {"content": "EARLY launch plan", "started_at": now - timedelta(minutes=40)},
            {"content": "RECENT Personbd suggests Friday", "speaker_name": "Personbd",
             "started_at": now - timedelta(minutes=1)},
        ]

    async def test_recent_question_uses_one_small_call_and_reports_scope(self):
        now, rows = self.timed_rows()
        create = AsyncMock(return_value=response({**ANSWER, "needsEarlierContext": False}))
        with patch.object(answers.openai, "AsyncClient", return_value=self.client(create)), patch.object(
            answers, "transcript_chunks", wraps=answers.transcript_chunks
        ) as tokenize:
            result = await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=rows, question="What do you think of Personbd's suggestion?",
                model="test", api_key="test", scope="recent", requested_at=now)
        self.assertEqual(tokenize.call_count, 1)
        self.assertEqual(tokenize.call_args.args[0], [rows[1]])
        self.assertEqual(create.await_count, 1)
        self.assertNotIn("EARLY", create.call_args.kwargs["input"])
        self.assertIn("RECENT", create.call_args.kwargs["input"])
        self.assertEqual(result["coverage"]["scope"], "recent")
        self.assertEqual(result["coverage"]["savedSegments"], 1)
        self.assertEqual(result["coverage"]["availableSegments"], 2)

    async def test_insufficient_recent_evidence_expands_once_without_publishing_partial_answer(self):
        now, rows = self.timed_rows()
        create = AsyncMock(side_effect=[response({"needsEarlierContext": True}), response(ANSWER)])
        with patch.object(answers.openai, "AsyncClient", return_value=self.client(create)):
            result = await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=rows, question="How does that compare with the original plan?",
                model="test", api_key="test", scope="recent", requested_at=now)
        self.assertEqual(create.await_count, 2)
        self.assertIn("EARLY", create.call_args.kwargs["input"])
        self.assertEqual(result["coverage"]["scope"], "full")
        self.assertTrue(result["coverage"]["expandedFromRecent"])

    async def test_full_is_default_and_does_not_pay_for_recent_probe(self):
        now, rows = self.timed_rows()
        create = AsyncMock(return_value=response(ANSWER))
        with patch.object(answers.openai, "AsyncClient", return_value=self.client(create)):
            result = await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=rows, question="Summarize the whole meeting",
                model="test", api_key="test", requested_at=now)
        self.assertEqual(create.await_count, 1)
        self.assertIn("EARLY", create.call_args.kwargs["input"])
        self.assertEqual(result["coverage"]["scope"], "full")

    async def test_recent_errors_or_ambiguous_flags_never_trigger_another_paid_call(self):
        now, rows = self.timed_rows()
        for value in [RuntimeError("offline"), response(ANSWER, "incomplete"), response(ANSWER),
                      response({**ANSWER, "needsEarlierContext": "false"}),
                      response({**ANSWER, "needsEarlierContext": None})]:
            with self.subTest(value=value):
                create = AsyncMock(side_effect=value) if isinstance(value, Exception) else AsyncMock(return_value=value)
                with patch.object(answers.openai, "AsyncClient", return_value=self.client(create)):
                    with self.assertRaises(Exception):
                        await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=rows, question="What about that?",
                            model="test", api_key="test", scope="recent", requested_at=now)
                self.assertEqual(create.await_count, 1)

    async def test_missing_or_stale_timestamps_use_full_without_recent_probe(self):
        now, rows = self.timed_rows()
        cases = [[{**rows[0], "started_at": None}, rows[1]], [rows[0]],
                 [{**rows[0], "started_at": "bad"}, rows[1]],
                 [{**rows[0], "started_at": now + timedelta(minutes=5)}, rows[1]]]
        for input_rows in cases:
            create = AsyncMock(return_value=response(ANSWER))
            with patch.object(answers.openai, "AsyncClient", return_value=self.client(create)):
                result = await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=input_rows, question="What about that?",
                    model="test", api_key="test", scope="recent", requested_at=now)
            self.assertEqual(create.await_count, 1)
            self.assertEqual(result["coverage"]["scope"], "full")

    def test_recent_window_keeps_crossing_segments_and_supports_both_timestamp_shapes(self):
        now, rows = self.timed_rows()
        crossing = {"content": "CROSSING", "startedAt": (now - timedelta(minutes=6)).isoformat(),
                    "endedAt": (now - timedelta(minutes=4)).isoformat()}
        boundary = {"content": "BOUNDARY", "started_at": now - timedelta(minutes=5)}
        selected = answers.recent_transcript_rows([rows[0], crossing, boundary, rows[1]], now)
        self.assertEqual(selected, [crossing, boundary, rows[1]])

    async def test_short_meeting_and_busy_window_skip_probe_without_truncating(self):
        now, rows = self.timed_rows()
        busy = [{**rows[1], "content": "BUSY discussion. " * 300}]
        for input_rows in [[rows[1]], [rows[0], *busy]]:
            create = AsyncMock(return_value=response(ANSWER))
            with patch.object(answers, "RECENT_TOKEN_BUDGET", 150), patch.object(
                answers.openai, "AsyncClient", return_value=self.client(create)
            ):
                result = await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=input_rows, question="What about that?",
                    model="test", api_key="test", scope="recent", requested_at=now)
            self.assertEqual(create.await_count, 1)
            self.assertEqual(result["coverage"]["scope"], "full")
            for row in input_rows:
                self.assertIn(row["content"].strip(), json.loads(create.call_args.kwargs["input"])["meetingEvidence"])

    async def test_recent_timeout_and_cancellation_never_expand(self):
        now, rows = self.timed_rows()
        for cancel in [False, True]:
            started, stopped = asyncio.Event(), asyncio.Event()
            async def slow(**kwargs):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    stopped.set()
            create = AsyncMock(side_effect=slow)
            with patch.object(answers, "RECENT_ANALYSIS_TIMEOUT_SECONDS", 60 if cancel else 0.01), patch.object(
                answers.openai, "AsyncClient", return_value=self.client(create)
            ):
                task = asyncio.create_task(answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=rows, question="What about that?",
                    model="test", api_key="test", scope="recent", requested_at=now))
                await started.wait()
                if cancel:
                    task.cancel()
                with self.assertRaises(asyncio.CancelledError if cancel else TimeoutError):
                    await task
            self.assertTrue(stopped.is_set())
            self.assertEqual(create.await_count, 1)

    def test_chunks_preserve_every_segment_and_unicode(self):
        rows = [{"id": str(i), "speaker_name": "Personbd", "content": f"Decision-{i} öä日本語 " * 8}
                for i in range(12)]
        rows.insert(1, {"content": "Please summarize our action items: Friday launch."})
        chunks = answers.transcript_chunks(rows, chunk_tokens=120)
        text = "".join(chunks)
        for i in range(12):
            self.assertEqual(text.count(f"Decision-{i} "), 8)
        self.assertIn("summarize our action items", text)
        self.assertNotIn("\ufffd", text)
        encoding = answers.tiktoken.get_encoding("o200k_base")
        self.assertTrue(all(len(encoding.encode(chunk)) <= 120 for chunk in chunks))

    async def test_reads_late_discussion_beyond_old_character_cap(self):
        rows = [{"content": "Early discussion. " * 1800}, {"content": "LATE: Friday replaces Monday."}]
        create = AsyncMock(return_value=response(ANSWER))
        with patch.object(answers.openai, "AsyncClient", return_value=self.client(create)) as constructor:
            result = await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=rows, question="When is launch?", model="gpt-5.6-luna", api_key="test")
        self.assertIn("LATE: Friday", create.call_args.kwargs["input"])
        self.assertEqual(result["coverage"]["savedSegments"], 2)
        self.assertEqual(create.await_count, 1)
        self.assertEqual(constructor.call_args.kwargs["max_retries"], 0)
        self.assertEqual(create.call_args.kwargs["reasoning"], {"effort": "low"})
        self.assertNotIn('maxLength', json.dumps(create.call_args.kwargs['text']['format']['schema']))

    def test_long_meeting_budget_scales_but_has_a_hard_ceiling(self):
        self.assertEqual(answers.analysis_timeout_seconds(1), 90)
        self.assertGreater(answers.analysis_timeout_seconds(6), answers.analysis_timeout_seconds(2))
        self.assertLessEqual(answers.analysis_timeout_seconds(16), 300)

    async def test_all_sections_reviewed_then_synthesized_in_order(self):
        async def create(**kwargs):
            schema_name = kwargs["text"]["format"]["name"]
            if schema_name == "meeting_evidence":
                text = json.loads(kwargs["input"])["meetingEvidence"]
                return response({"evidence": "Evidence: " + text})
            return response(ANSWER)
        create_mock = AsyncMock(side_effect=create)
        with patch.object(answers, "transcript_chunks", return_value=["early", "middle", "late"]), patch.object(
            answers.openai, "AsyncClient", return_value=self.client(create_mock)
        ):
            result = await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=[{"content": "test"}], question="Recap", model="test", api_key="test")
        self.assertEqual(create_mock.await_count, 4)
        final_input = json.loads(create_mock.call_args.kwargs["input"])
        self.assertEqual(json.loads(final_input["meetingEvidence"]), ["Evidence: early", "Evidence: middle", "Evidence: late"])
        self.assertEqual(result["coverage"]["sectionsReviewed"], 3)

    async def test_failed_section_never_produces_partial_answer_or_retries(self):
        create = AsyncMock(side_effect=RuntimeError("provider unavailable"))
        with patch.object(answers, "transcript_chunks", return_value=["early", "late"]), patch.object(
            answers.openai, "AsyncClient", return_value=self.client(create)
        ):
            with self.assertRaises(ExceptionGroup):
                await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=[], question="Recap", model="test", api_key="test")
        self.assertTrue(all(call.kwargs["text"]["format"]["name"] == "meeting_evidence" for call in create.call_args_list))
        self.assertLessEqual(create.await_count, 2)

    async def test_incomplete_or_empty_input_never_fabricates_fallback(self):
        create = AsyncMock(return_value=response(ANSWER, status="incomplete"))
        with patch.object(answers.openai, "AsyncClient", return_value=self.client(create)):
            with self.assertRaisesRegex(answers.MeetingAnswerError, "transcript_not_ready"):
                await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=[], question="Recap", model="test", api_key="test")
            create.assert_not_awaited()
            with self.assertRaisesRegex(answers.MeetingAnswerError, "incomplete_answer"):
                await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=[{"content": "test"}], question="Recap", model="test", api_key="test")
            self.assertEqual(create.await_count, 1)

    async def test_deadline_cancels_slow_provider_without_retrying(self):
        cancelled = asyncio.Event()
        async def slow(**kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        create = AsyncMock(side_effect=slow)
        with patch.object(answers, "analysis_timeout_seconds", return_value=0.01), patch.object(
            answers.openai, "AsyncClient", return_value=self.client(create)
        ):
            with self.assertRaises(TimeoutError):
                await answers.analyze_meeting(credit_usage=ProviderOnlyCreditUsage(), rows=[{"content": "test"}], question="Recap", model="test", api_key="test")
        self.assertTrue(cancelled.is_set())
        self.assertEqual(create.await_count, 1)


class ToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for key, value in {
            "DATABASE_URL": "postgresql://readymeet.test/readymeet", "LIVEKIT_URL": "wss://example.livekit.cloud",
            "LIVEKIT_API_KEY": "test", "LIVEKIT_API_SECRET": "test", "OPENAI_API_KEY": "test",
            "ELEVEN_API_KEY": "test", "ASSISTANT_SERVICE_SECRET": "test",
        }.items():
            os.environ.setdefault(key, value)
        from meeting_agent import worker
        self.worker = worker
        self.progress_agent = SimpleNamespace(llm=SimpleNamespace(model="gpt-live-1"),
                                              duplex_session=SimpleNamespace(send_event=Mock()))
        self.run_context = SimpleNamespace(session=SimpleNamespace(current_agent=self.progress_agent,
                                              user_state="listening", agent_state="listening"))
        self.context = SimpleNamespace(requesting_user_id="user", meeting_turn_id="turn", utterance_id="utterance",
            participant_identity="participant", requesting_user_display_name="Personbr", meeting_id="meeting")
        self.tools = worker.MeetingTools("meeting", worker.SETTINGS, AsyncMock(return_value=None),
                                         lambda: self.context, assistant_mode=worker.ASSISTANT_MODE_SOLO)
        self.analyze = AsyncMock(return_value={**ANSWER, "coverage": {"savedSegments": 1000, "sectionsReviewed": 2}})
        self.panel = AsyncMock(return_value={"status": "shown"})
        self.patches = [
            patch.object(worker, "analyze_meeting", self.analyze),
            patch.object(worker, "show_web_search_panel_for_meeting", self.panel),
            patch.object(worker.REPOSITORY, "get_meeting_by_id", AsyncMock(return_value={"status": "active"})),
            patch.object(worker.REPOSITORY, "get_transcript_for_meeting", AsyncMock(return_value={"segments": [{"content": "test"}]})),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    async def test_duplicate_tools_share_paid_work_and_only_short_answer_returns_to_voice(self):
        first, second = await asyncio.gather(self.tools.answer_meeting_question("Recap", self.run_context), self.tools.answer_meeting_question("Recap", self.run_context))
        self.assertEqual(first, second)
        self.assertEqual(self.analyze.await_count, 1)
        self.assertIn("spokenAnswer", first)
        self.assertNotIn("sections", first)
        self.assertTrue(first["panelShown"])
        final = self.panel.call_args.kwargs["payload"]
        self.assertEqual(final["contentKind"], "meeting-answer")
        self.assertEqual(final["answerDisplay"]["sections"][0]["bullets"][0]["text"], ANSWER["sections"][0]["bullets"][0])

    async def test_recent_scope_reaches_analysis_and_panel_is_labelled_without_duplicate_work(self):
        self.analyze.return_value = {**ANSWER, "coverage": {"scope": "recent", "savedSegments": 3}}
        first = await self.tools.answer_meeting_question("What do you think of Personbd's point?", self.run_context, "recent")
        second = await self.tools.answer_meeting_question("What do you think of Personbd's point?", self.run_context, "recent")
        self.assertEqual(first, second)
        self.assertEqual(self.analyze.await_count, 1)
        self.assertEqual(self.analyze.call_args.kwargs["scope"], "recent")
        self.assertIsInstance(self.analyze.call_args.kwargs["requested_at"], datetime)
        self.assertIn("last five minutes", self.panel.call_args.kwargs["payload"]["message"])
        self.assertIn("coverage.scope", first["instruction"])

    async def test_followup_before_final_transcription_does_not_reuse_previous_answer(self):
        first = await self.tools.answer_meeting_question("Who owns the task?", self.run_context)
        self.analyze.return_value = {**ANSWER, "spokenAnswer": "Friday.",
                                    "coverage": {"scope": "full"}}
        second = await self.tools.answer_meeting_question("When is it due?", self.run_context)
        self.assertEqual(self.analyze.await_count, 2)
        self.assertNotEqual(first["spokenAnswer"], second["spokenAnswer"])
        self.assertEqual(second["spokenAnswer"], "Friday.")

    async def test_changed_scope_does_not_reuse_recent_answer(self):
        await self.tools.answer_meeting_question("What was decided?", self.run_context, "recent")
        await self.tools.answer_meeting_question("What was decided?", self.run_context, "full")
        self.assertEqual(self.analyze.await_count, 2)
        self.assertEqual(self.analyze.call_args.kwargs["scope"], "full")

    def test_scope_is_exposed_as_an_enum_in_livekit_tool_schema(self):
        from livekit.agents.llm.utils import build_strict_openai_schema
        schema = build_strict_openai_schema(self.tools.answer_meeting_question)["function"]["parameters"]
        encoded = json.dumps(schema["properties"]["scope"])
        self.assertIn('"recent"', encoded)
        self.assertIn('"full"', encoded)
        self.assertNotIn("ctx", schema["properties"])

    async def test_failed_request_is_cached_until_a_new_utterance(self):
        self.analyze.side_effect = RuntimeError("test")
        await self.tools.answer_meeting_question("Recap", self.run_context)
        await self.tools.answer_meeting_question("Recap", self.run_context)
        self.assertEqual(self.analyze.await_count, 1)
        self.context.utterance_id = "new-utterance"
        await self.tools.answer_meeting_question("Recap", self.run_context)
        self.assertEqual(self.analyze.await_count, 2)

    async def test_progress_stops_before_completed_panel_and_does_not_reinvoke_analysis(self):
        started, stopped = asyncio.Event(), asyncio.Event()
        async def progress(session, still_current, send):
            self.assertTrue(await still_current())
            send('Still reviewing.')
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        async def analyze(**kwargs):
            await started.wait()
            return {**ANSWER, "coverage": {"savedSegments": 1, "sectionsReviewed": 1}}
        async def panel(**kwargs):
            if kwargs['payload']['status'] == 'completed':
                self.assertTrue(stopped.is_set())
            return {'status': 'shown'}
        self.analyze.side_effect = analyze
        self.panel.side_effect = panel
        with patch.object(self.worker, 'report_answer_progress', progress):
            result = await self.tools.answer_meeting_question('Recap', self.run_context)
        self.assertEqual(result['status'], 'completed')
        event = self.progress_agent.duplex_session.send_event.call_args.args[0]
        self.assertEqual(event['type'], 'session.commentary.append')
        self.assertIsNone(event['delegation_id'])
        self.assertEqual(self.analyze.await_count, 1)

    async def test_changed_owner_never_receives_late_success(self):
        async def change_owner(**kwargs):
            self.context = SimpleNamespace(**{**vars(self.context), "requesting_user_id": "someone-else"})
            return {**ANSWER, "coverage": {}}
        self.analyze.side_effect = change_owner
        result = await self.tools.answer_meeting_question("Recap", self.run_context)
        self.assertEqual(result["error"], "meeting_answer_failed")
        self.assertFalse(any(call.kwargs["payload"]["status"] == "completed" for call in self.panel.call_args_list))

    async def test_closing_toolset_cancels_provider_work(self):
        started = asyncio.Event()
        async def slow(**kwargs):
            started.set()
            await asyncio.Event().wait()
        self.analyze.side_effect = slow
        task = asyncio.create_task(self.tools.answer_meeting_question("Recap", self.run_context))
        await started.wait()
        await self.tools.aclose()
        self.assertTrue(task.cancelled())
        repeated = await self.tools.answer_meeting_question("Recap", self.run_context)
        self.assertEqual(repeated["error"], "meeting_answer_cancelled")
        self.assertEqual(self.analyze.await_count, 1)

    async def test_ended_meeting_never_starts_paid_work(self):
        self.worker.REPOSITORY.get_meeting_by_id.return_value = {"status": "ended"}
        result = await self.tools.answer_meeting_question("Recap", self.run_context)
        self.assertEqual(result["error"], "meeting_answer_failed")
        self.analyze.assert_not_awaited()

    async def test_panel_failure_does_not_retry_model_or_claim_panel_is_visible(self):
        self.panel.return_value = {"status": "error"}
        result = await self.tools.answer_meeting_question("Recap", self.run_context)
        self.assertFalse(result["panelShown"])
        self.assertEqual(result["spokenAnswer"], ANSWER["spokenAnswer"])
        self.assertEqual(self.analyze.await_count, 1)

    async def test_panel_is_only_sent_to_requester_using_its_own_rpc(self):
        # Exercise the real sender rather than its stub above.
        self.patches[1].stop()
        try:
            sender = self.worker.show_web_search_panel_for_meeting
            rpc = AsyncMock(return_value='{"status":"shown"}')
            room = SimpleNamespace(local_participant=SimpleNamespace(perform_rpc=rpc),
                remote_participants={"other": SimpleNamespace(identity="other")})
            with patch.object(self.worker, "get_job_context", return_value=SimpleNamespace(room=room)), patch.object(
                self.worker, "is_human_meeting_participant", return_value=True
            ):
                await sender(meeting_id="meeting", owner_context=SimpleNamespace(participant_identity="owner"),
                             payload={"contentKind": "meeting-answer", "status": "searching", "query": "Recap"})
            self.assertEqual(rpc.await_count, 1)
            self.assertEqual(rpc.call_args.kwargs["destination_identity"], "owner")
            self.assertEqual(rpc.call_args.kwargs["method"], "readymeet.meeting_answer.show_results")
        finally:
            self.patches[1].start()

    def test_largest_multibyte_panel_preserves_details(self):
        large = {"lead": "😀" * 180, "sections": [
            {"heading": "😀" * 60, "bullets": ["😀" * 180] * 3} for _ in range(4)]}
        payload = {"contentKind": "meeting-answer", "status": "completed", "query": "😀" * 300,
                   "searchId": "meeting-answer:test", "meetingId": "meeting", "requestingUserId": "user",
                   "answerDisplay": answers.answer_display(large)}
        compact = self.worker.compact_web_search_panel_payload(payload)
        self.assertEqual(compact["answerDisplay"]["sections"], payload["answerDisplay"]["sections"])
        self.assertEqual(compact["contentKind"], "meeting-answer")
        self.assertLess(len(json.dumps(compact, ensure_ascii=False).encode()), 15 * 1024)


if __name__ == "__main__":
    unittest.main()
