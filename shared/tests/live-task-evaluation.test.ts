import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveTaskEvaluationInput,
  evaluateLiveTaskLaunchGates,
  percentile,
  wilsonLowerBound,
} from "../domain/live-task-evaluation";

type LiveTaskEvaluationGateInput = Parameters<typeof evaluateLiveTaskLaunchGates>[0];
type LiveTaskEvaluationBuildInput = Parameters<typeof buildLiveTaskEvaluationInput>[0];

type LiveTaskEvaluationMeetingFixture = Omit<
  LiveTaskEvaluationBuildInput["meetings"][number],
  | "consented"
  | "deidentified"
  | "annotatorsLanguageQualified"
  | "annotatorsBlindedToModel"
  | "adjudicated"
  | "noisyOrFarField"
  | "overlapOrFivePlusSpeakers"
> & {
  /** @external live task evaluation meeting contract */
  consented: boolean;
  /** @external live task evaluation meeting contract */
  deidentified: boolean;
  /** @external live task evaluation meeting contract */
  annotatorsLanguageQualified: boolean;
  /** @external live task evaluation meeting contract */
  annotatorsBlindedToModel: boolean;
  /** @external live task evaluation meeting contract */
  adjudicated: boolean;
  /** @external live task evaluation meeting contract */
  noisyOrFarField: boolean;
  /** @external live task evaluation meeting contract */
  overlapOrFivePlusSpeakers: boolean;
};

type LiveTaskEvaluationGoldFixture = Omit<
  LiveTaskEvaluationBuildInput["goldLabels"][number],
  "completedDuringMeeting" | "cancelledDuringMeeting"
> & {
  /** @external live task evaluation gold label contract */
  completedDuringMeeting: boolean;
  /** @external live task evaluation gold label contract */
  cancelledDuringMeeting: boolean;
};

type LiveTaskEvaluationDisplayFixture = Omit<LiveTaskEvaluationBuildInput["displays"][number], "actionScopeCorrect"> & {
  /** @external live task evaluation display contract */
  actionScopeCorrect: boolean;
};

type LiveTaskEvaluationBuildFixture = Omit<LiveTaskEvaluationBuildInput, "reconciliationPreservationPassed"> & {
  /** @external live task evaluation build contract */
  reconciliationPreservationPassed: boolean;
};

type LiveTaskEvaluationGateFixture = Omit<LiveTaskEvaluationGateInput, "reconciliationPreservationPassed"> & {
  /** @external live task evaluation launch gate contract */
  reconciliationPreservationPassed: boolean;
};

