import { type AiWorkflowJobView, meetingPreparationLinesSchema } from "@readymeet/shared";

import { buildConservativeTranscriptTitle, isReplaceableGeneratedMeetingTitle } from "./meeting-title";

type PreviewSegment = { speakerRole: string; content: string };

const MIN_GUEST_TITLE_SOURCE_SEGMENT_LENGTH = 40;

export function getGuestMeetingPreviewTitle({
  title,
  segments,
}: {
  title: string;
  segments: PreviewSegment[];
}): string {
  if (!isReplaceableGeneratedMeetingTitle(title)) {
    return title;
  }

  return (
    segments
      .filter(
        (segment) =>
          segment.speakerRole === "human" && segment.content.trim().length >= MIN_GUEST_TITLE_SOURCE_SEGMENT_LENGTH,
      )
      .map((segment) => buildConservativeTranscriptTitle(segment.content))
      .find(Boolean) ?? title
  );
}

/** Only completed model conclusions are public; failures keep the waiting copy. */
export function getGuestMeetingConclusions(job: Pick<AiWorkflowJobView, "status" | "result"> | null): string[] {
  if (job?.status !== "completed" || job.result.fallback === true) {
    return [];
  }
  const parsed = meetingPreparationLinesSchema.safeParse(job.result.preparationLines);

  return parsed.success ? parsed.data : [];
}
