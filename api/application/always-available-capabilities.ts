import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { CapabilityCatalogRow, CapabilityRecommendationRow } from "@readymeet/shared";

import { repositories } from "../ports/repository-runtime";

type RuntimeParticipant = Awaited<ReturnType<RepositoryPort["getMeetingRuntimeState"]>>["allHumanParticipants"][number];

const HIDDEN_CAPABILITY_RECOMMENDATION_KEYS = new Set([
  "create_task_list",
  "draft_decision_brief",
  "draft_internal_recap",
  "draft_spec_outline",
  "prepare_briefing_for_next_meeting",
]);

export function filterVisibleCapabilityRecommendations<T extends { capabilityKey: string }>(recommendations: T[]): T[] {
  return recommendations.filter(
    (recommendation) => !HIDDEN_CAPABILITY_RECOMMENDATION_KEYS.has(recommendation.capabilityKey),
  );
}

function isAlwaysAvailableCapability(capability: CapabilityCatalogRow) {
  return capability.metadata.alwaysAvailable === true;
}

function formatFollowUpButtonLabel(recipients: RuntimeParticipant[]): string {
  const [recipient] = recipients;
  if (recipients.length === 1 && recipient !== undefined) {
    return `Draft follow-up for ${recipient.displayName}`;
  }

  return "Draft email follow-up";
}

type DeterministicCapabilityPayload = {
  /** @external alwaysAvailable */
  alwaysAvailable: boolean;
  buttonLabel: string;
  recipientUserIds: string[];
  recipientDisplayNames: string[];
  source: string;
};

function deterministicPayload(input: {
  buttonLabel: string;
  recipientUserIds?: string[];
  recipientDisplayNames?: string[];
}): DeterministicCapabilityPayload {
  return {
    alwaysAvailable: true,
    buttonLabel: input.buttonLabel,
    recipientUserIds: input.recipientUserIds ?? [],
    recipientDisplayNames: input.recipientDisplayNames ?? [],
    source: "deterministic_default",
  };
}

export async function ensureAlwaysAvailableCapabilityRecommendationsForMeeting(
  meetingId: string,
): Promise<CapabilityRecommendationRow[]> {
  const existingRecommendations = await repositories().getRecommendationsByMeetingId(meetingId);
  if (existingRecommendations.length === 0) {
    return existingRecommendations;
  }

  const meeting = await repositories().getMeetingById(meetingId);
  if (!meeting) {
    return filterVisibleCapabilityRecommendations(existingRecommendations);
  }

  const [runtimeState, capabilities] = await Promise.all([
    repositories().getMeetingRuntimeState(meetingId),
    repositories().listEnabledCapabilitiesForUser(meeting.createdByUserId),
  ]);
  const capabilitiesByKey = new Map(capabilities.map((capability) => [capability.key, capability]));
  const existingKeys = new Set(existingRecommendations.map((recommendation) => recommendation.capabilityKey));
  const firstRecommendation = existingRecommendations[0];
  if (firstRecommendation === undefined) {
    return filterVisibleCapabilityRecommendations(existingRecommendations);
  }
  const nextRank = Math.max(...existingRecommendations.map((recommendation) => recommendation.rank)) + 1;
  const coaching = capabilitiesByKey.get("meeting_coaching");
  const coachingRecommendations: Parameters<RepositoryPort["insertCapabilityRecommendations"]>[0] =
    coaching && isAlwaysAvailableCapability(coaching) && !existingKeys.has(coaching.key)
      ? [
          {
            meetingId,
            extractionId: firstRecommendation.extractionId,
            capabilityKey: coaching.key,
            rank: nextRank,
            rawScore: coaching.defaultPriority,
            finalScore: coaching.defaultPriority,
            signalsMatched: [],
            signalsMissing: [],
            exclusionSignalsChecked: [],
            reasoning: "Meeting feedback is available for every completed meeting.",
            payload: deterministicPayload({ buttonLabel: "Review how the meeting went" }),
            confidence: "high",
            selectionPromptVersion: firstRecommendation.selectionPromptVersion,
            selectionModel: "deterministic-default",
          },
        ]
      : [];

  const followUp = capabilitiesByKey.get("draft_participant_follow_up");
  const recipients = runtimeState.allHumanParticipants.filter(
    (participant) => participant.userId !== meeting.createdByUserId,
  );
  const followUpRecommendations: Parameters<RepositoryPort["insertCapabilityRecommendations"]>[0] =
    followUp &&
    isAlwaysAvailableCapability(followUp) &&
    !existingKeys.has(followUp.key) &&
    !existingKeys.has("draft_external_follow_up") &&
    recipients.length !== 0
      ? [
          {
            meetingId,
            extractionId: firstRecommendation.extractionId,
            capabilityKey: followUp.key,
            rank: nextRank + coachingRecommendations.length,
            rawScore: followUp.defaultPriority,
            finalScore: followUp.defaultPriority,
            signalsMatched: [],
            signalsMissing: [],
            exclusionSignalsChecked: [],
            reasoning: "A participant follow-up draft is available because other people attended the meeting.",
            payload: deterministicPayload({
              buttonLabel: formatFollowUpButtonLabel(recipients),
              recipientUserIds: recipients.map((participant) => participant.userId),
              recipientDisplayNames: recipients.map((participant) => participant.displayName),
            }),
            confidence: "high",
            selectionPromptVersion: firstRecommendation.selectionPromptVersion,
            selectionModel: "deterministic-default",
          },
        ]
      : [];

  const recommendationsToInsert = [...coachingRecommendations, ...followUpRecommendations];

  if (recommendationsToInsert.length === 0) {
    return filterVisibleCapabilityRecommendations(existingRecommendations);
  }

  return filterVisibleCapabilityRecommendations(
    await repositories().insertCapabilityRecommendations(recommendationsToInsert),
  );
}
