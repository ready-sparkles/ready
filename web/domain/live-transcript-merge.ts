import { buildLiveKitTranscriptSourceSegmentId, type TranscriptSegment } from "@readymeet/shared";

import {
  normalizeTranscriptSpeakerName,
  resolveVisibleTranscriptSpeakerName,
  shouldShowLiveTranscriptLine,
} from "./live-transcript-labels";

const LIVE_TRANSCRIPT_DEDUP_WINDOW_MS = 12_000;
const LIVE_TRANSCRIPT_REVISION_WINDOW_MS = 8_000;
const ASSISTANT_IDENTITY_PREFIX = "readymeet-assistant-";
const MIN_DUPLICATE_CONTENT_LENGTH = 12;
const MIN_STRONG_TOKEN_OVERLAP_COUNT = 4;
const STRONG_TOKEN_OVERLAP_RATIO = 0.8;
const DEFAULT_VISIBLE_TRANSCRIPT_LIMIT = 5;
const IDENTITY_USER_ID_PART_INDEX = 0;

export type LiveTranscriptLine = {
  id: string;
  rawParticipantIdentity: string;
  speakerIdentity: string;
  speakerName: string;
  content: string;
  updatedAt: number;
  isFinal: boolean;
  segmentId: string;
  trackSid?: string;
  sourceSegmentId?: string;
};

export type LiveTranscriptPresenceEntry = {
  id: string;
  userId?: string | null;
  displayName: string;
  email?: string | null;
  avatarUrl?: string | null;
  /** @external live presence UI contract */
  isYou?: boolean;
  /** @external live presence UI contract */
  isAssistant?: boolean;
  subtitle?: string;
};

export type VisibleTranscriptLine = {
  id: string;
  speakerIdentity: string;
  speakerName: string;
  content: string;
  avatarUrl?: string | null;
  email?: string | null;
};

type MergedTranscriptLine = VisibleTranscriptLine & {
  speakerRole: "human" | "assistant" | "system";
  updatedAt: number;
  source: string;
  normalizedContent: string;
  sourceSegmentId?: string | null;
};

export { buildLiveKitTranscriptSourceSegmentId };

function liveTranscriptDisplayId(input: {
  prefix: "db" | "rt";
  fallbackId: string;
  sourceSegmentId?: string | null;
}): string {
  return input.sourceSegmentId !== undefined && input.sourceSegmentId !== null && input.sourceSegmentId.length > 0
    ? `transcript:${input.sourceSegmentId}`
    : `${input.prefix}:${input.fallbackId}`;
}

function normalizeTranscriptContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyDuplicateTranscriptContent(input: { left: string; right: string }): boolean {
  if (input.left.length === 0 || input.right.length === 0) {
    return false;
  }

  if (input.left === input.right) {
    return true;
  }

  const shorter = input.left.length <= input.right.length ? input.left : input.right;
  const longer = input.left.length <= input.right.length ? input.right : input.left;

  if (shorter.length < MIN_DUPLICATE_CONTENT_LENGTH) {
    return false;
  }

  return longer.includes(shorter);
}

function hasStrongTranscriptTokenOverlap(input: { left: string; right: string }): boolean {
  if (input.left.length === 0 || input.right.length === 0) {
    return false;
  }

  const leftTokens = Array.from(new Set(input.left.split(" ").filter((token) => token.length > 0)));
  const rightTokens = Array.from(new Set(input.right.split(" ").filter((token) => token.length > 0)));
  if (leftTokens.length < MIN_STRONG_TOKEN_OVERLAP_COUNT || rightTokens.length < MIN_STRONG_TOKEN_OVERLAP_COUNT) {
    return false;
  }

  const rightTokenSet = new Set(rightTokens);
  const overlappingTokenCount = leftTokens.filter((token) => rightTokenSet.has(token)).length;
  const shorterTokenCount = Math.min(leftTokens.length, rightTokens.length);

  return overlappingTokenCount / shorterTokenCount >= STRONG_TOKEN_OVERLAP_RATIO;
}

