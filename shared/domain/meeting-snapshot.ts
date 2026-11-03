import { z } from "zod";

import { meetingTypeSchema } from "./capability-catalog";
import { extractionConfidenceSchema } from "./meeting-extraction";
import { meetingTaskCandidateSchema } from "./meeting-tasks";

const MAX_SNAPSHOT_HIGHLIGHT_THEME_LENGTH = 40;
const MAX_SNAPSHOT_HIGHLIGHT_TAKEAWAY_LENGTH = 160;
const MAX_SNAPSHOT_TITLE_LENGTH = 120;
const MAX_SNAPSHOT_GIST_LENGTH = 240;
const MAX_SNAPSHOT_TOPIC_CHIP_LENGTH = 40;
const MAX_SNAPSHOT_TOPIC_CHIPS = 5;
const MAX_SNAPSHOT_HIGHLIGHTS = 4;

export const meetingSnapshotHighlightSchema = z.object({
  theme: z.string().trim().min(1).max(MAX_SNAPSHOT_HIGHLIGHT_THEME_LENGTH),
  takeaway: z.string().trim().min(1).max(MAX_SNAPSHOT_HIGHLIGHT_TAKEAWAY_LENGTH),
});

export const meetingSnapshotActionItemSchema = z.object({
  text: z.string().trim().min(1),
  assignee: z.string().trim().min(1).nullable(),
});

export const meetingSnapshotSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  title: z.string().trim().min(1).max(MAX_SNAPSHOT_TITLE_LENGTH),
  summary: z.string().trim().min(1),
  actionItems: z.array(meetingSnapshotActionItemSchema),
  taskCandidates: z.array(meetingTaskCandidateSchema).default([]),
  proposedTitle: z.string().trim().min(1).max(MAX_SNAPSHOT_TITLE_LENGTH).nullable(),
  meetingType: meetingTypeSchema.nullable(),
  meetingTypeConfidence: extractionConfidenceSchema.nullable(),
  gist: z.string().trim().min(1).max(MAX_SNAPSHOT_GIST_LENGTH),
  topicChips: z.array(z.string().trim().min(1).max(MAX_SNAPSHOT_TOPIC_CHIP_LENGTH)).max(MAX_SNAPSHOT_TOPIC_CHIPS),
  highlights: z.array(meetingSnapshotHighlightSchema).max(MAX_SNAPSHOT_HIGHLIGHTS),
  snapshotModel: z.string().trim().min(1),
  snapshotPromptVersion: z.string().trim().min(1),
  createdAt: z.string(),
});

export type MeetingSnapshotHighlight = z.infer<typeof meetingSnapshotHighlightSchema>;
export type MeetingSnapshotActionItem = z.infer<typeof meetingSnapshotActionItemSchema>;
export type MeetingSnapshot = z.infer<typeof meetingSnapshotSchema>;
