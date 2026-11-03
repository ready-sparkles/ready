import type { CapabilitySelectionCapability } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { buildSelectionPayloadTools, parseSelectionPayloadToolCall } from "../../../domain/selection/tools";

const DEFAULT_CAPABILITY_PRIORITY = 70;

function capability(key: string): CapabilitySelectionCapability {
  return {
    key,
    name: key,
    description: `${key} description`,
    category: "documentation",
    applicableMeetingTypes: ["product_review"],
    requiredSignals: [],
    exclusionSignals: [],
    defaultPriority: DEFAULT_CAPABILITY_PRIORITY,
  };
}

void test("selection payload tools skip removed capabilities", () => {
  const tools = buildSelectionPayloadTools([
    capability("generate_comprehensive_notes"),
    capability("create_task_list"),
    capability("draft_decision_brief"),
    capability("draft_internal_recap"),
    capability("draft_spec_outline"),
    capability("prepare_briefing_for_next_meeting"),
  ]);

  assert.equal(tools.length, 0);
});

void test("removed payload tool calls are rejected", () => {
  assert.throws(
    () =>
      parseSelectionPayloadToolCall({
        toolName: "payload_generate_comprehensive_notes",
        rawInput: {
          reasoning: "The extraction contains enough decisions and follow-up context to justify comprehensive notes.",
          confidence: "medium",
          title: "Comprehensive meeting notes",
          sections: ["Summary", "Highlights", "Decisions", "Tasks", "Open questions", "Risks"],
          focus_areas: ["Follow-up work", "Decision context"],
          validation_requirements: ["Use only validated source spans", "Preserve empty sections when unsupported"],
        },
      }),
    /Unknown selection payload tool/,
  );

  assert.throws(
    () =>
      parseSelectionPayloadToolCall({
        toolName: "payload_draft_internal_recap",
        rawInput: {
          reasoning: "The extraction contains internal team follow-up context.",
          confidence: "medium",
          audience: "internal team",
          recap_focus: ["decisions", "commitments"],
          include_sections: ["decisions", "commitments"],
        },
      }),
    /Unknown selection payload tool/,
  );

  ["create_task_list", "draft_decision_brief", "draft_spec_outline", "prepare_briefing_for_next_meeting"].forEach(
    (capabilityKey) => {
      assert.throws(
        () =>
          parseSelectionPayloadToolCall({
            toolName: `payload_${capabilityKey}`,
            rawInput: {
              reasoning: "This removed capability should not be accepted.",
              confidence: "medium",
            },
          }),
        /Unknown selection payload tool/,
      );
    },
  );
});

void test("research payload tool accepts deep research payload shape", () => {
  const [tool] = buildSelectionPayloadTools([capability("research_open_question")]);
  assert.equal(tool?.name, "payload_research_open_question");

  const parsed = parseSelectionPayloadToolCall({
    toolName: "payload_research_open_question",
    rawInput: {
      reasoning: "The meeting requested a web-backed comparison of relevant vendors.",
      confidence: "high",
      query: "Find and compare 20 relevant companies that provide AI meeting workflow automation for mid-market teams.",
      action_label: "Deep research on AI meeting workflow companies",
      task_kind: "compare_entities",
      context: "The team asked for a vendor comparison before deciding who to evaluate.",
      expected_output: "A sourced comparison table and short recommendation.",
      seed_urls: [],
    },
  });

  assert.equal(parsed.capabilityKey, "research_open_question");
  assert.equal(parsed.payload.task_kind, "compare_entities");
  assert.equal(parsed.payload.action_label, "Deep research on AI meeting workflow companies");
});