function shouldCollapseTranscriptRevision(input: {
  previous: {
    speakerIdentity: string;
    speakerRole?: "human" | "assistant" | "system";
    source?: string;
    updatedAt: number;
    normalizedContent: string;
  };
  next: {
    speakerIdentity: string;
    speakerRole?: "human" | "assistant" | "system";
    source?: string;
    updatedAt: number;
    normalizedContent: string;
  };
}): boolean {
  if (input.previous.speakerIdentity !== input.next.speakerIdentity) {
    return false;
  }

  if (input.previous.speakerRole !== "human" || input.next.speakerRole !== "human") {
    return false;
  }

  if (input.previous.source === "assistant-utterance" || input.next.source === "assistant-utterance") {
    return false;
  }

  if (Math.abs(input.previous.updatedAt - input.next.updatedAt) > LIVE_TRANSCRIPT_REVISION_WINDOW_MS) {
    return false;
  }

  return (
    isLikelyDuplicateTranscriptContent({
      left: input.previous.normalizedContent,
      right: input.next.normalizedContent,
    }) ||
    hasStrongTranscriptTokenOverlap({
      left: input.previous.normalizedContent,
      right: input.next.normalizedContent,
    })
  );
}

function isAssistantSpeakerIdentity(speakerIdentity: string): boolean {
  return speakerIdentity.startsWith(ASSISTANT_IDENTITY_PREFIX);
}

function inferHumanSpeakerUserId(identity?: string | null): string | null {
  const normalized = identity?.trim();
  if (normalized === undefined || normalized.length === 0 || isAssistantSpeakerIdentity(normalized)) {
    return null;
  }

  const identityPrefix = normalized.split(":", 1)[IDENTITY_USER_ID_PART_INDEX]?.trim();

  return identityPrefix !== undefined && identityPrefix.length > 0 ? identityPrefix : null;
}

function isGenericAssistantSpeakerName(speakerName: string): boolean {
  const normalized = speakerName.trim().toLowerCase();

  return normalized === "assistant" || normalized === "readymeet assistant";
}

function mergeMatchingTranscriptLine(input: {
  existing: MergedTranscriptLine;
  next: MergedTranscriptLine;
}): MergedTranscriptLine {
  const updatedAt = Math.min(input.existing.updatedAt, input.next.updatedAt);
  const id =
    input.next.sourceSegmentId !== undefined && input.next.sourceSegmentId !== null
      ? liveTranscriptDisplayId({
          prefix: "rt",
          fallbackId: input.next.id,
          sourceSegmentId: input.next.sourceSegmentId,
        })
      : input.next.id;

  const isExistingRealtime = input.existing.source === "livekit-room";
  const isNextRealtime = input.next.source === "livekit-room";
  const shouldPreferNextContent =
    isExistingRealtime ||
    !isNextRealtime ||
    (input.existing.normalizedContent.length < input.next.normalizedContent.length &&
      isLikelyDuplicateTranscriptContent({
        left: input.existing.normalizedContent,
        right: input.next.normalizedContent,
      }));

  const content = shouldPreferNextContent ? input.next.content : input.existing.content;
  const normalizedContent = shouldPreferNextContent ? input.next.normalizedContent : input.existing.normalizedContent;
  const source = isExistingRealtime && !isNextRealtime ? input.next.source : input.existing.source;
  const shouldPreferNextSpeaker =
    isGenericAssistantSpeakerName(input.existing.speakerName) && !isGenericAssistantSpeakerName(input.next.speakerName);

  return {
    ...input.existing,
    updatedAt,
    id,
    content,
    normalizedContent,
    source,
    speakerName: shouldPreferNextSpeaker ? input.next.speakerName : input.existing.speakerName,
    avatarUrl: shouldPreferNextSpeaker ? input.next.avatarUrl : input.existing.avatarUrl,
    email: shouldPreferNextSpeaker ? input.next.email : input.existing.email,
  };
}

