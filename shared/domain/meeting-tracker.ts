import { z } from "zod";

const MEETING_TRACKER_ITEM_TEXT_MAX_LENGTH = 600;
const MEETING_TRACKER_LABEL_MAX_LENGTH = 160;
const MEETING_TRACKER_EVIDENCE_QUOTE_MAX_LENGTH = 1000;
const MEETING_TRACKER_EVIDENCE_MAX_COUNT = 8;
const MEETING_TRACKER_ITEMS_MAX_COUNT = 200;

export const meetingTrackerItemSchema = z.object({
  id: z.string().uuid(),
  section: z.enum(["agreement", "open_item", "next_step"]),
  text: z.string().trim().min(1).max(MEETING_TRACKER_ITEM_TEXT_MAX_LENGTH),
  status: z.enum(["active", "resolved", "cancelled"]),
  owner: z.string().trim().min(1).max(MEETING_TRACKER_LABEL_MAX_LENGTH).nullable(),
  due: z.string().trim().min(1).max(MEETING_TRACKER_LABEL_MAX_LENGTH).nullable(),
  evidence: z
    .array(
      z.object({
        segmentId: z.string().uuid(),
        quote: z.string().trim().min(1).max(MEETING_TRACKER_EVIDENCE_QUOTE_MAX_LENGTH),
      }),
    )
    .min(1)
    .max(MEETING_TRACKER_EVIDENCE_MAX_COUNT),
});
export type MeetingTrackerItem = z.infer<typeof meetingTrackerItemSchema>;
export const meetingTrackerStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  items: z.array(meetingTrackerItemSchema).max(MEETING_TRACKER_ITEMS_MAX_COUNT),
  updatedAt: z.string().datetime().nullable(),
  status: z.enum(["idle", "updating", "failed", "unavailable"]),
});
export type MeetingTrackerState = z.infer<typeof meetingTrackerStateSchema>;
export const MEETING_TRACKER_EVENT = "meeting-tracker.updated";
export function meetingTrackerChannel(input: { workspaceId: string; meetingId: string }): string {
  return `workspace:${input.workspaceId}:meeting:${input.meetingId}:tracker`;
}