const LAUNCH_DEV_MEETING_COUNT = 200;
const LAUNCH_HOLDOUT_MEETING_COUNT = 100;
const COMPOSITION_ENGLISH_DOMINANT = 40;
const COMPOSITION_FINNISH_DOMINANT = 30;
const COMPOSITION_MIXED = 15;
const COMPOSITION_OTHER_LAUNCH_LANGUAGE = 15;
const COMPOSITION_REGIONAL_SPEECH = 30;
const COMPOSITION_NOISY_FAR_FIELD = 30;
const COMPOSITION_OVERLAP_FIVE_PLUS = 20;
const GOLD_CONFIRMABLE_TASKS_LARGE = 500;
const MODEL_CONFIRMATIONS_LARGE = 500;
const TASK_EXISTENCE_KAPPA_PASS = 0.86;
const OWNER_LABEL_KAPPA_PASS = 0.84;
const TASK_TRUE_POSITIVES_PASS = 490;
const TASK_DISPLAYS_LARGE = 500;
const ELIGIBLE_GOLD_TASKS_LARGE = 500;
const MATCHED_ELIGIBLE_GOLD_TASKS_PASS = 440;
const OWNER_CORRECT_PASS = 490;
const NAMED_OWNER_ASSIGNMENTS_PASS = 495;
const EXPLICIT_OWNER_GOLD_TASKS_PASS = 480;
const CORRECTLY_OWNED_GOLD_TASKS_PASS = 450;
const WRONG_PERSON_ASSIGNMENTS_PASS = 5;
const LATENCY_SERIES_START_MS = 10_000;
const LATENCY_SERIES_STEP_MS = 400;
const LATENCY_SERIES_LENGTH = 100;
const FINNISH_STRATA_GOLD_TASKS = 80;
const FINNISH_STRATA_TRUE_POSITIVES = 76;
const FINNISH_STRATA_DISPLAYS = 80;
const FINNISH_STRATA_OWNER_CORRECT = 77;
const FINNISH_STRATA_NAMED_OWNER_ASSIGNMENTS = 80;
const EXPECTED_P50_MS = 29_600;
const EXPECTED_P95_MS = 47_600;
const LAUNCH_DEV_MEETING_COUNT_FAIL = 20;
const LAUNCH_HOLDOUT_MEETING_COUNT_FAIL = 20;
const COMPOSITION_ENGLISH_DOMINANT_FAIL = 10;
const COMPOSITION_FINNISH_DOMINANT_FAIL = 5;
const COMPOSITION_MIXED_FAIL = 3;
const COMPOSITION_OTHER_LAUNCH_LANGUAGE_FAIL = 2;
const COMPOSITION_REGIONAL_SPEECH_FAIL = 2;
const COMPOSITION_NOISY_FAR_FIELD_FAIL = 2;
const COMPOSITION_OVERLAP_FIVE_PLUS_FAIL = 1;
const GOLD_CONFIRMABLE_TASKS_SMALL = 50;
const MODEL_CONFIRMATIONS_SMALL = 50;
const TASK_EXISTENCE_KAPPA_FAIL = 0.7;
const OWNER_LABEL_KAPPA_FAIL = 0.7;
const TASK_TRUE_POSITIVES_FAIL = 49;
const TASK_DISPLAYS_SMALL = 50;
const ELIGIBLE_GOLD_TASKS_SMALL = 50;
const MATCHED_ELIGIBLE_GOLD_TASKS_FAIL = 49;
const OWNER_CORRECT_FAIL = 45;
const NAMED_OWNER_ASSIGNMENTS_FAIL = 50;
const EXPLICIT_OWNER_GOLD_TASKS_FAIL = 50;
const CORRECTLY_OWNED_GOLD_TASKS_FAIL = 45;
const WRONG_PERSON_ASSIGNMENTS_FAIL = 5;
const APPEARANCE_LATENCY_FAIL_MS = 61_000;
const PERCENTILE_SAMPLE_FIRST = 10;
const PERCENTILE_SAMPLE_SECOND = 20;
const PERCENTILE_SAMPLE_THIRD = 30;
const PERCENTILE_SAMPLE_FOURTH = 40;
const PERCENTILE_MEDIAN_RANK = 0.5;
const WILSON_SUCCESSES = 490;
const WILSON_TRIALS = 500;
const WILSON_LOWER_BOUND_MIN = 0.95;
const ANNOTATOR_COUNT = 2;
const DISPLAY_LATENCY_MS = 20_000;
const PERFECT_KAPPA = 1;
const DUPLICATE_DISPLAY_COUNT = 2;
const SINGLE_TRUE_POSITIVE_COUNT = 1;
const SINGLE_OWNED_GOLD_TASK_COUNT = 1;

