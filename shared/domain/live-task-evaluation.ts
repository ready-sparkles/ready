const WILSON_Z_SCORE = 1.959963984540054;
const WILSON_DENOMINATOR_OFFSET = 2;
const WILSON_VARIANCE_DIVISOR = 4;
const PERCENTILE_MIN = 0;
const PERCENTILE_MAX = 1;
const PERCENTILE_MEDIAN = 0.5;
const PERCENTILE_P95 = 0.95;
const MIN_ANNOTATOR_COUNT = 2;
const ACTION_CONFIRMATION_GAP_MS = 60_000;
const MIN_DEVELOPMENT_MEETING_COUNT = 200;
const MIN_HOLDOUT_MEETING_COUNT = 100;
const MIN_GOLD_CONFIRMATIONS = 400;
const MIN_ENGLISH_DOMINANT_HOLDOUT = 40;
const MIN_FINNISH_DOMINANT_HOLDOUT = 30;
const MIN_MIXED_HOLDOUT = 15;
const MIN_OTHER_HOLDOUT = 15;
const MIN_REGIONAL_SPEECH_HOLDOUT = 30;
const MIN_NOISY_HOLDOUT = 30;
const MIN_OVERLAP_SPEAKERS_HOLDOUT = 20;
const MIN_TASK_EXISTENCE_KAPPA = 0.8;
const MIN_OWNER_LABEL_KAPPA = 0.8;
const MIN_CONFIRMATION_PRECISION = 0.95;
const MIN_CONFIRMATION_PRECISION_LOWER_BOUND = 0.92;
const MIN_RECALL = 0.8;
const MIN_OWNER_PRECISION = 0.98;
const MIN_OWNER_PRECISION_LOWER_BOUND = 0.95;
const MIN_OWNER_COVERAGE = 0.9;
const MAX_WRONG_PERSON_RATE = 0.02;
const MIN_LANGUAGE_STRATUM_GOLD_TASKS = 30;
const MIN_LANGUAGE_STRATUM_PRECISION = 0.9;
const MIN_LANGUAGE_STRATUM_OWNER_PRECISION = 0.95;
const MAX_APPEARANCE_LATENCY_P50_MS = 30_000;
const MAX_APPEARANCE_LATENCY_P95_MS = 60_000;

export type LiveTaskEvaluationStratum = {
  name: string;
  goldTaskCount: number;
  taskTruePositives: number;
  taskDisplays: number;
  ownerCorrect: number;
  namedOwnerAssignments: number;
};

export type LiveTaskEvaluationInput = {
  developmentMeetingCount: number;
  holdoutMeetingCount: number;
  holdoutComposition: {
    englishDominant: number;
    finnishDominant: number;
    mixedOrCodeSwitching: number;
    otherLaunchLanguageOrReallocatedMixed: number;
    regionalOrNonNativeSpeechVariation: number;
    noisyOrFarField: number;
    overlapOrFivePlusSpeakers: number;
  };
  goldConfirmableTasks: number;
  modelConfirmations: number;
  taskExistenceKappa: number;
  ownerLabelKappa: number;
  taskTruePositives: number;
  taskDisplays: number;
  eligibleGoldTasks: number;
  matchedEligibleGoldTasks: number;
  ownerCorrect: number;
  namedOwnerAssignments: number;
  explicitOwnerGoldTasks: number;
  correctlyOwnedGoldTasks: number;
  wrongPersonAssignments: number;
  appearanceLatenciesMs: number[];
  /** @external evaluation dataset contract */
  reconciliationPreservationPassed: boolean;
  languageStrata: LiveTaskEvaluationStratum[];
  /** @external evaluation dataset contract */
  dataContractPassed?: boolean;
};

export type LiveTaskEvaluationMeeting = {
  meetingId: string;
  split: "development" | "holdout";
  language: "english" | "finnish" | "mixed" | "other";
  compositionBucket: "english" | "finnish" | "mixed" | "other_or_reallocated";
  /** @external evaluation dataset contract */
  consented: boolean;
  /** @external evaluation dataset contract */
  deidentified: boolean;
  transcriptSource: "actual_final_stt";
  independentAnnotatorCount: number;
  /** @external evaluation dataset contract */
  annotatorsLanguageQualified: boolean;
  /** @external evaluation dataset contract */
  annotatorsBlindedToModel: boolean;
  /** @external evaluation dataset contract */
  adjudicated: boolean;
  regionalOrNonNativeSpeechVariationSource: "self_reported" | "recruitment" | null;
  /** @external evaluation dataset contract */
  noisyOrFarField: boolean;
  /** @external evaluation dataset contract */
  overlapOrFivePlusSpeakers: boolean;
};

