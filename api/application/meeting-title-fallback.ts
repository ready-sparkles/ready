import type { RepositoryPort } from "@readymeet/db/ports/repository";

import {
  buildConservativeTranscriptTitle,
  buildOneOnOneParticipantTitle,
  dominantTranscriptScript,
  matchesTranscriptScript,
  normalizeTranscriptTitleContent,
} from "../domain/meeting-title";
import { repositories } from "../ports/repository-runtime";

const MIN_TITLE_FRAGMENT_LENGTH = 12;

export const FALLBACK_MEETING_SUMMARY =
  "Meeting notes could not be generated automatically. The transcript is available for review.";

export function buildShortMeetingTitleFromTranscript(
  transcriptData: Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>> | null,
): string | null {
  const humanSegments = (transcriptData?.segments ?? []).filter((segment) => segment.speakerRole === "human");
  // Speech recognition can mislabel a speaker's language for stretches of the
  // meeting, so a title fragment must match the transcript's dominant script.
  const dominantScript = dominantTranscriptScript(humanSegments.map((segment) => segment.content));
  const candidateSegment = humanSegments.find((segment) => {
    const normalized = normalizeTranscriptTitleContent(segment.content).toLowerCase();
    if (normalized.length < MIN_TITLE_FRAGMENT_LENGTH) {
      return false;
    }

    return dominantScript === null || matchesTranscriptScript({ text: segment.content, script: dominantScript });
  });

  const content = normalizeTranscriptTitleContent(candidateSegment?.content ?? "");
  if (content === "") {
    return null;
  }

  return buildConservativeTranscriptTitle(content);
}

async function buildFallbackMeetingTitleNamed(input: {
  meetingId: string;
  transcriptData: Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>> | null;
}): Promise<string | null> {
  const participants = await repositories().listParticipantsForMeeting(input.meetingId);

  return buildOneOnOneParticipantTitle(participants) ?? buildShortMeetingTitleFromTranscript(input.transcriptData);
}

export async function buildFallbackMeetingTitle(
  ...args: [meetingId: string, transcriptData: Awaited<ReturnType<RepositoryPort["getTranscriptForMeeting"]>> | null]
): Promise<string | null> {
  return buildFallbackMeetingTitleNamed({ meetingId: args[0], transcriptData: args[1] });
}