function findPresenceEntryForSegment(input: {
  segment: TranscriptSegment;
  canonicalSpeakerIdentity: string;
  speakerName: string;
  presenceEntries: LiveTranscriptPresenceEntry[];
}): LiveTranscriptPresenceEntry | undefined {
  if (input.segment.speakerRole === "assistant") {
    return input.presenceEntries.find(
      (entry) =>
        (input.segment.agentOwnerUserId !== undefined &&
          input.segment.agentOwnerUserId !== null &&
          input.segment.agentOwnerUserId.length > 0 &&
          entry.isAssistant === true &&
          entry.userId === input.segment.agentOwnerUserId) ||
        entry.id === input.canonicalSpeakerIdentity ||
        entry.id === input.segment.speakerIdentity ||
        entry.displayName === input.speakerName,
    );
  }

  const segmentSpeakerUserId = input.segment.speakerUserId?.trim();
  const speakerUserId =
    (segmentSpeakerUserId !== undefined && segmentSpeakerUserId.length > 0 ? segmentSpeakerUserId : null) ??
    inferHumanSpeakerUserId(input.canonicalSpeakerIdentity) ??
    inferHumanSpeakerUserId(input.segment.speakerIdentity);

  return input.presenceEntries.find(
    (entry) =>
      (speakerUserId !== null && entry.userId === speakerUserId) ||
      entry.id === input.canonicalSpeakerIdentity ||
      entry.id === input.segment.speakerIdentity ||
      entry.displayName === input.speakerName,
  );
}

function findPresenceEntryForRealtimeLine(input: {
  line: LiveTranscriptLine;
  normalizedLineSpeakerName: string;
  presenceEntries: LiveTranscriptPresenceEntry[];
}): LiveTranscriptPresenceEntry | undefined {
  const speakerUserId =
    inferHumanSpeakerUserId(input.line.speakerIdentity) ?? inferHumanSpeakerUserId(input.line.rawParticipantIdentity);

  return input.presenceEntries.find(
    (entry) =>
      (speakerUserId !== null && entry.userId === speakerUserId) ||
      entry.id === input.line.speakerIdentity ||
      entry.userId === input.line.speakerIdentity ||
      entry.id === input.line.rawParticipantIdentity ||
      entry.displayName === input.normalizedLineSpeakerName,
  );
}

function buildSegmentTranscriptLine(input: {
  segment: TranscriptSegment;
  presenceEntries: LiveTranscriptPresenceEntry[];
  localUserId?: string | null;
  assistantDisplayNamesByIdentity: Record<string, string>;
}): MergedTranscriptLine | null {
  if (input.segment.speakerRole !== "human" && input.segment.speakerRole !== "assistant") {
    return null;
  }

  const speakerRole = input.segment.speakerRole;
  const canonicalSpeakerIdentity =
    speakerRole === "human"
      ? (input.segment.speakerUserId ?? input.segment.speakerIdentity)
      : input.segment.speakerIdentity;
  const normalizedRawSpeakerName = normalizeTranscriptSpeakerName(input.segment.speakerName);
  const matchingPresenceEntry = findPresenceEntryForSegment({
    segment: input.segment,
    canonicalSpeakerIdentity,
    speakerName: normalizedRawSpeakerName,
    presenceEntries: input.presenceEntries,
  });
  const speakerName = resolveVisibleTranscriptSpeakerName({
    speakerIdentity: canonicalSpeakerIdentity,
    rawSpeakerName: input.segment.speakerName,
    speakerRole,
    localUserId: input.localUserId,
    assistantDisplayName:
      input.assistantDisplayNamesByIdentity[canonicalSpeakerIdentity] ??
      input.assistantDisplayNamesByIdentity[input.segment.speakerIdentity],
    presenceDisplayName: matchingPresenceEntry?.displayName,
  });
  const hasKnownParticipant = true;
  if (
    !shouldShowLiveTranscriptLine({
      speakerIdentity: canonicalSpeakerIdentity,
      speakerName,
      speakerRole,
      localUserId: input.localUserId,
      hasKnownParticipant,
    })
  ) {
    return null;
  }

  return {
    id: liveTranscriptDisplayId({
      prefix: "db",
      fallbackId: input.segment.id,
      sourceSegmentId: input.segment.sourceSegmentId,
    }),
    speakerIdentity: canonicalSpeakerIdentity,
    speakerRole,
    speakerName,
    content: input.segment.content,
    updatedAt: new Date(input.segment.startedAt).getTime(),
    source: input.segment.source,
    sourceSegmentId: input.segment.sourceSegmentId,
    avatarUrl: matchingPresenceEntry?.avatarUrl,
    email: matchingPresenceEntry?.email,
    normalizedContent: normalizeTranscriptContent(input.segment.content),
  };
}

