const ASSISTANT_IDENTITY_PREFIX = "readymeet-assistant-";
const UUID_WITH_OPTIONAL_SUFFIX_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?::.+)?$/i;
const DEFAULT_SPEAKER_LABEL = "Speaker";
const ASSISTANT_SPEAKER_LABEL = "Assistant";
const LOCAL_SPEAKER_LABEL = "You";
const PARTICIPANT_SPEAKER_LABEL = "Participant";

type LiveTranscriptParticipantLike = {
  identity: string;
  name?: string | null;
  attributes?: Record<string, string | undefined>;
  metadata?: string | null;
};

export function normalizeTranscriptSpeakerName(speakerName: string): string {
  const normalized = speakerName.trim();
  if (normalized.length === 0) {
    return DEFAULT_SPEAKER_LABEL;
  }

  const lower = normalized.toLowerCase();
  if (normalized.startsWith(ASSISTANT_IDENTITY_PREFIX) || lower === "assistant" || lower === "readymeet assistant") {
    return ASSISTANT_SPEAKER_LABEL;
  }

  return normalized;
}

function getParticipantUserId(participant: LiveTranscriptParticipantLike): string | null {
  const attributeUserId = participant.attributes?.userId?.trim();
  if (attributeUserId !== undefined && attributeUserId.length > 0) {
    return attributeUserId;
  }

  const identityPrefix = participant.identity.split(":", 1)[0]?.trim();

  return identityPrefix !== undefined && identityPrefix.length > 0 ? identityPrefix : null;
}

function isMeetingAgentParticipant(participant: LiveTranscriptParticipantLike): boolean {
  return (
    participant.attributes?.assistantRole === "meeting-agent" ||
    participant.identity.startsWith(ASSISTANT_IDENTITY_PREFIX)
  );
}

function getStableSpeakerIdentityFromParticipant(participant: LiveTranscriptParticipantLike): string {
  if (isMeetingAgentParticipant(participant)) {
    return participant.identity;
  }

  return getParticipantUserId(participant) ?? participant.identity;
}

function getAssistantDisplayName(participant: LiveTranscriptParticipantLike): string {
  const attributeDisplayName = participant.attributes?.assistantDisplayName?.trim();
  if (attributeDisplayName !== undefined && attributeDisplayName.length > 0) {
    return attributeDisplayName;
  }

  const normalizedName = participant.name?.trim();
  if (normalizedName !== undefined && normalizedName.length > 0) {
    return normalizedName;
  }

  return ASSISTANT_SPEAKER_LABEL;
}

export function resolveLiveKitTranscriptionSpeaker({
  participantIdentity,
  localParticipant,
  participant,
}: {
  participantIdentity: string;
  localParticipant: LiveTranscriptParticipantLike;
  participant?: LiveTranscriptParticipantLike;
}): { speakerIdentity: string; speakerName: string } {
  const resolvedParticipant = participantIdentity === localParticipant.identity ? localParticipant : participant;

  if (participantIdentity === localParticipant.identity) {
    return {
      speakerIdentity: getStableSpeakerIdentityFromParticipant(localParticipant),
      speakerName: LOCAL_SPEAKER_LABEL,
    };
  }

  if (resolvedParticipant !== undefined && isMeetingAgentParticipant(resolvedParticipant)) {
    return {
      speakerIdentity: resolvedParticipant.identity,
      speakerName: getAssistantDisplayName(resolvedParticipant),
    };
  }

  const resolvedName = resolvedParticipant?.name?.trim();
  const trimmedIdentity = participantIdentity.trim();

  return {
    speakerIdentity: resolvedParticipant
      ? getStableSpeakerIdentityFromParticipant(resolvedParticipant)
      : participantIdentity,
    speakerName:
      resolvedName !== undefined && resolvedName.length > 0
        ? resolvedName
        : trimmedIdentity.length > 0
          ? trimmedIdentity
          : PARTICIPANT_SPEAKER_LABEL,
  };
}

