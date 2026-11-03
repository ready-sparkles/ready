import type { RepositoryPort } from "@readymeet/db/ports/repository";

import { repositories } from "../ports/repository-runtime";

import { generateMeetingSnapshot } from "./meeting-extraction";

function shouldReplaceMeetingTitle(title: string) {
  return /^instant meeting$/i.test(title.trim());
}

export async function generatePostCallArtifacts(meetingId: string): Promise<{
  summary: Awaited<ReturnType<RepositoryPort["upsertSummaryForMeeting"]>>;
  actionItems: Awaited<ReturnType<RepositoryPort["replaceActionItemsForMeeting"]>>;
}> {
  const [generation, meeting] = await Promise.all([
    generateMeetingSnapshot({ meetingId }),
    repositories().getMeetingById(meetingId),
  ]);

  const summary = await repositories().upsertSummaryForMeeting({
    meetingId,
    content: generation.summary,
    model: generation.snapshotModel,
  });

  const actionItems = await repositories().replaceActionItemsForMeeting(meetingId, generation.actionItems);

  if (meeting && shouldReplaceMeetingTitle(meeting.title)) {
    await repositories().updateMeetingTitle({
      meetingId,
      title: generation.title,
    });
  }

  return {
    summary,
    actionItems,
  };
}