function mergeRealtimeTranscriptLine(input: {
  merged: MergedTranscriptLine[];
  line: LiveTranscriptLine;
  presenceEntries: LiveTranscriptPresenceEntry[];
  localUserId?: string | null;
  assistantDisplayNamesByIdentity: Record<string, string>;
}): MergedTranscriptLine[] {
  const normalizedLineSpeakerName = normalizeTranscriptSpeakerName(input.line.speakerName);
  const matchingPresenceEntry = findPresenceEntryForRealtimeLine({
    line: input.line,
    normalizedLineSpeakerName,
    presenceEntries: input.presenceEntries,
  });
  const speakerRole =
    isAssistantSpeakerIdentity(input.line.speakerIdentity) ||
    isAssistantSpeakerIdentity(input.line.rawParticipantIdentity)
      ? "assistant"
      : "human";
  const speakerName = resolveVisibleTranscriptSpeakerName({
    speakerIdentity: input.line.speakerIdentity,
    rawSpeakerName: input.line.speakerName,
    speakerRole,
    localUserId: input.localUserId,
    assistantDisplayName: input.assistantDisplayNamesByIdentity[input.line.speakerIdentity],
    presenceDisplayName: matchingPresenceEntry?.displayName,
  });
  const normalizedContent = normalizeTranscriptContent(input.line.content);
  if (
    !shouldShowLiveTranscriptLine({
      speakerIdentity: input.line.speakerIdentity,
      speakerName,
      speakerRole,
      localUserId: input.localUserId,
      hasKnownParticipant: matchingPresenceEntry !== undefined,
    })
  ) {
    return input.merged;
  }

  const nextLine: MergedTranscriptLine = {
    id: liveTranscriptDisplayId({
      prefix: "rt",
      fallbackId: input.line.id,
      sourceSegmentId: input.line.sourceSegmentId,
    }),
    speakerIdentity: input.line.speakerIdentity,
    speakerRole,
    speakerName,
    content: input.line.content,
    updatedAt: input.line.updatedAt,
    source: speakerRole === "assistant" ? "assistant-utterance" : "livekit-room",
    sourceSegmentId: input.line.sourceSegmentId,
    avatarUrl: matchingPresenceEntry?.avatarUrl,
    email: matchingPresenceEntry?.email,
    normalizedContent,
  };

  const sourceDuplicate =
    nextLine.sourceSegmentId !== undefined && nextLine.sourceSegmentId !== null
      ? input.merged.find((existing) => existing.sourceSegmentId === nextLine.sourceSegmentId)
      : undefined;
  if (sourceDuplicate !== undefined) {
    return input.merged.map((existing) =>
      existing === sourceDuplicate ? mergeMatchingTranscriptLine({ existing, next: nextLine }) : existing,
    );
  }

  const duplicateLine = input.merged.find(
    (existing) =>
      existing.speakerIdentity === input.line.speakerIdentity &&
      isLikelyDuplicateTranscriptContent({ left: existing.normalizedContent, right: normalizedContent }) &&
      Math.abs(existing.updatedAt - input.line.updatedAt) <= LIVE_TRANSCRIPT_DEDUP_WINDOW_MS,
  );

  if (duplicateLine !== undefined) {
    return input.merged.map((existing) =>
      existing === duplicateLine ? mergeMatchingTranscriptLine({ existing, next: nextLine }) : existing,
    );
  }

  const revisionLine = [...input.merged].reverse().find((existing) =>
    shouldCollapseTranscriptRevision({
      previous: existing,
      next: {
        speakerIdentity: input.line.speakerIdentity,
        speakerRole: "human",
        source: "livekit-room",
        updatedAt: input.line.updatedAt,
        normalizedContent,
      },
    }),
  );

  if (revisionLine !== undefined) {
    return input.merged.map((existing) =>
      existing === revisionLine ? mergeMatchingTranscriptLine({ existing, next: nextLine }) : existing,
    );
  }

  return [...input.merged, nextLine];
}

