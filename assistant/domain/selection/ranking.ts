import type {
  CapabilityCatalogRow,
  CapabilitySelectionCapability,
  CapabilitySelectionConsidered,
  CapabilitySelectionStatus,
  MeetingExtraction,
  RecommendationExclusionSignalCheck,
  RecommendationMissingSignal,
  RecommendationSignalMatch,
} from "@readymeet/shared";

const SIGNAL_BOOST_HIGH = 30;
const SIGNAL_BOOST_MEDIUM = 15;
const SIGNAL_BOOST_LOW = 5;
const CATEGORY_DUPLICATE_PENALTY = 12;
const MINIMUM_FINAL_SCORE = 70;
const MAX_RECOMMENDATIONS = 4;
const ZERO_SCORE_DELTA = 0;

export const SELECTION_SCORING = {
  signalBoosts: {
    high: SIGNAL_BOOST_HIGH,
    medium: SIGNAL_BOOST_MEDIUM,
    low: SIGNAL_BOOST_LOW,
  },
  // Keeps one category from monopolizing the top slots while still allowing a
  // clearly stronger second capability in the same category to survive.
  categoryDuplicatePenalty: CATEGORY_DUPLICATE_PENALTY,
  // Seed priorities are 1-100. A threshold of 70 keeps low-signal base rows out
  // while allowing strong catalog priorities plus one relevant signal through.
  minimumFinalScore: MINIMUM_FINAL_SCORE,
  maxRecommendations: MAX_RECOMMENDATIONS,
} as const;

const REMOVED_CAPABILITY_KEYS = new Set([
  "generate_comprehensive_notes",
  "create_task_list",
  "draft_decision_brief",
  "draft_internal_recap",
  "draft_spec_outline",
  "prepare_briefing_for_next_meeting",
]);

function isAlwaysAvailableCapability(capability: CapabilityCatalogRow) {
  return capability.metadata.alwaysAvailable === true;
}

export interface RankedCapability {
  capability: CapabilitySelectionCapability;
  rawScore: number;
  finalScore: number;
  signalsMatched: RecommendationSignalMatch[];
  signalsMissing: RecommendationMissingSignal[];
  exclusionSignalsChecked: RecommendationExclusionSignalCheck[];
  status: CapabilitySelectionStatus;
}

interface CapabilityRankingResult {
  recommended: RankedCapability[];
  considered: CapabilitySelectionConsidered[];
}

function signalIdentity(params: { namespace: string | undefined; key: string }) {
  const { namespace, key } = params;

  return `${namespace ?? "readymeet.core"}:${key}`;
}

function toSelectionCapability(capability: CapabilityCatalogRow): CapabilitySelectionCapability {
  return {
    key: capability.key,
    name: capability.name,
    description: capability.description,
    category: capability.category,
    applicableMeetingTypes: capability.applicableMeetingTypes,
    requiredSignals: capability.requiredSignals,
    exclusionSignals: capability.exclusionSignals,
    defaultPriority: capability.defaultPriority,
  };
}

function compareScoreDelta(params: { left: number; right: number }): number | null {
  const delta = params.right - params.left;

  return delta !== ZERO_SCORE_DELTA ? delta : null;
}

function compareCapabilities(params: { left: RankedCapability; right: RankedCapability }) {
  const { left, right } = params;
  const finalScoreDelta = compareScoreDelta({ left: left.finalScore, right: right.finalScore });
  if (finalScoreDelta !== null) {
    return finalScoreDelta;
  }
  const rawScoreDelta = compareScoreDelta({ left: left.rawScore, right: right.rawScore });
  if (rawScoreDelta !== null) {
    return rawScoreDelta;
  }
  const priorityDelta = compareScoreDelta({
    left: left.capability.defaultPriority,
    right: right.capability.defaultPriority,
  });
  if (priorityDelta !== null) {
    return priorityDelta;
  }

  return left.capability.key.localeCompare(right.capability.key);
}

