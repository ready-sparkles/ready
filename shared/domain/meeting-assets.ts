import { z } from "zod";

export const MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS = 9;

const MAX_MEETING_ASSET_TRANSCRIPT_EXCERPT_LENGTH = 2_000;
const MAX_MEETING_ASSET_SPEAKER_NAME_LENGTH = 120;
const MAX_MEETING_ASSET_DATA_URL_LENGTH = 4_000_000;
const MAX_MEETING_ASSET_IDENTIFIER_LENGTH = 255;
const MEETING_ASSET_TRANSCRIPT_SEGMENT_LIMIT_MESSAGE = `Meeting assets support at most ${MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS} unique transcript segments`;

export const meetingAssetKindSchema = z.enum(["screen_capture"]);
export const meetingAssetTriggerSchema = z.enum(["automatic_task_context", "automatic_bug_context", "manual"]);

const meetingAssetCapturedAtSchema = z.string().datetime({ offset: true });

export const meetingAssetSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  kind: meetingAssetKindSchema,
  mimeType: z.enum(["image/jpeg", "image/png"]),
  byteSize: z.number().int().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  capturedAt: meetingAssetCapturedAtSchema,
  participantIdentity: z.string().trim().min(1).nullable(),
  trackSid: z.string().trim().min(1).nullable(),
  trigger: meetingAssetTriggerSchema,
  transcriptSegmentIds: z.array(z.string().uuid()).default([]),
  transcriptExcerpt: z.string().trim().min(1).max(MAX_MEETING_ASSET_TRANSCRIPT_EXCERPT_LENGTH).nullable(),
  speakerName: z.string().trim().min(1).max(MAX_MEETING_ASSET_SPEAKER_NAME_LENGTH).nullable(),
  includeInLinear: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const meetingAssetsResponseSchema = z.object({
  assets: z.array(meetingAssetSchema),
});

export const updateMeetingAssetRequestSchema = z.object({
  includeInLinear: z.boolean(),
});

export const updateMeetingAssetResponseSchema = z.object({
  asset: meetingAssetSchema,
});

export const createInternalMeetingAssetRequestSchema = z
  .object({
    meetingId: z.string().uuid(),
    imageDataUrl: z.string().startsWith("data:image/").max(MAX_MEETING_ASSET_DATA_URL_LENGTH),
    capturedAt: meetingAssetCapturedAtSchema,
    participantIdentity: z.string().trim().min(1).max(MAX_MEETING_ASSET_IDENTIFIER_LENGTH).nullable().optional(),
    trackSid: z.string().trim().min(1).max(MAX_MEETING_ASSET_IDENTIFIER_LENGTH).nullable().optional(),
    trigger: meetingAssetTriggerSchema,
    transcriptSegmentId: z.string().uuid().nullable().optional(),
    transcriptSegmentIds: z.array(z.string().uuid()).max(MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS).optional(),
    transcriptExcerpt: z.string().trim().min(1).max(MAX_MEETING_ASSET_TRANSCRIPT_EXCERPT_LENGTH).nullable().optional(),
    speakerName: z.string().trim().min(1).max(MAX_MEETING_ASSET_SPEAKER_NAME_LENGTH).nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      new Set([
        ...(input.transcriptSegmentIds ?? []),
        ...(input.transcriptSegmentId !== undefined &&
        input.transcriptSegmentId !== null &&
        input.transcriptSegmentId !== ""
          ? [input.transcriptSegmentId]
          : []),
      ]).size <= MEETING_ASSET_MAX_TRANSCRIPT_SEGMENT_IDS,
    {
      message: MEETING_ASSET_TRANSCRIPT_SEGMENT_LIMIT_MESSAGE,
      path: ["transcriptSegmentIds"],
    },
  );

export type MeetingAsset = z.infer<typeof meetingAssetSchema>;
export type MeetingAssetKind = z.infer<typeof meetingAssetKindSchema>;
export type MeetingAssetTrigger = z.infer<typeof meetingAssetTriggerSchema>;