function collapseMergedTranscriptLines(merged: MergedTranscriptLine[]): MergedTranscriptLine[] {
  return merged
    .slice()
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .reduce<MergedTranscriptLine[]>((collapsed, line) => {
      const previous = collapsed.at(-1);
      if (previous !== undefined && shouldCollapseTranscriptRevision({ previous, next: line })) {
        return [...collapsed.slice(0, -1), mergeMatchingTranscriptLine({ existing: previous, next: line })];
      }

      return [...collapsed, { ...line }];
    }, []);
}

function dedupeMergedTranscriptLinesById(lines: MergedTranscriptLine[]): MergedTranscriptLine[] {
  const byId = lines.reduce((accumulated, line) => {
    const existing = accumulated.get(line.id);

    return new Map(accumulated).set(
      line.id,
      existing === undefined ? line : mergeMatchingTranscriptLine({ existing, next: line }),
    );
  }, new Map<string, MergedTranscriptLine>());

  return [...byId.values()];
}

export function mergeLiveTranscriptLines(input: {
  liveTranscriptSegments: TranscriptSegment[];
  realtimeTranscriptLines: LiveTranscriptLine[];
  presenceEntries: LiveTranscriptPresenceEntry[];
  localUserId?: string | null;
  assistantDisplayNamesByIdentity: Record<string, string>;
  limit?: number;
}): VisibleTranscriptLine[] {
  const segmentLines = input.liveTranscriptSegments.reduce<MergedTranscriptLine[]>((accumulated, segment) => {
    const line = buildSegmentTranscriptLine({
      segment,
      presenceEntries: input.presenceEntries,
      localUserId: input.localUserId,
      assistantDisplayNamesByIdentity: input.assistantDisplayNamesByIdentity,
    });

    return line === null ? accumulated : [...accumulated, line];
  }, []);

  const merged = input.realtimeTranscriptLines.reduce(
    (accumulated, line) =>
      mergeRealtimeTranscriptLine({
        merged: accumulated,
        line,
        presenceEntries: input.presenceEntries,
        localUserId: input.localUserId,
        assistantDisplayNamesByIdentity: input.assistantDisplayNamesByIdentity,
      }),
    segmentLines,
  );

  const limit = input.limit ?? DEFAULT_VISIBLE_TRANSCRIPT_LIMIT;
  // The same segment can arrive twice (live append + refetch, or scribe + db copy);
  // keep one line per display id so React keys stay unique.
  const collapsed = dedupeMergedTranscriptLinesById(collapseMergedTranscriptLines(merged));

  return collapsed.slice(-limit).map((line) => ({
    id: line.id,
    speakerIdentity: line.speakerIdentity,
    speakerName: line.speakerName,
    content: line.content,
    avatarUrl: line.avatarUrl,
    email: line.email,
  }));
}
