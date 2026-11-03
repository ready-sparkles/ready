import type { CapabilityCatalogRow, MeetingExtraction, SignalKey } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { rankCapabilities, SELECTION_SCORING } from "../../../domain/selection/ranking";

const DEFAULT_CAPABILITY_PRIORITY = 50;
const PRIORITY_69 = 69;
const PRIORITY_75 = 75;
const PRIORITY_90 = 90;
const PRIORITY_94 = 94;
const PRIORITY_95 = 95;
const PRIORITY_96 = 96;
const PRIORITY_97 = 97;
const PRIORITY_98 = 98;
const PRIORITY_99 = 99;
const PRIORITY_100 = 100;
const BOOSTED_BASE_PRIORITY = 40;
const UUID_PAD_LENGTH = 36;

function capability(input: Partial<CapabilityCatalogRow> & { key: string }): CapabilityCatalogRow {
  return {
    id: `${input.key}-id`.padEnd(UUID_PAD_LENGTH, "0").slice(0, UUID_PAD_LENGTH),
    key: input.key,
    name: input.name ?? input.key,
    description: input.description ?? `${input.key} description`,
    category: input.category ?? "execution",
    applicableMeetingTypes: input.applicableMeetingTypes ?? ["product_review"],
    requiredSignals: input.requiredSignals ?? [],
    exclusionSignals: input.exclusionSignals ?? [],
    exampleTriggers: input.exampleTriggers ?? ["Example one", "Example two"],
    sideEffectScope: input.sideEffectScope ?? "private_draft",
    defaultPriority: input.defaultPriority ?? DEFAULT_CAPABILITY_PRIORITY,
    isActive: input.isActive ?? true,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date("2026-04-24T00:00:00.000Z"),
    updatedAt: input.updatedAt ?? new Date("2026-04-24T00:00:00.000Z"),
  };
}

function extraction(input: {
  meetingType?: MeetingExtraction["meetingType"];
  signals?: { key: SignalKey; confidence: "low" | "medium" | "high" }[];
}): Pick<MeetingExtraction, "meetingType" | "signals"> {
  return {
    meetingType: input.meetingType ?? "product_review",
    signals: (input.signals ?? []).map((signal) => ({
      key: signal.key,
      confidence: signal.confidence,
      sourceSpans: [
        {
          excerpt: "Supporting excerpt.",
          lineStart: 1,
          lineEnd: 1,
          segmentIds: [],
          verificationStatus: "verified",
        },
      ],
    })),
  };
}

void test("meeting type mismatch filters out capability and empty applicable types apply to all", () => {
  const result = rankCapabilities({
    extraction: extraction({ meetingType: "sales_call" }),
    capabilities: [
      capability({ key: "wrong_type", applicableMeetingTypes: ["product_review"], defaultPriority: PRIORITY_95 }),
      capability({ key: "applies_all", applicableMeetingTypes: [], defaultPriority: PRIORITY_95 }),
    ],
  });

  assert.equal(result.considered.find((item) => item.capability.key === "wrong_type")?.status, "meeting_type_mismatch");
  assert.equal(result.recommended[0]?.capability.key, "applies_all");
});

void test("other meeting type does not block signal-matched capabilities", () => {
  const result = rankCapabilities({
    extraction: extraction({
      meetingType: "other",
      signals: [{ key: "engineering_issue_identified", confidence: "medium" }],
    }),
    capabilities: [
      capability({
        key: "file_issue_or_bug",
        applicableMeetingTypes: ["product_review"],
        defaultPriority: PRIORITY_90,
        requiredSignals: [{ key: "engineering_issue_identified" }],
      }),
    ],
  });

  assert.equal(result.recommended[0]?.capability.key, "file_issue_or_bug");
  assert.equal(result.considered[0]?.status, "recommended");
});

void test("removed capabilities are ignored even if stale database rows exist", () => {
  const result = rankCapabilities({
    extraction: extraction({}),
    capabilities: [
      capability({ key: "generate_comprehensive_notes", defaultPriority: PRIORITY_100 }),
      capability({ key: "create_task_list", defaultPriority: PRIORITY_99 }),
      capability({ key: "draft_internal_recap", defaultPriority: PRIORITY_98 }),
      capability({ key: "draft_decision_brief", defaultPriority: PRIORITY_97 }),
      capability({ key: "draft_spec_outline", defaultPriority: PRIORITY_96 }),
      capability({ key: "prepare_briefing_for_next_meeting", defaultPriority: PRIORITY_95 }),
      capability({ key: "file_issue_or_bug", defaultPriority: PRIORITY_94 }),
    ],
  });

  assert.deepEqual(
    result.considered.map((item) => item.capability.key),
    ["file_issue_or_bug"],
  );
  assert.equal(result.recommended[0]?.capability.key, "file_issue_or_bug");
});

