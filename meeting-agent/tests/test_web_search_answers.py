from __future__ import annotations

import os
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
for key, value in {
    "DATABASE_URL": "postgresql://readymeet.test/readymeet", "LIVEKIT_URL": "wss://example.livekit.cloud",
    "LIVEKIT_API_KEY": "test", "LIVEKIT_API_SECRET": "test", "OPENAI_API_KEY": "test",
    "ELEVEN_API_KEY": "test", "ASSISTANT_SERVICE_SECRET": "test",
}.items():
    os.environ.setdefault(key, value)

from credit_usage_fakes import ProviderOnlyCreditUsage
from meeting_agent import worker
from meeting_agent.gpt_live import build_voice_instructions


def research_result():
    return {
        "status": "completed", "answerStatus": "ready", "query": "Pro price?",
        "voiceResearchResult": {
            "answer_brief": "Pro costs $25 monthly before tax.",
            "spoken_answer": "Pro costs $25 monthly before tax.", "confidence": "high",
            "claims": [{"text": "Pro costs $25 monthly before tax.", "citation_ids": ["c1"]}],
            "citations": [{"id": "c1", "title": "Official pricing", "url": "https://example.com/pricing",
                           "quote_or_excerpt": "Pro: $25 per month before tax."}], "caveats": [],
        },
        "results": [{"title": "Official pricing", "url": "https://example.com/pricing", "excerpt": "Pro: $25 per month before tax."}],
    }