export type LiveTaskGoldLabel = {
  meetingId: string;
  goldTaskId: string;
  canonicalActionOutcomeScope: string;
  evidenceSegmentIds: string[];
  actionConfirmableAt: string;
  meetingEndedAt: string;
  ownerKey: string | null;
  ownerEvidenceSegmentIds: string[];
  dueDate: string | null;
  /** @external evaluation dataset contract */
  completedDuringMeeting: boolean;
  /** @external evaluation dataset contract */
  cancelledDuringMeeting: boolean;
};

export type LiveTaskFirstDisplay = {
  meetingId: string;
  taskId: string;
  displayedAt: string;
  matchedGoldTaskId: string | null;
  /** @external evaluation dataset contract */
  actionScopeCorrect: boolean;
  displayedOwnerKey: string | null;
  clientContinuity: "continuous" | "recovered";
};

export type LiveTaskRawEvaluationInput = {
  meetings: LiveTaskEvaluationMeeting[];
  goldLabels: LiveTaskGoldLabel[];
  displays: LiveTaskFirstDisplay[];
  taskExistenceKappa: number;
  ownerLabelKappa: number;
  /** @external evaluation dataset contract */
  reconciliationPreservationPassed: boolean;
};

export function wilsonLowerBound(input: { successes: number; total: number; z?: number }): number {
  const z = input.z ?? WILSON_Z_SCORE;
  if (input.total <= 0) {
    return 0;
  }
  const proportion = input.successes / input.total;
  const denominator = 1 + (z * z) / input.total;
  const centre = proportion + (z * z) / (WILSON_DENOMINATOR_OFFSET * input.total);
  const margin =
    z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (WILSON_VARIANCE_DIVISOR * input.total)) / input.total);

  return (centre - margin) / denominator;
}

