import { MeetingTitleTranscriptRequired } from "@readymeet/shared";

import { shouldReplaceMeetingTitleWithSnapshot, titlesMatchIgnoringCase } from "../domain/meeting-title";
import { triggerMeetingTitle } from "../ports/gate-assistant-client";
import { repositories } from "../ports/repository-runtime";

import { buildFallbackMeetingTitle } from "./meeting-title-fallback";

type MeetingTitleResolutionResult = {
  title: string | null;
  preparationLines: string[];
  /** @external preparationLinesFallback */
  preparationLinesFallback: boolean;
  /** @external updated */
  updated: boolean;
  model: string | null;
};

async function triggerMeetingTitleOrSkip(input: {
  meetingId: string;
  jobId: string | null;
}): Promise<Awaited<ReturnType<typeof triggerMeetingTitle>> | null> {
  try {
    return await triggerMeetingTitle(input.meetingId, { jobId: input.jobId });
  } catch (error) {
    if (error instanceof MeetingTitleTranscriptRequired) {
      return null;
    }
    throw error;
  }
}

export async function resolveAndPersistMeetingTitle(input: {
  meetingId: string;
  options?: { jobId?: string | null };
}): Promise<MeetingTitleResolutionResult> {
  const { meetingId, options = {} } = input;
  const initialMeeting = await repositories().getMeetingById(meetingId);
  if (!initialMeeting) {
    return {
      title: null,
      preparationLines: [] as string[],
      preparationLinesFallback: true,
      updated: false,
      model: null,
    };
  }

  const generated = await triggerMeetingTitleOrSkip({ meetingId, jobId: options.jobId ?? null });
  if (generated === null) {
    // No human speech yet: nothing to title. Keep the current title; this is not a failure.
    return {
      title: initialMeeting.title,
      preparationLines: [] as string[],
      preparationLinesFallback: true,
      updated: false,
      model: null,
    };
  }
  if (!shouldReplaceMeetingTitleWithSnapshot(initialMeeting.title)) {
    return {
      title: initialMeeting.title,
      preparationLines: generated.preparationLines,
      preparationLinesFallback: generated.preparationLinesFallback,
      updated: false,
      model: generated.model,
    };
  }

  const [currentMeeting, transcriptData] = await Promise.all([
    repositories().getMeetingById(meetingId),
    repositories().getTranscriptForMeeting(meetingId),
  ]);
  if (!currentMeeting) {
    return {
      title: null,
      preparationLines: generated.preparationLines,
      preparationLinesFallback: generated.preparationLinesFallback,
      updated: false,
      model: generated.model,
    };
  }

  const fallbackTitle = await buildFallbackMeetingTitle(meetingId, transcriptData);
  const canReplaceCurrent =
    shouldReplaceMeetingTitleWithSnapshot(currentMeeting.title) ||
    titlesMatchIgnoringCase({ left: currentMeeting.title, right: fallbackTitle });
  if (!canReplaceCurrent) {
    return {
      title: currentMeeting.title,
      preparationLines: generated.preparationLines,
      preparationLinesFallback: generated.preparationLinesFallback,
      updated: false,
      model: generated.model,
    };
  }

  const updated = await repositories().updateMeetingTitleIfCurrent({
    meetingId,
    currentTitle: currentMeeting.title,
    title: generated.title,
    jobId: options.jobId,
  });

  return {
    title: updated?.title ?? currentMeeting.title,
    preparationLines: generated.preparationLines,
    preparationLinesFallback: generated.preparationLinesFallback,
    updated: Boolean(updated),
    model: generated.model,
  };
}