void test("live task launch evaluation uses Wilson bounds and utterance-based latency percentiles", () => {
  const launchGateInput: LiveTaskEvaluationGateFixture = {
    developmentMeetingCount: LAUNCH_DEV_MEETING_COUNT,
    holdoutMeetingCount: LAUNCH_HOLDOUT_MEETING_COUNT,
    holdoutComposition: {
      englishDominant: COMPOSITION_ENGLISH_DOMINANT,
      finnishDominant: COMPOSITION_FINNISH_DOMINANT,
      mixedOrCodeSwitching: COMPOSITION_MIXED,
      otherLaunchLanguageOrReallocatedMixed: COMPOSITION_OTHER_LAUNCH_LANGUAGE,
      regionalOrNonNativeSpeechVariation: COMPOSITION_REGIONAL_SPEECH,
      noisyOrFarField: COMPOSITION_NOISY_FAR_FIELD,
      overlapOrFivePlusSpeakers: COMPOSITION_OVERLAP_FIVE_PLUS,
    },
    goldConfirmableTasks: GOLD_CONFIRMABLE_TASKS_LARGE,
    modelConfirmations: MODEL_CONFIRMATIONS_LARGE,
    taskExistenceKappa: TASK_EXISTENCE_KAPPA_PASS,
    ownerLabelKappa: OWNER_LABEL_KAPPA_PASS,
    taskTruePositives: TASK_TRUE_POSITIVES_PASS,
    taskDisplays: TASK_DISPLAYS_LARGE,
    eligibleGoldTasks: ELIGIBLE_GOLD_TASKS_LARGE,
    matchedEligibleGoldTasks: MATCHED_ELIGIBLE_GOLD_TASKS_PASS,
    ownerCorrect: OWNER_CORRECT_PASS,
    namedOwnerAssignments: NAMED_OWNER_ASSIGNMENTS_PASS,
    explicitOwnerGoldTasks: EXPLICIT_OWNER_GOLD_TASKS_PASS,
    correctlyOwnedGoldTasks: CORRECTLY_OWNED_GOLD_TASKS_PASS,
    wrongPersonAssignments: WRONG_PERSON_ASSIGNMENTS_PASS,
    appearanceLatenciesMs: Array.from(
      { length: LATENCY_SERIES_LENGTH },
      (_, index) => LATENCY_SERIES_START_MS + index * LATENCY_SERIES_STEP_MS,
    ),
    reconciliationPreservationPassed: true,
    languageStrata: [
      {
        name: "Finnish",
        goldTaskCount: FINNISH_STRATA_GOLD_TASKS,
        taskTruePositives: FINNISH_STRATA_TRUE_POSITIVES,
        taskDisplays: FINNISH_STRATA_DISPLAYS,
        ownerCorrect: FINNISH_STRATA_OWNER_CORRECT,
        namedOwnerAssignments: FINNISH_STRATA_NAMED_OWNER_ASSIGNMENTS,
      },
    ],
  };
  const result = evaluateLiveTaskLaunchGates(launchGateInput);
  assert.equal(result.passed, true);
  assert.equal(result.metrics.p50Ms, EXPECTED_P50_MS);
  assert.equal(result.metrics.p95Ms, EXPECTED_P95_MS);
});

void test("live task launch evaluation fails thin samples and wrong-person assignments", () => {
  const launchGateInput: LiveTaskEvaluationGateFixture = {
    developmentMeetingCount: LAUNCH_DEV_MEETING_COUNT_FAIL,
    holdoutMeetingCount: LAUNCH_HOLDOUT_MEETING_COUNT_FAIL,
    holdoutComposition: {
      englishDominant: COMPOSITION_ENGLISH_DOMINANT_FAIL,
      finnishDominant: COMPOSITION_FINNISH_DOMINANT_FAIL,
      mixedOrCodeSwitching: COMPOSITION_MIXED_FAIL,
      otherLaunchLanguageOrReallocatedMixed: COMPOSITION_OTHER_LAUNCH_LANGUAGE_FAIL,
      regionalOrNonNativeSpeechVariation: COMPOSITION_REGIONAL_SPEECH_FAIL,
      noisyOrFarField: COMPOSITION_NOISY_FAR_FIELD_FAIL,
      overlapOrFivePlusSpeakers: COMPOSITION_OVERLAP_FIVE_PLUS_FAIL,
    },
    goldConfirmableTasks: GOLD_CONFIRMABLE_TASKS_SMALL,
    modelConfirmations: MODEL_CONFIRMATIONS_SMALL,
    taskExistenceKappa: TASK_EXISTENCE_KAPPA_FAIL,
    ownerLabelKappa: OWNER_LABEL_KAPPA_FAIL,
    taskTruePositives: TASK_TRUE_POSITIVES_FAIL,
    taskDisplays: TASK_DISPLAYS_SMALL,
    eligibleGoldTasks: ELIGIBLE_GOLD_TASKS_SMALL,
    matchedEligibleGoldTasks: MATCHED_ELIGIBLE_GOLD_TASKS_FAIL,
    ownerCorrect: OWNER_CORRECT_FAIL,
    namedOwnerAssignments: NAMED_OWNER_ASSIGNMENTS_FAIL,
    explicitOwnerGoldTasks: EXPLICIT_OWNER_GOLD_TASKS_FAIL,
    correctlyOwnedGoldTasks: CORRECTLY_OWNED_GOLD_TASKS_FAIL,
    wrongPersonAssignments: WRONG_PERSON_ASSIGNMENTS_FAIL,
    appearanceLatenciesMs: [APPEARANCE_LATENCY_FAIL_MS],
    reconciliationPreservationPassed: false,
    languageStrata: [],
  };
  const result = evaluateLiveTaskLaunchGates(launchGateInput);
  assert.equal(result.passed, false);
  assert.equal(result.checks.corpusSize, false);
  assert.equal(result.checks.corpusComposition, false);
  assert.equal(result.checks.wrongPersonRate, false);
  assert.equal(result.checks.appearanceLatency, false);
});