export function percentile(input: { values: number[]; quantile: number }): number {
  if (input.values.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const sorted = [...input.values].sort((left, right) => left - right);
  const index = Math.ceil(Math.min(PERCENTILE_MAX, Math.max(PERCENTILE_MIN, input.quantile)) * sorted.length) - 1;
  const value = sorted[Math.max(0, index)];
  if (value === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  return value;
}

type ScoredLiveTaskDisplay = {
  display: LiveTaskFirstDisplay;
  gold: LiveTaskGoldLabel | null;
  isTaskCorrect: boolean;
  isOwnerCorrect: boolean;
};

const isFirstDisplayForTask = (input: {
  display: LiveTaskFirstDisplay;
  index: number;
  displays: LiveTaskFirstDisplay[];
}): boolean =>
  input.displays.findIndex(
    (candidate) => candidate.meetingId === input.display.meetingId && candidate.taskId === input.display.taskId,
  ) === input.index;

const collectHoldoutFirstDisplays = (input: {
  displays: LiveTaskFirstDisplay[];
  holdoutMeetingIds: Set<string>;
}): LiveTaskFirstDisplay[] =>
  [...input.displays]
    .filter((display) => input.holdoutMeetingIds.has(display.meetingId))
    .sort((left, right) => Date.parse(left.displayedAt) - Date.parse(right.displayedAt))
    .filter((display, index, all) => isFirstDisplayForTask({ display, index, displays: all }));

const scoreLiveTaskDisplays = (input: {
  firstDisplays: LiveTaskFirstDisplay[];
  goldByKey: Map<string, LiveTaskGoldLabel>;
}): ScoredLiveTaskDisplay[] => {
  const matchedGoldKeys = new Set<string>();

  return input.firstDisplays.map((display) => {
    const goldKey =
      display.matchedGoldTaskId !== null && display.matchedGoldTaskId !== ""
        ? `${display.meetingId}:${display.matchedGoldTaskId}`
        : null;
    const gold = goldKey !== null ? (input.goldByKey.get(goldKey) ?? null) : null;
    const isDuplicate = goldKey !== null && matchedGoldKeys.has(goldKey);
    const isTaskCorrect = gold !== null && display.actionScopeCorrect && !isDuplicate;
    if (isTaskCorrect && goldKey !== null) {
      matchedGoldKeys.add(goldKey);
    }
    const isOwnerCorrect =
      gold !== null &&
      isTaskCorrect &&
      display.displayedOwnerKey !== null &&
      display.displayedOwnerKey !== "" &&
      gold.ownerKey === display.displayedOwnerKey;

    return { display, gold, isTaskCorrect, isOwnerCorrect };
  });
};

const buildLiveTaskLanguageStrata = (input: {
  holdoutMeetings: LiveTaskEvaluationMeeting[];
  holdoutGold: LiveTaskGoldLabel[];
  scoredDisplays: ScoredLiveTaskDisplay[];
}): LiveTaskEvaluationStratum[] =>
  (["english", "finnish", "mixed", "other"] as const).map((language) => {
    const meetingIds = new Set(
      input.holdoutMeetings.filter((meeting) => meeting.language === language).map((meeting) => meeting.meetingId),
    );
    const goldTaskCount = input.holdoutGold.filter((label) => meetingIds.has(label.meetingId)).length;
    const displays = input.scoredDisplays.filter((entry) => meetingIds.has(entry.display.meetingId));

    return {
      name: language,
      goldTaskCount,
      taskTruePositives: displays.filter((entry) => entry.isTaskCorrect).length,
      taskDisplays: displays.length,
      ownerCorrect: displays.filter((entry) => entry.isOwnerCorrect).length,
      namedOwnerAssignments: displays.filter((entry) => entry.display.displayedOwnerKey !== null).length,
    };
  });

const isLiveTaskDataContractPassed = (input: {
  meetings: LiveTaskEvaluationMeeting[];
  goldLabels: LiveTaskGoldLabel[];
  meetingById: Map<string, LiveTaskEvaluationMeeting>;
}): boolean =>
  input.meetings.every(
    (meeting) =>
      meeting.consented &&
      meeting.deidentified &&
      meeting.independentAnnotatorCount >= MIN_ANNOTATOR_COUNT &&
      meeting.annotatorsLanguageQualified &&
      meeting.annotatorsBlindedToModel &&
      meeting.adjudicated,
  ) &&
  input.goldLabels.every(
    (label) =>
      input.meetingById.has(label.meetingId) &&
      label.canonicalActionOutcomeScope.trim().length > 0 &&
      label.evidenceSegmentIds.length !== 0 &&
      Number.isFinite(Date.parse(label.actionConfirmableAt)) &&
      Number.isFinite(Date.parse(label.meetingEndedAt)) &&
      (label.ownerKey === null || label.ownerEvidenceSegmentIds.length !== 0),
  ) &&
  new Set(input.meetings.map((meeting) => meeting.meetingId)).size === input.meetings.length &&
  new Set(input.goldLabels.map((label) => `${label.meetingId}:${label.goldTaskId}`)).size === input.goldLabels.length;

const buildHoldoutComposition = (holdoutMeetings: LiveTaskEvaluationMeeting[]) => ({
  englishDominant: holdoutMeetings.filter((meeting) => meeting.compositionBucket === "english").length,
  finnishDominant: holdoutMeetings.filter((meeting) => meeting.compositionBucket === "finnish").length,
  mixedOrCodeSwitching: holdoutMeetings.filter((meeting) => meeting.compositionBucket === "mixed").length,
  otherLaunchLanguageOrReallocatedMixed: holdoutMeetings.filter(
    (meeting) => meeting.compositionBucket === "other_or_reallocated",
  ).length,
  regionalOrNonNativeSpeechVariation: holdoutMeetings.filter(
    (meeting) => meeting.regionalOrNonNativeSpeechVariationSource !== null,
  ).length,
  noisyOrFarField: holdoutMeetings.filter((meeting) => meeting.noisyOrFarField).length,
  overlapOrFivePlusSpeakers: holdoutMeetings.filter((meeting) => meeting.overlapOrFivePlusSpeakers).length,
});

export function buildLiveTaskEvaluationInput(raw: LiveTaskRawEvaluationInput): LiveTaskEvaluationInput {
  const meetingById = new Map(raw.meetings.map((meeting) => [meeting.meetingId, meeting]));
  const holdoutMeetingIds = new Set(
    raw.meetings.filter((meeting) => meeting.split === "holdout").map((meeting) => meeting.meetingId),
  );
  const holdoutGold = raw.goldLabels.filter((label) => holdoutMeetingIds.has(label.meetingId));
  const goldByKey = new Map(holdoutGold.map((label) => [`${label.meetingId}:${label.goldTaskId}`, label]));
  const firstDisplays = collectHoldoutFirstDisplays({ displays: raw.displays, holdoutMeetingIds });
  const scoredDisplays = scoreLiveTaskDisplays({ firstDisplays, goldByKey });
  const eligibleGold = holdoutGold.filter(
    (label) => Date.parse(label.meetingEndedAt) - Date.parse(label.actionConfirmableAt) >= ACTION_CONFIRMATION_GAP_MS,
  );
  const matchedEligibleGold = new Set(
    scoredDisplays.flatMap((entry) => {
      if (entry.isTaskCorrect && entry.gold !== null && eligibleGold.includes(entry.gold)) {
        return [`${entry.gold.meetingId}:${entry.gold.goldTaskId}`];
      }

      return [];
    }),
  );
  const explicitOwnerGold = holdoutGold.filter((label) => label.ownerKey !== null);
  const correctlyOwnedGold = new Set(
    scoredDisplays.flatMap((entry) => {
      if (entry.isOwnerCorrect && entry.gold !== null) {
        return [`${entry.gold.meetingId}:${entry.gold.goldTaskId}`];
      }

      return [];
    }),
  );
  const namedOwnerDisplays = scoredDisplays.filter((entry) => entry.display.displayedOwnerKey !== null);
  const appearanceLatenciesMs = scoredDisplays
    .flatMap((entry) => {
      if (entry.isTaskCorrect && entry.gold !== null && entry.display.clientContinuity === "continuous") {
        return [Date.parse(entry.display.displayedAt) - Date.parse(entry.gold.actionConfirmableAt)];
      }

      return [];
    })
    .filter((latency) => Number.isFinite(latency) && latency >= 0);
  const holdoutMeetings = raw.meetings.filter((meeting) => meeting.split === "holdout");

  return {
    developmentMeetingCount: raw.meetings.filter((meeting) => meeting.split === "development").length,
    holdoutMeetingCount: holdoutMeetings.length,
    holdoutComposition: buildHoldoutComposition(holdoutMeetings),
    goldConfirmableTasks: holdoutGold.length,
    modelConfirmations: firstDisplays.length,
    taskExistenceKappa: raw.taskExistenceKappa,
    ownerLabelKappa: raw.ownerLabelKappa,
    taskTruePositives: scoredDisplays.filter((entry) => entry.isTaskCorrect).length,
    taskDisplays: firstDisplays.length,
    eligibleGoldTasks: eligibleGold.length,
    matchedEligibleGoldTasks: matchedEligibleGold.size,
    ownerCorrect: scoredDisplays.filter((entry) => entry.isOwnerCorrect).length,
    namedOwnerAssignments: namedOwnerDisplays.length,
    explicitOwnerGoldTasks: explicitOwnerGold.length,
    correctlyOwnedGoldTasks: correctlyOwnedGold.size,
    wrongPersonAssignments: namedOwnerDisplays.filter(
      (entry) => entry.isTaskCorrect && entry.gold?.ownerKey !== entry.display.displayedOwnerKey,
    ).length,
    appearanceLatenciesMs,
    reconciliationPreservationPassed: raw.reconciliationPreservationPassed,
    languageStrata: buildLiveTaskLanguageStrata({ holdoutMeetings, holdoutGold, scoredDisplays }),
    dataContractPassed: isLiveTaskDataContractPassed({
      meetings: raw.meetings,
      goldLabels: raw.goldLabels,
      meetingById,
    }),
  };
}

const isLanguageStratumPassing = (stratum: LiveTaskEvaluationStratum): boolean =>
  stratum.goldTaskCount < MIN_LANGUAGE_STRATUM_GOLD_TASKS ||
  (stratum.taskDisplays > 0 &&
    stratum.taskTruePositives / stratum.taskDisplays >= MIN_LANGUAGE_STRATUM_PRECISION &&
    stratum.namedOwnerAssignments > 0 &&
    stratum.ownerCorrect / stratum.namedOwnerAssignments >= MIN_LANGUAGE_STRATUM_OWNER_PRECISION);

const buildLiveTaskLaunchGateChecks = (input: {
  evaluation: LiveTaskEvaluationInput;
  precision: number;
  recall: number;
  ownerPrecision: number;
  ownerCoverage: number;
  wrongPersonRate: number;
  p50Ms: number;
  p95Ms: number;
}): Record<string, boolean> => ({
  /** @external launch gate report contract */
  dataContract: input.evaluation.dataContractPassed ?? true,
  /** @external launch gate report contract */
  corpusSize:
    input.evaluation.developmentMeetingCount >= MIN_DEVELOPMENT_MEETING_COUNT &&
    input.evaluation.holdoutMeetingCount >= MIN_HOLDOUT_MEETING_COUNT &&
    input.evaluation.goldConfirmableTasks >= MIN_GOLD_CONFIRMATIONS &&
    input.evaluation.modelConfirmations >= MIN_GOLD_CONFIRMATIONS,
  /** @external launch gate report contract */
  corpusComposition:
    input.evaluation.holdoutComposition.englishDominant >= MIN_ENGLISH_DOMINANT_HOLDOUT &&
    input.evaluation.holdoutComposition.finnishDominant >= MIN_FINNISH_DOMINANT_HOLDOUT &&
    input.evaluation.holdoutComposition.mixedOrCodeSwitching >= MIN_MIXED_HOLDOUT &&
    input.evaluation.holdoutComposition.otherLaunchLanguageOrReallocatedMixed >= MIN_OTHER_HOLDOUT &&
    input.evaluation.holdoutComposition.regionalOrNonNativeSpeechVariation >= MIN_REGIONAL_SPEECH_HOLDOUT &&
    input.evaluation.holdoutComposition.noisyOrFarField >= MIN_NOISY_HOLDOUT &&
    input.evaluation.holdoutComposition.overlapOrFivePlusSpeakers >= MIN_OVERLAP_SPEAKERS_HOLDOUT,
  /** @external launch gate report contract */
  annotatorAgreement:
    input.evaluation.taskExistenceKappa >= MIN_TASK_EXISTENCE_KAPPA &&
    input.evaluation.ownerLabelKappa >= MIN_OWNER_LABEL_KAPPA,
  /** @external launch gate report contract */
  confirmationPrecision: input.precision >= MIN_CONFIRMATION_PRECISION,
  /** @external launch gate report contract */
  confirmationPrecisionLowerBound:
    wilsonLowerBound({ successes: input.evaluation.taskTruePositives, total: input.evaluation.taskDisplays }) >=
    MIN_CONFIRMATION_PRECISION_LOWER_BOUND,
  /** @external launch gate report contract */
  recall: input.recall >= MIN_RECALL,
  /** @external launch gate report contract */
  ownerPrecision: input.ownerPrecision >= MIN_OWNER_PRECISION,
  /** @external launch gate report contract */
  ownerPrecisionLowerBound:
    wilsonLowerBound({ successes: input.evaluation.ownerCorrect, total: input.evaluation.namedOwnerAssignments }) >=
    MIN_OWNER_PRECISION_LOWER_BOUND,
  /** @external launch gate report contract */
  ownerCoverage: input.ownerCoverage >= MIN_OWNER_COVERAGE,
  /** @external launch gate report contract */
  wrongPersonRate: input.wrongPersonRate <= MAX_WRONG_PERSON_RATE,
  /** @external launch gate report contract */
  languageStrata: input.evaluation.languageStrata.every(isLanguageStratumPassing),
  /** @external launch gate report contract */
  appearanceLatency: input.p50Ms <= MAX_APPEARANCE_LATENCY_P50_MS && input.p95Ms <= MAX_APPEARANCE_LATENCY_P95_MS,
  /** @external launch gate report contract */
  reconciliationPreservation: input.evaluation.reconciliationPreservationPassed,
});

export function evaluateLiveTaskLaunchGates(input: LiveTaskEvaluationInput): {
  /** @external launch gate report contract */
  passed: boolean;
  metrics: {
    precision: number;
    recall: number;
    ownerPrecision: number;
    ownerCoverage: number;
    wrongPersonRate: number;
    p50Ms: number;
    p95Ms: number;
  };
  checks: Record<string, boolean>;
} {
  const precision = input.taskDisplays > 0 ? input.taskTruePositives / input.taskDisplays : 0;
  const recall = input.eligibleGoldTasks > 0 ? input.matchedEligibleGoldTasks / input.eligibleGoldTasks : 0;
  const ownerPrecision = input.namedOwnerAssignments > 0 ? input.ownerCorrect / input.namedOwnerAssignments : 0;
  const ownerCoverage =
    input.explicitOwnerGoldTasks > 0 ? input.correctlyOwnedGoldTasks / input.explicitOwnerGoldTasks : 0;
  const wrongPersonRate =
    input.namedOwnerAssignments > 0 ? input.wrongPersonAssignments / input.namedOwnerAssignments : 0;
  const p50Ms = percentile({ values: input.appearanceLatenciesMs, quantile: PERCENTILE_MEDIAN });
  const p95Ms = percentile({ values: input.appearanceLatenciesMs, quantile: PERCENTILE_P95 });
  const checks = buildLiveTaskLaunchGateChecks({
    evaluation: input,
    precision,
    recall,
    ownerPrecision,
    ownerCoverage,
    wrongPersonRate,
    p50Ms,
    p95Ms,
  });
  const isPassed = Object.values(checks).every((isCheck) => isCheck);

  return {
    /** @external launch gate report contract */
    passed: isPassed,
    metrics: { precision, recall, ownerPrecision, ownerCoverage, wrongPersonRate, p50Ms, p95Ms },
    checks,
  };
}