class WebSearchAnswerTests(unittest.IsolatedAsyncioTestCase):
    def test_progress_reports_only_real_research_stages(self):
        self.assertIn("reading", worker.web_search_progress_message("reading", "Reading source details"))
        self.assertIn("narrowing", worker.web_search_progress_message("searching", "Refining the search"))
        for phase in ["completed", "failed", "synthesizing"]:
            self.assertIsNone(worker.web_search_progress_message(phase, "Anything"))
        self.assertIsNone(worker.web_search_progress_message("searching", "Starting web research"))

    def setUp(self):
        self.owner = worker.TurnOwnerContext(participant_identity="personbr:browser", user_id="personbr", display_name="Personbr", assistant_display_name="Ready")
        self.context = worker.ToolExecutionContext(
            meeting_turn_id="turn", participant_identity="personbr:browser", meeting_id="meeting", utterance_id="utterance",
            requesting_user_id="personbr", active_speaker_user_id="personbr", agent_profile_id="profile", allowed_tool_scope="private",
            created_at="2026-09-24T00:00:00+00:00", requesting_user_display_name="Personbr",
        )
        self.capabilities = worker.TurnCapabilityContext(active_turn=SimpleNamespace(owner_context=self.owner), memories=[],
                                                       connectors=[{"provider": "web_search", "status": "connected"}], tool_policies=[])

    async def test_clock_is_registered_in_both_production_toolsets(self):
        for mode in [worker.ASSISTANT_MODE_SOLO, worker.ASSISTANT_MODE_GROUP]:
            tools = worker.MeetingTools("meeting", worker.SETTINGS, AsyncMock(return_value=self.capabilities),
                lambda: self.context, assistant_mode=mode)
            self.assertIn("get_current_time", {tool.id for tool in tools.tools})
            self.assertEqual((await tools.get_current_time("America/Los_Angeles"))["time_zone"], "America/Los_Angeles")

    async def test_agent_help_can_search_again_after_a_weak_result(self):
        def search_call(call_id, query):
            return SimpleNamespace(type="function_call", name="web_search", call_id=call_id,
                                   arguments=json.dumps({"query": query}))
        responses = SimpleNamespace(create=AsyncMock(side_effect=[
            SimpleNamespace(output_text="", output=[search_call("first", "Find nearby concerts")]),
            SimpleNamespace(output_text="", output=[search_call("second", "Check venue distance from hotel")]),
            SimpleNamespace(output_text="The second venue looks closer based on those addresses.", output=[]),
        ]))
        client = SimpleNamespace(responses=responses, close=AsyncMock())
        runner = AsyncMock(side_effect=[{"voiceAnswer": "Found an event; distance missing."},
                                       {"voiceAnswer": "Venue and hotel share a neighborhood."}])
        with patch.object(worker, "build_agent_help_messages", return_value=[]), \
             patch.object(worker.openai, "AsyncClient", return_value=client):
            answer = await worker.generate_agent_help_participation(SimpleNamespace(screen_share_image_data_url=None), web_search_runner=runner, credit_usage=ProviderOnlyCreditUsage())
        self.assertEqual(runner.await_count, 2)
        self.assertEqual(runner.await_args_list[1].args, ("Check venue distance from hotel",))
        self.assertIn("looks closer", answer)

    async def test_multiple_searches_stay_hidden_until_explicit_presentation(self):
        tool = worker.WebSearchResearchTools("meeting", worker.SETTINGS,
            AsyncMock(return_value=self.capabilities), lambda: self.context)
        first = {**research_result(), "researchRunId": "first"}
        second = {**research_result(), "researchRunId": "second"}
        with patch.object(worker, "call_agent_tool_broker", new=AsyncMock(side_effect=[{"result": first}, {"result": second}, second])), \
             patch.object(worker, "show_web_search_panel_for_meeting", new=AsyncMock(return_value={"status": "shown"})) as panel:
            context = SimpleNamespace(update=AsyncMock())
            for query in ["Find events", "Find closer events"]:
                result = await tool.search_web(context, query)
                self.assertEqual(result["panel"], "pending")
            for call in panel.await_args_list:
                payload = call.kwargs["payload"]
                self.assertNotEqual(payload["status"], "completed")
                self.assertNotIn("results", payload)
                self.assertNotIn("answerDisplay", payload)
            presented = await tool.present_web_search_results("second")
            self.assertEqual(presented["status"], "presented")
            self.assertEqual(panel.await_args.kwargs["payload"]["researchRunId"], "second")
            self.assertEqual(panel.await_args.kwargs["payload"]["results"], second["results"])
            self.assertEqual(panel.await_args.kwargs["payload"]["meetingId"], "meeting")
            self.assertEqual(panel.await_args.kwargs["payload"]["requestingUserId"], "personbr")
            self.assertEqual(panel.await_args.kwargs["payload"]["searchId"], "utterance")
            self.assertEqual((await tool.present_web_search_results("first"))["error"], "no_pending_result")

    def test_progress_strips_every_candidate_surface(self):
        payload = {**research_result(), "status": "partial", "answerPreview": "candidate",
                   "progress": {"phase": "reading", "activeSources": ["candidate"], "signals": ["candidate"], "partialAnswer": {"summary": "candidate"}}}
        progress = worker.web_search_progress_only(payload)
        self.assertNotIn("results", progress)
        self.assertNotIn("voiceResearchResult", progress)
        self.assertEqual(progress["progress"], {"phase": "reading"})

    async def run_search(self, helper, payload):
        tool = worker.WebSearchResearchTools("meeting", worker.SETTINGS, AsyncMock(return_value=self.capabilities), lambda: self.context)
        with patch.object(worker, "call_agent_tool_broker", new=AsyncMock(return_value={"result": payload})) as broker, \
             patch.object(worker, "show_web_search_panel_for_meeting", new=AsyncMock(return_value={"status": "shown"})):
            if helper:
                result = await worker.execute_web_search_with_panel(meeting_id="meeting", settings=worker.SETTINGS,
                    owner_context=self.owner, tool_context=self.context, query="Pro price?", search_queries=["Example Pro official pricing"])
            else:
                result = await tool.search_web(SimpleNamespace(update=AsyncMock()), "Pro price?", ["Example Pro official pricing"])
            self.assertEqual(broker.await_count, 1)
            self.assertEqual(broker.await_args.kwargs["timeout_s"], 75.0)
            self.assertEqual(broker.await_args.args[2]["args"]["searchQueries"], ["Example Pro official pricing"])
            return result

    async def test_both_search_paths_preserve_citations_and_the_same_speaking_policy(self):
        outputs = [await self.run_search(helper, research_result()) for helper in [False, True]]
        for result in outputs:
            self.assertEqual(result["voiceAnswer"], "Pro costs $25 monthly before tax.")
            self.assertEqual(result["answerStatus"], "ready")
            self.assertEqual(result["answer"]["confidence"], "high")
            citation = result["answer"]["facts"][0]["citations"][0]
            self.assertEqual(citation["id"], "c1")
            self.assertIn("$25", citation["excerpt"])
            self.assertIn("before tax", result["webSearchContext"]["answer"])
            self.assertNotIn("say you found sources but", result["answerGuidance"])
        self.assertTrue(outputs[0]["answerGuidance"].startswith(outputs[1]["answerGuidance"]))

    async def test_synthesis_failure_and_insufficient_evidence_remain_distinct_in_both_paths(self):
        for helper in [False, True]:
            for status, spoken in [("synthesis_failed", "I found relevant sources, but couldn't finish preparing the answer."),
                                   ("insufficient_evidence", "These sources do not answer that question.")]:
                payload = research_result()
                payload["answerStatus"] = status
                payload["voiceResearchResult"].update(confidence="unverified", claims=[], spoken_answer=spoken, answer_brief=spoken)
                result = await self.run_search(helper, payload)
                self.assertEqual(result["voiceAnswer"], spoken)
                self.assertEqual(result["answerStatus"], status)
                self.assertEqual(result["resultCount"], 1)

    async def test_partial_lookup_has_no_premature_failure_or_answer(self):
        for helper in [False, True]:
            result = await self.run_search(helper, {"status": "partial", "results": []})
            self.assertIsNone(result["voiceAnswer"])
            self.assertIn("still running", result["answerGuidance"])

    def test_formatter_preserves_material_caveats_and_never_invents_citation_links(self):
        raw = research_result()["voiceResearchResult"]
        raw["caveats"] = ["Requires an annual contract."]
        compact = worker._compact_answer(raw)
        self.assertEqual(compact["caveat"], "Requires an annual contract.")
        self.assertEqual(compact["facts"][0]["citations"][0]["id"], "c1")
        raw["claims"][0]["citation_ids"] = ["missing"]
        self.assertEqual(worker._compact_answer(raw)["facts"][0]["citations"], [])
        raw["citations"] = None
        self.assertEqual(worker._compact_answer(raw)["facts"][0]["citations"], [])

    def test_voice_persona_preserves_backend_certainty_and_material_qualifications(self):
        prompt = build_voice_instructions("Ready", "Personbr")
        self.assertIn("degree of certainty", prompt)
        self.assertIn("material qualifications", prompt)

    def test_followup_context_preserves_long_spoken_answer_qualifications(self):
        payload = research_result()
        spoken = "The plan includes shared workspace access. " * 14 + "Only with an annual contract."
        payload["voiceResearchResult"]["spoken_answer"] = spoken
        result = worker.build_web_search_voice_payload(payload, "What is included?")
        self.assertEqual(result["voiceAnswer"], spoken)
        self.assertEqual(result["webSearchContext"]["answer"], spoken)


if __name__ == "__main__":
    unittest.main()