void test("evaluation statistics are deterministic at their boundaries", () => {
  assert.equal(
    percentile({
      values: [PERCENTILE_SAMPLE_FIRST, PERCENTILE_SAMPLE_SECOND, PERCENTILE_SAMPLE_THIRD, PERCENTILE_SAMPLE_FOURTH],
      quantile: PERCENTILE_MEDIAN_RANK,
    }),
    PERCENTILE_SAMPLE_SECOND,
  );
  assert.ok(wilsonLowerBound({ successes: WILSON_SUCCESSES, total: WILSON_TRIALS }) > WILSON_LOWER_BOUND_MIN);
});

void test("raw evaluation counts duplicate displays as false positives and excludes recovered latency", () => {
  const meeting: LiveTaskEvaluationMeetingFixture = {
    meetingId: "holdout-1",
    split: "holdout" as const,
    language: "english" as const,
    compositionBucket: "english" as const,
    consented: true,
    deidentified: true,
    transcriptSource: "actual_final_stt" as const,
    independentAnnotatorCount: ANNOTATOR_COUNT,
    annotatorsLanguageQualified: true,
    annotatorsBlindedToModel: true,
    adjudicated: true,
    regionalOrNonNativeSpeechVariationSource: null,
    noisyOrFarField: false,
    overlapOrFivePlusSpeakers: false,
  };
  const gold: LiveTaskEvaluationGoldFixture = {
    meetingId: meeting.meetingId,
    goldTaskId: "gold-1",
    canonicalActionOutcomeScope: "Send the launch deck",
    evidenceSegmentIds: ["segment-1"],
    actionConfirmableAt: "2026-08-19T12:00:00.000Z",
    meetingEndedAt: "2026-08-19T12:05:00.000Z",
    ownerKey: "personaj@example.com",
    ownerEvidenceSegmentIds: ["segment-1"],
    dueDate: null,
    completedDuringMeeting: false,
    cancelledDuringMeeting: false,
  };
  const displays: LiveTaskEvaluationDisplayFixture[] = [
    {
      meetingId: meeting.meetingId,
      taskId: "task-1",
      displayedAt: "2026-08-19T12:00:20.000Z",
      matchedGoldTaskId: gold.goldTaskId,
      actionScopeCorrect: true,
      displayedOwnerKey: "personaj@example.com",
      clientContinuity: "continuous",
    },
    {
      meetingId: meeting.meetingId,
      taskId: "task-2",
      displayedAt: "2026-08-19T12:00:25.000Z",
      matchedGoldTaskId: gold.goldTaskId,
      actionScopeCorrect: true,
      displayedOwnerKey: "personaj@example.com",
      clientContinuity: "recovered",
    },
  ];
  const evaluationInput: LiveTaskEvaluationBuildFixture = {
    meetings: [meeting],
    goldLabels: [gold],
    displays,
    taskExistenceKappa: PERFECT_KAPPA,
    ownerLabelKappa: PERFECT_KAPPA,
    reconciliationPreservationPassed: true,
  };
  const input = buildLiveTaskEvaluationInput(evaluationInput);

  assert.equal(input.taskDisplays, DUPLICATE_DISPLAY_COUNT);
  assert.equal(input.taskTruePositives, SINGLE_TRUE_POSITIVE_COUNT);
  assert.deepEqual(input.appearanceLatenciesMs, [DISPLAY_LATENCY_MS]);
  assert.equal(input.correctlyOwnedGoldTasks, SINGLE_OWNED_GOLD_TASK_COUNT);
  assert.equal(input.dataContractPassed, true);
});