function resolveAssistantVisibleSpeakerName(input: {
  rawSpeakerName: string;
  assistantDisplayName?: string | null;
  presenceDisplayName?: string | null;
}): string {
  const normalizedRawSpeakerName = normalizeTranscriptSpeakerName(input.rawSpeakerName);
  if (normalizedRawSpeakerName !== ASSISTANT_SPEAKER_LABEL) {
    return normalizedRawSpeakerName;
  }

  const assistantName = input.assistantDisplayName?.trim();
  if (assistantName !== undefined && assistantName.length > 0) {
    return assistantName;
  }

  const presenceName = input.presenceDisplayName?.trim();
  if (presenceName !== undefined && presenceName.length > 0) {
    return presenceName;
  }

  return normalizedRawSpeakerName;
}

function isLocalHumanSpeaker(input: { speakerIdentity: string; localUserId?: string | null }): boolean {
  const normalizedLocalUserId = input.localUserId?.trim();
  if (normalizedLocalUserId === undefined || normalizedLocalUserId.length === 0) {
    return false;
  }

  return (
    input.speakerIdentity === normalizedLocalUserId || input.speakerIdentity.startsWith(`${normalizedLocalUserId}:`)
  );
}

export function resolveVisibleTranscriptSpeakerName({
  speakerIdentity,
  rawSpeakerName,
  speakerRole,
  localUserId,
  assistantDisplayName,
  presenceDisplayName,
}: {
  speakerIdentity: string;
  rawSpeakerName: string;
  speakerRole: "human" | "assistant" | "system";
  localUserId?: string | null;
  assistantDisplayName?: string | null;
  presenceDisplayName?: string | null;
}): string {
  if (speakerRole === "human" && isLocalHumanSpeaker({ speakerIdentity, localUserId })) {
    return LOCAL_SPEAKER_LABEL;
  }

  if (rawSpeakerName.trim() === LOCAL_SPEAKER_LABEL) {
    return LOCAL_SPEAKER_LABEL;
  }

  if (speakerRole === "assistant") {
    return resolveAssistantVisibleSpeakerName({
      rawSpeakerName,
      assistantDisplayName,
      presenceDisplayName,
    });
  }

  const presenceName = presenceDisplayName?.trim();
  if (presenceName !== undefined && presenceName.length > 0) {
    return presenceName;
  }

  return normalizeTranscriptSpeakerName(rawSpeakerName);
}

function isGenericHumanSpeakerName(speakerName: string): boolean {
  const normalized = speakerName.trim().toLowerCase();

  return normalized.length === 0 || normalized === "participant" || normalized === "speaker";
}

function isRawUnresolvedSpeakerIdentity({
  speakerIdentity,
  speakerName,
}: {
  speakerIdentity: string;
  speakerName: string;
}): boolean {
  const normalizedIdentity = speakerIdentity.trim();
  const normalizedName = speakerName.trim();

  return normalizedName === normalizedIdentity || UUID_WITH_OPTIONAL_SUFFIX_PATTERN.test(normalizedName);
}

export function shouldShowLiveTranscriptLine({
  speakerIdentity,
  speakerName,
  speakerRole,
  localUserId,
  hasKnownParticipant,
}: {
  speakerIdentity: string;
  speakerName: string;
  speakerRole: "human" | "assistant" | "system";
  localUserId?: string | null;
  hasKnownParticipant?: boolean;
}): boolean {
  if (speakerRole === "assistant") {
    return true;
  }

  if (speakerRole !== "human") {
    return false;
  }

  const normalizedLocalUserId = localUserId?.trim();
  if (
    normalizedLocalUserId !== undefined &&
    normalizedLocalUserId.length > 0 &&
    (speakerIdentity === normalizedLocalUserId || speakerIdentity.startsWith(`${normalizedLocalUserId}:`))
  ) {
    return true;
  }

  if (speakerName.trim() === LOCAL_SPEAKER_LABEL || hasKnownParticipant === true) {
    return true;
  }

  return !isGenericHumanSpeakerName(speakerName) && !isRawUnresolvedSpeakerIdentity({ speakerIdentity, speakerName });
}