function rankCatalogCapability(input: {
  catalogCapability: CapabilityCatalogRow;
  extraction: Pick<MeetingExtraction, "meetingType">;
  signalByKey: Map<string, MeetingExtraction["signals"][number]>;
}): RankedCapability | null {
  if (
    REMOVED_CAPABILITY_KEYS.has(input.catalogCapability.key) ||
    isAlwaysAvailableCapability(input.catalogCapability)
  ) {
    return null;
  }

  const capability = toSelectionCapability(input.catalogCapability);
  const isMeetingTypeMatch =
    capability.applicableMeetingTypes.length === 0 ||
    input.extraction.meetingType === null ||
    input.extraction.meetingType === "other" ||
    capability.applicableMeetingTypes.includes(input.extraction.meetingType);
  const exclusionSignalsChecked = capability.exclusionSignals.map((reference) => {
    const signal = input.signalByKey.get(signalIdentity({ namespace: "readymeet.core", key: reference.key }));
    const isExcluded = signal !== undefined && signal.confidence !== "low";

    return {
      key: reference.key,
      // @external present
      present: signal !== undefined,
      confidence: signal?.confidence,
      // @external excluded
      excluded: isExcluded,
      description: reference.description,
    };
  });
  const requiredSignals = capability.requiredSignals.map((reference) => {
    const signal = input.signalByKey.get(signalIdentity({ namespace: "readymeet.core", key: reference.key }));
    if (signal === undefined) {
      return { matched: null, missing: { key: reference.key, description: reference.description } };
    }

    const score = SELECTION_SCORING.signalBoosts[signal.confidence];

    return {
      matched: { key: reference.key, confidence: signal.confidence, score, description: reference.description },
      missing: null,
    };
  });
  const signalsMatched = requiredSignals.flatMap((entry) => (entry.matched === null ? [] : [entry.matched]));
  const signalsMissing = requiredSignals.flatMap((entry) => (entry.missing === null ? [] : [entry.missing]));
  const rawScore = capability.defaultPriority + signalsMatched.reduce((sum, match) => sum + match.score, 0);
  const status: CapabilitySelectionStatus = !isMeetingTypeMatch
    ? "meeting_type_mismatch"
    : exclusionSignalsChecked.some((check) => check.excluded)
      ? "excluded_by_signal"
      : signalsMissing.length !== 0
        ? "required_signals_absent"
        : "recommended";

  return {
    capability,
    rawScore,
    finalScore: rawScore,
    signalsMatched,
    signalsMissing,
    exclusionSignalsChecked,
    status,
  };
}

function applyCategoryPenalties(candidates: RankedCapability[]) {
  return candidates.reduce<{ counts: Map<string, number>; items: RankedCapability[] }>(
    (state, candidate) => {
      const priorCount = state.counts.get(candidate.capability.category) ?? 0;
      const counts = new Map(state.counts);
      counts.set(candidate.capability.category, priorCount + 1);

      return {
        counts,
        items: [
          ...state.items,
          {
            ...candidate,
            finalScore: candidate.rawScore - priorCount * SELECTION_SCORING.categoryDuplicatePenalty,
          },
        ],
      };
    },
    { counts: new Map(), items: [] },
  ).items;
}

function selectRecommendations(finalSorted: RankedCapability[]) {
  return finalSorted.reduce<{ recommended: RankedCapability[]; statuses: Map<string, CapabilitySelectionStatus> }>(
    (state, candidate) => {
      const status: CapabilitySelectionStatus =
        candidate.finalScore < SELECTION_SCORING.minimumFinalScore
          ? "score_below_threshold"
          : state.recommended.length >= SELECTION_SCORING.maxRecommendations
            ? "outranked"
            : "recommended";
      const statuses = new Map(state.statuses);
      statuses.set(candidate.capability.key, status);

      return {
        recommended: status === "recommended" ? [...state.recommended, { ...candidate, status }] : state.recommended,
        statuses,
      };
    },
    { recommended: [], statuses: new Map() },
  );
}

export function rankCapabilities(params: {
  extraction: Pick<MeetingExtraction, "meetingType" | "signals">;
  capabilities: CapabilityCatalogRow[];
}): CapabilityRankingResult {
  const { extraction, capabilities } = params;
  const signalByKey = new Map(
    extraction.signals.map(
      (signal) => [signalIdentity({ namespace: signal.namespace, key: signal.key }), signal] as const,
    ),
  );
  const consideredByKey = new Map<string, RankedCapability>();
  const candidates = capabilities.flatMap((catalogCapability) => {
    const ranked = rankCatalogCapability({ catalogCapability, extraction, signalByKey });
    if (ranked === null) {
      return [];
    }
    consideredByKey.set(ranked.capability.key, ranked);

    return ranked.status === "recommended" ? [ranked] : [];
  });
  const rawSorted = [...candidates].sort((left, right) => {
    const rawScoreDelta = compareScoreDelta({ left: left.rawScore, right: right.rawScore });
    if (rawScoreDelta !== null) {
      return rawScoreDelta;
    }
    const priorityDelta = compareScoreDelta({
      left: left.capability.defaultPriority,
      right: right.capability.defaultPriority,
    });
    if (priorityDelta !== null) {
      return priorityDelta;
    }

    return left.capability.key.localeCompare(right.capability.key);
  });
  const penalized = applyCategoryPenalties(rawSorted);
  const scoreByKey = new Map(penalized.map((item) => [item.capability.key, item]));
  const selection = selectRecommendations([...penalized].sort((left, right) => compareCapabilities({ left, right })));
  const considered = [...consideredByKey.values()]
    .map((item) => {
      const scored = scoreByKey.get(item.capability.key) ?? item;

      return { ...scored, status: selection.statuses.get(item.capability.key) ?? scored.status };
    })
    .sort((left, right) => compareCapabilities({ left, right }))
    .map((item) => ({
      capability: item.capability,
      rawScore: item.rawScore,
      finalScore: item.finalScore,
      signalsMatched: item.signalsMatched,
      signalsMissing: item.signalsMissing,
      exclusionSignalsChecked: item.exclusionSignalsChecked,
      status: item.status,
    }));

  return { recommended: selection.recommended, considered };
}
