import assert from "node:assert/strict";
import test from "node:test";

import {
  END_MEETING_ANALYSIS_MIN_VISIBLE_MS,
  END_MEETING_ANALYSIS_PHASE_MS,
  type EndMeetingFlowState,
  getEndMeetingAnalysisState,
  getEndMeetingPreparationWaitMs,
} from "../../../presentation/components/end-meeting-analysis";

const EXPECTED_END_MEETING_ANALYSIS_MIN_VISIBLE_MS = 3_000;
const END_MEETING_FIXTURE_STARTED_AT_MS = 1_000;
const END_MEETING_FIXTURE_NOW_MS = 1_000;
const END_MEETING_PREPARATION_NOW_PARTIAL_MS = 2_500;
const EXPECTED_END_MEETING_PREPARATION_WAIT_PARTIAL_MS = 1_500;
const END_MEETING_PREPARATION_NOW_COMPLETE_MS = 4_500;
const END_MEETING_ANALYSIS_SOLVING_PHASE_OFFSET_MULTIPLIER = 2;

void test("post-meeting loader stays visible long enough to feel intentional", () => {
  assert.equal(END_MEETING_ANALYSIS_MIN_VISIBLE_MS, EXPECTED_END_MEETING_ANALYSIS_MIN_VISIBLE_MS);
  assert.equal(
    getEndMeetingPreparationWaitMs({
      startedAt: END_MEETING_FIXTURE_STARTED_AT_MS,
      now: END_MEETING_FIXTURE_NOW_MS,
    }),
    EXPECTED_END_MEETING_ANALYSIS_MIN_VISIBLE_MS,
  );
  assert.equal(
    getEndMeetingPreparationWaitMs({
      startedAt: END_MEETING_FIXTURE_STARTED_AT_MS,
      now: END_MEETING_PREPARATION_NOW_PARTIAL_MS,
    }),
    EXPECTED_END_MEETING_PREPARATION_WAIT_PARTIAL_MS,
  );
  assert.equal(
    getEndMeetingPreparationWaitMs({
      startedAt: END_MEETING_FIXTURE_STARTED_AT_MS,
      now: END_MEETING_PREPARATION_NOW_COMPLETE_MS,
    }),
    0,
  );
});

function flow(overrides: Partial<EndMeetingFlowState> = {}): EndMeetingFlowState {
  return {
    startedAt: END_MEETING_FIXTURE_STARTED_AT_MS,
    phase: "synthesizing_notes",
    detail: null,
    transientError: null,
    ...overrides,
  };
}

void test("post-meeting loader keeps the solving orb across all visible text phases", () => {
  const startedAt = END_MEETING_FIXTURE_STARTED_AT_MS;

  const connecting = getEndMeetingAnalysisState({ flow: flow({ startedAt }), now: startedAt });
  const working = getEndMeetingAnalysisState({
    flow: flow({ startedAt }),
    now: startedAt + END_MEETING_ANALYSIS_PHASE_MS,
  });
  const solving = getEndMeetingAnalysisState({
    flow: flow({ startedAt }),
    now: startedAt + END_MEETING_ANALYSIS_PHASE_MS * END_MEETING_ANALYSIS_SOLVING_PHASE_OFFSET_MULTIPLIER,
  });

  assert.deepEqual([connecting.orbState, working.orbState, solving.orbState], ["solving", "solving", "solving"]);
  assert.deepEqual(
    [connecting.activePhase, working.activePhase, solving.activePhase],
    ["Understanding the conversation", "Resolving next steps", "Preparing the workspace"],
  );
});

void test("routing always uses the final solving orb", () => {
  const state = getEndMeetingAnalysisState({
    flow: flow({ phase: "routing" }),
    now: END_MEETING_FIXTURE_NOW_MS,
  });

  assert.equal(state.activePhase, "Preparing the workspace");
  assert.equal(state.orbState, "solving");
});

void test("explicit workspace-flow labels keep the solving orb", () => {
  const labels = [
    ["Reading transcript", "solving"],
    ["Preparing workspace", "solving"],
    ["Assembling the workspace", "solving"],
  ] as const;

  assert.deepEqual(
    labels.map(
      ([activeLabel]) =>
        getEndMeetingAnalysisState({ flow: flow({ activeLabel }), now: END_MEETING_FIXTURE_NOW_MS }).orbState,
    ),
    labels.map(([, orbState]) => orbState),
  );
});

void test("transient finalization errors expose a failed orb state", () => {
  const state = getEndMeetingAnalysisState({
    flow: flow({ transientError: "Analysis pipeline check failed" }),
    now: END_MEETING_FIXTURE_NOW_MS,
  });

  assert.equal(state.isFailed, true);
  assert.equal(getEndMeetingAnalysisState({ flow: flow(), now: END_MEETING_FIXTURE_NOW_MS }).isFailed, false);
});
