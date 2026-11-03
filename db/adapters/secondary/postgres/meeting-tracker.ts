import {
  MEETING_TRACKER_EVENT,
  meetingTrackerChannel,
  type MeetingTrackerItem,
  type MeetingTrackerState,
  meetingTrackerStateSchema,
} from "@readymeet/shared";
import { z } from "zod";

import { publishRealtimeEvents } from "../../../ports/realtime";

import { db, Prisma } from "./client";

const MEETING_NOT_FOUND_FOR_TRACKER_UPDATE_MESSAGE = "Meeting not found for tracker update";

const processedSegmentIdsSchema = z.array(z.string());

type MeetingTrackerSegment = { id: string; speaker: string; content: string; startedAt: Date };
export type MeetingTrackerInput = {
  state: MeetingTrackerState;
  processedIds: string[];
  segments: MeetingTrackerSegment[];
};

type TrackerFinishInput = {
  meetingId: string;
  revision: number;
  items: MeetingTrackerItem[];
  processedIds: string[];
};

export async function readMeetingTracker(meetingId: string): Promise<MeetingTrackerState> {
  const row = await db.meetingTrackers.findUnique({ where: { meetingId } });

  return meetingTrackerStateSchema.parse({
    revision: row?.revision ?? 0,
    items: row?.items ?? [],
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    status: row?.status ?? "idle",
  });
}

export async function loadMeetingTrackerInput(meetingId: string): Promise<MeetingTrackerInput> {
  const [state, cursors, segments] = await Promise.all([
    readMeetingTracker(meetingId),
    db.meetingTrackers.findUnique({ where: { meetingId } }),
    db.transcriptSegments.findMany({
      where: {
        source: "livekit-python-live",
        speakerRole: "human",
        transcripts: { meetingId },
      },
      orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  return {
    state,
    processedIds: processedSegmentIdsSchema.parse(cursors?.processedSegmentIds ?? []),
    segments: segments.map((segment) => ({
      id: segment.id,
      speaker: segment.speakerName,
      content: segment.content,
      startedAt: segment.startedAt,
    })),
  };
}

async function insertMeetingTracker(meetingId: string): Promise<void> {
  try {
    await db.meetingTrackers.create({ data: { meetingId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return;
    }
    throw error;
  }
}

/** A stale request cannot overwrite the snapshot or advance its cursor. */
export async function finishMeetingTracker(input: TrackerFinishInput): Promise<boolean> {
  const meeting = await db.meetings.findUnique({ where: { id: input.meetingId } });
  if (!meeting) {
    throw new Error(MEETING_NOT_FOUND_FOR_TRACKER_UPDATE_MESSAGE);
  }
  await insertMeetingTracker(input.meetingId);
  const updated = await db.meetingTrackers.updateMany({
    where: { meetingId: input.meetingId, revision: input.revision },
    data: {
      revision: input.revision + 1,
      items: input.items,
      processedSegmentIds: input.processedIds,
      status: "idle",
      updatedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    return false;
  }
  await publishRealtimeEvents([
    {
      channel: meetingTrackerChannel({ meetingId: input.meetingId, workspaceId: meeting.workspaceId }),
      eventName: MEETING_TRACKER_EVENT,
      payload: { meetingId: input.meetingId, revision: input.revision + 1 },
    },
  ]);

  return true;
}

export async function failMeetingTracker(input: { meetingId: string; revision: number }): Promise<void> {
  await insertMeetingTracker(input.meetingId);
  await db.meetingTrackers.updateMany({
    where: { meetingId: input.meetingId, revision: input.revision },
    data: { status: "failed" },
  });
}