void test("always-available capabilities are ignored by signal ranking", () => {
  const result = rankCapabilities({
    extraction: extraction({}),
    capabilities: [
      capability({
        key: "meeting_coaching",
        defaultPriority: PRIORITY_100,
        metadata: { /** @external capability catalog metadata */ alwaysAvailable: true },
      }),
      capability({
        key: "draft_participant_follow_up",
        defaultPriority: PRIORITY_99,
        metadata: { /** @external capability catalog metadata */ alwaysAvailable: true },
      }),
      capability({ key: "file_issue_or_bug", defaultPriority: PRIORITY_95 }),
    ],
  });

  assert.deepEqual(
    result.considered.map((item) => item.capability.key),
    ["file_issue_or_bug"],
  );
  assert.equal(result.recommended[0]?.capability.key, "file_issue_or_bug");
});

void test("medium and high exclusion signals exclude while low confidence does not", () => {
  const excluded = rankCapabilities({
    extraction: extraction({ signals: [{ key: "purely_informational", confidence: "medium" }] }),
    capabilities: [
      capability({
        key: "excluded",
        defaultPriority: PRIORITY_95,
        exclusionSignals: [{ key: "purely_informational" }],
      }),
    ],
  });
  assert.equal(excluded.considered[0]?.status, "excluded_by_signal");

  const allowed = rankCapabilities({
    extraction: extraction({ signals: [{ key: "purely_informational", confidence: "low" }] }),
    capabilities: [
      capability({
        key: "allowed",
        defaultPriority: PRIORITY_95,
        exclusionSignals: [{ key: "purely_informational" }],
      }),
    ],
  });
  assert.equal(allowed.recommended[0]?.capability.key, "allowed");
});

void test("base score, required signal boosts, missing required signals, and no-required behavior are deterministic", () => {
  const result = rankCapabilities({
    extraction: extraction({
      signals: [
        { key: "decisions_made", confidence: "high" },
        { key: "action_commitments_made", confidence: "medium" },
        { key: "open_questions_remain", confidence: "low" },
      ],
    }),
    capabilities: [
      capability({
        key: "boosted",
        defaultPriority: BOOSTED_BASE_PRIORITY,
        requiredSignals: [
          { key: "decisions_made" },
          { key: "action_commitments_made" },
          { key: "open_questions_remain" },
        ],
      }),
      capability({
        key: "absent",
        defaultPriority: PRIORITY_95,
        requiredSignals: [{ key: "engineering_issue_identified" }],
      }),
      capability({
        key: "partial_required",
        defaultPriority: PRIORITY_95,
        requiredSignals: [{ key: "action_commitments_made" }, { key: "crm_relevant_context" }],
      }),
      capability({
        key: "base_only",
        defaultPriority: PRIORITY_75,
        requiredSignals: [],
      }),
    ],
  });

  const boosted = result.considered.find((item) => item.capability.key === "boosted");
  assert.equal(
    boosted?.rawScore,
    BOOSTED_BASE_PRIORITY +
      SELECTION_SCORING.signalBoosts.high +
      SELECTION_SCORING.signalBoosts.medium +
      SELECTION_SCORING.signalBoosts.low,
  );
  assert.equal(result.considered.find((item) => item.capability.key === "absent")?.status, "required_signals_absent");
  assert.equal(
    result.considered.find((item) => item.capability.key === "partial_required")?.status,
    "required_signals_absent",
  );
  assert.equal(
    result.considered.find((item) => item.capability.key === "partial_required")?.signalsMatched[0]?.key,
    "action_commitments_made",
  );
  assert.equal(result.considered.find((item) => item.capability.key === "base_only")?.rawScore, PRIORITY_75);
});

void test("category diversity penalty, threshold, cap, tie breakers, and reasons are stable", () => {
  const capabilities = [
    capability({ key: "b_key", category: "communication", defaultPriority: PRIORITY_100 }),
    capability({ key: "a_key", category: "communication", defaultPriority: PRIORITY_100 }),
    capability({ key: "exec_one", category: "execution", defaultPriority: PRIORITY_99 }),
    capability({ key: "doc_one", category: "documentation", defaultPriority: PRIORITY_98 }),
    capability({ key: "coord_one", category: "coordination", defaultPriority: PRIORITY_97 }),
    capability({ key: "prep_one", category: "preparation", defaultPriority: PRIORITY_96 }),
    capability({ key: "weak", category: "investigation", defaultPriority: PRIORITY_69 }),
  ];

  const result = rankCapabilities({ extraction: extraction({}), capabilities });
  assert.deepEqual(
    result.recommended.map((item) => item.capability.key),
    ["a_key", "exec_one", "doc_one", "coord_one"],
  );
  assert.equal(
    result.considered.find((item) => item.capability.key === "b_key")?.finalScore,
    PRIORITY_100 - SELECTION_SCORING.categoryDuplicatePenalty,
  );
  assert.equal(result.considered.find((item) => item.capability.key === "prep_one")?.status, "outranked");
  assert.equal(result.considered.find((item) => item.capability.key === "weak")?.status, "score_below_threshold");
});
