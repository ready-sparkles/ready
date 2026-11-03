import { z } from "zod";

import { acquisitionSchema } from "./acquisition";
import {
  calendarAccountSchema,
  calendarProviderSchema,
  calendarReadyMeetingSchema,
  normalizedCalendarEventSchema,
  providerAccountKindSchema,
} from "./calendar";
import { userCapabilityViewSchema } from "./capability-catalog";
import {
  aiWorkflowJobViewSchema,
  capabilityRecommendationViewSchema,
  capabilitySelectionResultSchema,
} from "./capability-selection";
import {
  capabilityWorkflowMessageRequestSchema,
  capabilityWorkflowResponseSchema,
  capabilityWorkflowsResponseSchema,
} from "./capability-workflows";
import { linearTaskReviewRunSchema } from "./linear-task-review";
import { meetingExtractionSchema } from "./meeting-extraction";
import { meetingSnapshotSchema } from "./meeting-snapshot";
import {
  assignedTaskContextSchema,
  assignedTaskSummarySchema,
  meetingTaskListSchema,
  meetingTaskListStatusSchema,
  meetingTaskProgressSchema,
  meetingTaskSchema,
  unifiedAssignedTaskSchema,
  workspaceTaskSchema,
  workspaceTaskSectionSchema,
} from "./meeting-tasks";
import {
  actionItemSchema,
  agentConnectorSchema,
  agentMemorySchema,
  agentProfileSchema,
  agentSettingsSchema,
  agentToolPolicySchema,
  meetingJoinRequestSchema,
  meetingLinkSchema,
  meetingRuntimeStateSchema,
  meetingSchema,
  summarySchema,
  transcriptInfoSchema,
  transcriptSegmentSchema,
  userPlanSchema,
  userSchema,
  workspaceMemberSchema,
} from "./types";

const MAX_OAUTH_CREDENTIAL_FIELD_LENGTH = 8192;
const MAX_OAUTH_TOKEN_TYPE_LENGTH = 64;
const MAX_GOOGLE_ADDON_HANDOFF_TOKEN_LENGTH = 4096;
const MAX_HTTP_URL_LENGTH = 2048;
const MAX_SHORT_LABEL_LENGTH = 255;
const MAX_CALENDAR_REFERENCE_LENGTH = 1024;
const MAX_PARTICIPANT_DISPLAY_NAME_LENGTH = 120;
const MAX_GUEST_RECOGNITION_NOTICE_VERSION_LENGTH = 80;
const MAX_MEETING_JOIN_DISPLAY_NAME_LENGTH = 60;
const MIN_PREPARATION_LINE_LENGTH = 4;
const MAX_PREPARATION_LINE_LENGTH = 96;
const MAX_PREPARATION_LINE_COUNT = 12;
const MAX_MEETING_NOTES_PREVIEW_LENGTH = 600;
const MAX_TASK_TITLE_LENGTH = 160;
const MAX_TASK_DESCRIPTION_LENGTH = 1000;
const MAX_TASK_NAME_LENGTH = 120;
const MAX_DUE_DATE_VALUE_LENGTH = 120;
const MAX_BATCH_TASK_ID_COUNT = 100;
const MAX_WORKSPACE_SECTION_TITLE_LENGTH = 120;
const MAX_TASK_OBSERVED_KIND_COUNT = 4;
const MAX_CALENDAR_PREP_PROGRESS_PERCENT = 100;
const MAX_USER_PROFILE_DISPLAY_NAME_LENGTH = 120;

const DEBUG_TRANSCRIPT_OR_JSON_REQUIRED_MESSAGE = "Either transcript or transcriptJson is required";
const DEBUG_MEETING_ENDED_AFTER_STARTED_MESSAGE = "meeting.endedAt must be after meeting.startedAt";
const DEBUG_SEGMENT_SPEAKER_MISMATCH_MESSAGE = "speakerEmail must match a declared participant";
const DEBUG_SEGMENT_ENDED_AFTER_STARTED_MESSAGE = "segment endedAt must be after startedAt";
const WORKSPACE_REORDER_TARGET_REQUIRED_MESSAGE = "A reorder target is required.";

const guestMeetingTaskProgressSchema = z.object({
  mode: meetingTaskProgressSchema.shape.mode,
  processedChunks: meetingTaskProgressSchema.shape.processedChunks,
  totalChunks: meetingTaskProgressSchema.shape.totalChunks,
  candidateCount: meetingTaskProgressSchema.shape.candidateCount,
  persistedTaskCount: meetingTaskProgressSchema.shape.persistedTaskCount,
  isPreliminary: meetingTaskProgressSchema.shape.isPreliminary,
});

export const devLoginRequestSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().trim().min(1).nullable().optional(),
});

export const authResponseSchema = z.object({
  token: z.string(),
  user: userSchema,
});

export const googleAddonAuthResponseSchema = authResponseSchema.extend({
  accountCreated: z.boolean(),
  webHandoffId: z.string().uuid(),
  webHandoffToken: z.string().min(1),
});

export const googleAddonCalendarCredentialsSchema = z.object({
  accessToken: z.string().min(1).max(MAX_OAUTH_CREDENTIAL_FIELD_LENGTH),
  refreshToken: z.string().max(MAX_OAUTH_CREDENTIAL_FIELD_LENGTH),
  expiresAt: z.string().datetime(),
  scope: z.string().max(MAX_OAUTH_CREDENTIAL_FIELD_LENGTH),
  tokenType: z.string().max(MAX_OAUTH_TOKEN_TYPE_LENGTH),
});

export const oauthLoginRequestSchema = z.object({
  acquisition: acquisitionSchema.optional(),
  email: z.string().email(),
  displayName: z.string().min(1),
  avatarUrl: z.string().trim().min(1).nullable().optional(),
  provider: z.enum(["google", "microsoft-entra-id"]).optional(),
  providerAccountId: z.string().trim().min(1).nullable().optional(),
  googleAddonHandoffToken: z.string().min(1).max(MAX_GOOGLE_ADDON_HANDOFF_TOKEN_LENGTH).optional(),
  // Only accepted with the server exchange secret and a verified add-on binding.
  googleAddonCalendarCredentials: googleAddonCalendarCredentialsSchema.optional(),
});

// The Google Workspace add-on mints a fresh OIDC identity token per call and
// exchanges it here for an app JWT; no secrets are stored in Apps Script.
export const googleAddonLoginRequestSchema = z.object({
  idToken: z.string().min(1),
});

export const createMeetingRequestSchema = z.object({
  title: z.string().min(1),
  // Opt-in: block the response until call-in (dial-in number + PIN) is
  // provisioned, so one-shot callers like the Calendar add-on can embed it.
  // Web flows leave this off and let call-in sync in the background.
  waitForCallIn: z.boolean().optional(),
});

export const createGoogleAddonConferenceRequestSchema = z.object({
  // Short-lived Apps Script credential, encrypted at rest for this event only.
  calendarWebBaseUrl: z
    .string()
    .url()
    .max(MAX_HTTP_URL_LENGTH)
    .refine((value) => /^https?:\/\//i.test(value), "Expected an HTTP(S) URL")
    .optional(),
  calendarAccessToken: z.string().min(1).max(MAX_OAUTH_CREDENTIAL_FIELD_LENGTH).optional(),
  title: z.string().trim().min(1).max(MAX_SHORT_LABEL_LENGTH),
  calendarId: z.string().trim().min(1).max(MAX_CALENDAR_REFERENCE_LENGTH),
  eventId: z.string().trim().min(1).max(MAX_CALENDAR_REFERENCE_LENGTH),
});

export const createOutlookAddonConferenceRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_SHORT_LABEL_LENGTH),
    // Persisted on the Outlook item before attempting creation; never an auth identity.
    requestId: z.string().uuid(),
  })
  .strict();

export const updateAdminUserPlanRequestSchema = z.object({
  plan: userPlanSchema,
});

export const updateAdminUserPlanResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    plan: userPlanSchema,
  }),
});

export const privateBetaWaitlistEntrySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  requestedAt: z.string(),
  updatedAt: z.string(),
});

export const joinPrivateBetaWaitlistResponseSchema = z.object({
  waitlistEntry: privateBetaWaitlistEntrySchema,
});

export const getPrivateBetaWaitlistResponseSchema = z.object({
  waitlistEntry: privateBetaWaitlistEntrySchema.nullable(),
});

export const meetingAccessResponseSchema = z.object({
  meetingAccess: z.object({
    canCreateStandardMeeting: z.boolean(),
    canHostStandardMeetings: z.boolean(),
    /** Null means hosting is unlimited. */
    freeStandardMeetingLimit: z.number().int().positive().nullable(),
    hasCreatorPlan: z.boolean(),
    standardMeetingCount: z.number().int().nonnegative(),
  }),
});

export const debugTranscriptImportRequestSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    transcript: z.string().trim().min(1).optional(),
    transcriptJson: z.string().trim().min(1).optional(),
  })
  .refine(
    (value) => {
      const transcriptText = value.transcript?.trim() ?? "";
      const transcriptJsonText = value.transcriptJson?.trim() ?? "";

      return transcriptText.length > 0 || transcriptJsonText.length > 0;
    },
    {
      message: DEBUG_TRANSCRIPT_OR_JSON_REQUIRED_MESSAGE,
    },
  );

export const debugFinalizedMeetingImportRequestSchema = z.object({
  finalizedMeetingJson: z.string().trim().min(1),
});

export const debugFinalizedMeetingParticipantRoleSchema = z.enum(["host", "guest"]);

export const debugFinalizedMeetingJsonSchema = z
  .object({
    meeting: z.object({
      title: z.string().trim().min(1).max(MAX_SHORT_LABEL_LENGTH),
      startedAt: z.string().datetime(),
      endedAt: z.string().datetime(),
    }),
    participants: z
      .array(
        z.object({
          email: z.string().trim().email(),
          displayName: z.string().trim().min(1).max(MAX_PARTICIPANT_DISPLAY_NAME_LENGTH),
          role: debugFinalizedMeetingParticipantRoleSchema,
          avatarUrl: z.string().trim().min(1).url().nullable().optional(),
        }),
      )
      .min(1),
    transcript: z.object({
      segments: z
        .array(
          z.object({
            speakerEmail: z.string().trim().email(),
            sourceSegmentId: z.string().trim().min(1).optional(),
            content: z.string().trim().min(1),
            startedAt: z.string().datetime(),
            endedAt: z.string().datetime(),
          }),
        )
        .min(1),
    }),
  })
  .superRefine((value, context) => {
    const meetingStartedAt = Date.parse(value.meeting.startedAt);
    const meetingEndedAt = Date.parse(value.meeting.endedAt);
    if (Number.isFinite(meetingStartedAt) && Number.isFinite(meetingEndedAt) && meetingEndedAt < meetingStartedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meeting", "endedAt"],
        message: DEBUG_MEETING_ENDED_AFTER_STARTED_MESSAGE,
      });
    }

    const participantEmails = new Set(value.participants.map((participant) => participant.email.toLowerCase()));
    value.transcript.segments.forEach((segment, index) => {
      if (!participantEmails.has(segment.speakerEmail.toLowerCase())) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transcript", "segments", index, "speakerEmail"],
          message: DEBUG_SEGMENT_SPEAKER_MISMATCH_MESSAGE,
        });
      }

      const startedAt = Date.parse(segment.startedAt);
      const endedAt = Date.parse(segment.endedAt);
      if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt < startedAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transcript", "segments", index, "endedAt"],
          message: DEBUG_SEGMENT_ENDED_AFTER_STARTED_MESSAGE,
        });
      }
    });
  });

export const meetingListResponseSchema = z.object({
  meetings: meetingSchema.array(),
});

export const meetingLookupResponseSchema = z.object({
  meeting: meetingSchema,
});

export const createMeetingResponseSchema = z.object({
  meeting: meetingSchema,
  meetingLink: meetingLinkSchema,
});

export const createCalendarAddonConferenceResponseSchema = createMeetingResponseSchema.extend({
  reused: z.boolean(),
});

export const meetingLinkResolveResponseSchema = z.object({
  meeting: meetingSchema,
  meetingLink: meetingLinkSchema,
});

export const meetingLinkPrejoinResponseSchema = z.object({
  hasActiveParticipants: z.boolean().default(false),
  meeting: meetingSchema.nullable(),
  meetingLink: meetingLinkSchema,
  trusted: z.boolean(),
  // Compatibility field for a future hosting gate. It is currently false for
  // every signed-in creator because free accounts can create and host.
  hostPlanRequired: z.boolean().default(false),
});

export const createMeetingJoinRequestSchema = z
  .object({
    recognition: z
      .object({
        enabled: z.boolean(),
        noticeVersion: z.string().max(MAX_GUEST_RECOGNITION_NOTICE_VERSION_LENGTH),
        explicitOptIn: z.boolean().default(false),
      })
      .optional(),
    displayName: z.string().trim().min(1).max(MAX_MEETING_JOIN_DISPLAY_NAME_LENGTH).optional(),
  })
  .default({});

export const meetingJoinRequestResponseSchema = z.object({
  hasActiveParticipants: z.boolean().default(false),
  request: meetingJoinRequestSchema,
  meeting: meetingSchema.nullable(),
  meetingLink: meetingLinkSchema,
  guestSession: z
    .object({
      token: z.string(),
      expiresAt: z.string(),
      user: userSchema,
    })
    .nullable()
    .optional(),
});

export const meetingJoinRequestListResponseSchema = z.object({
  requests: z.array(meetingJoinRequestSchema),
});

export const meetingJoinRequestDecisionResponseSchema = z.object({
  request: meetingJoinRequestSchema,
});

export const meetingJoinRequestStatusResponseSchema = z.object({
  hasActiveParticipants: z.boolean().default(false),
  request: meetingJoinRequestSchema,
  meeting: meetingSchema.nullable(),
});

export const postMeetingDispositionSchema = z.object({
  status: z.literal("skipped"),
  reason: z.enum(["too_short_duration", "too_short_transcript"]),
  redirectTo: z.literal("/workspace?view=upcoming"),
  message: z.string().min(1),
});

export const meetingLiveResponseSchema = z.object({
  meeting: meetingSchema,
  meetingRuntime: meetingRuntimeStateSchema,
  /** Set when the ended meeting is hidden from history as too short, so it has no notes page. */
  postMeetingDisposition: postMeetingDispositionSchema.nullable().optional(),
});

export const debugTranscriptImportResponseSchema = z.object({
  meeting: meetingSchema,
});

export const debugFinalizedMeetingImportResponseSchema = z.object({
  meeting: meetingSchema,
});

export const debugOnboardingResetResponseSchema = z.object({
  ok: z.literal(true),
  hiddenEndedMeetingCount: z.number().int().nonnegative(),
});

export const voiceWebResearchRunViewSchema = z
  .object({
    researchRunId: z.string().uuid(),
    status: z.string().min(1),
    query: z.string(),
    researchMode: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    backend: z.string().nullable().optional(),
    searchId: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    findallId: z.string().nullable().optional(),
    taskgroupId: z.string().nullable().optional(),
    answer: z.unknown().nullable().optional(),
    results: z.array(z.unknown()).default([]),
    progress: z.unknown().nullable().optional(),
    message: z.string().nullable().optional(),
    runRefs: z.record(z.string(), z.unknown()).default({}),
    googleSearchQueries: z.array(z.string()).optional().default([]),
    googleSearchSuggestionsHtml: z.string().nullable().optional(),
    deepResearchAvailable: z.boolean().optional(),
    deepResearchAutoStarted: z.boolean().optional(),
    deepResearchRunId: z.string().uuid().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    completedAt: z.string().nullable().optional(),
    cancelledAt: z.string().nullable().optional(),
    expiresAt: z.string().nullable().optional(),
  })
  .passthrough();

export type VoiceWebResearchRunView = z.infer<typeof voiceWebResearchRunViewSchema>;

export const voiceWebResearchRunResponseSchema = z.object({
  run: voiceWebResearchRunViewSchema,
});

export const voiceWebResearchRunsResponseSchema = z.object({
  runs: voiceWebResearchRunViewSchema.array(),
});

export const meetingResearchRunStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

export const meetingResearchPaperSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  markdown: z.string().trim().min(1),
  filename: z.string().trim().min(1),
  generatedAt: z.string().datetime(),
});

export const meetingResearchRunResultSchema = z
  .object({
    researchPaper: meetingResearchPaperSchema.optional(),
  })
  .passthrough();

export const meetingResearchRunViewSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  recommendationId: z.string().uuid(),
  userId: z.string().uuid(),
  agentProfileId: z.string().uuid(),
  query: z.string().trim().min(1),
  taskKind: z.string().trim().min(1),
  status: meetingResearchRunStatusSchema,
  progressLabel: z.string().trim().min(1).nullable(),
  progressDetail: z.string().trim().min(1).nullable(),
  progressUpdatedAt: z.string().nullable(),
  runRefs: z.record(z.string(), z.unknown()).default({}),
  result: meetingResearchRunResultSchema.default({}),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
});

export const startMeetingResearchRunRequestSchema = z.object({
  recommendationId: z.string().uuid(),
});

export const meetingResearchRunResponseSchema = z.object({
  run: meetingResearchRunViewSchema,
});

export const meetingResearchRunsResponseSchema = z.object({
  runs: meetingResearchRunViewSchema.array(),
});

export type MeetingResearchRunStatus = z.infer<typeof meetingResearchRunStatusSchema>;
export type MeetingResearchPaper = z.infer<typeof meetingResearchPaperSchema>;
export type MeetingResearchRunView = z.infer<typeof meetingResearchRunViewSchema>;

/**
 * Whether the viewer may see AI-generated notes/tasks for a meeting. Notes
 * are always generated; visibility is gated per viewer: guests must sign up
 * (signup_required), free users past their allowance upgrade
 * (upgrade_required), and paid/admin-plan users who spent their available
 * credits buy more (credits_required).
 */
export const meetingNotesAccessSchema = z.object({
  /** @external existing wire contract */
  locked: z.boolean(),
  reason: z.enum(["upgrade_required", "credits_required", "signup_required"]).nullable(),
});

export const MEETING_PREPARATION_FALLBACK_LINES = [
  "Reading the conversation as a whole.",
  "Separating key themes from supporting detail.",
  "Tracing the strongest points of tension.",
  "Distinguishing decisions from open questions.",
  "Connecting conclusions to their supporting context.",
  "Pulling out commitments and their owners.",
  "Checking dependencies and unresolved blockers.",
  "Checking the sequence of next steps.",
  "Resolving the remaining ambiguities.",
  "Condensing the supporting details.",
  "Shaping the discussion into clear notes.",
  "Preparing the final meeting record.",
] as const;

export const meetingPreparationLinesSchema = z
  .array(z.string().trim().min(MIN_PREPARATION_LINE_LENGTH).max(MAX_PREPARATION_LINE_LENGTH))
  .min(1)
  .max(MAX_PREPARATION_LINE_COUNT);

export const meetingPreparationPreviewResponseSchema = z.object({
  status: z.enum(["pending", "ready"]),
  lines: meetingPreparationLinesSchema.or(z.tuple([])),
  source: z.enum(["model", "fallback"]).nullable(),
});

export type MeetingPreparationPreview = z.infer<typeof meetingPreparationPreviewResponseSchema>;

export const meetingDetailResponseSchema = z.object({
  meeting: meetingSchema,
  meetingRuntime: meetingRuntimeStateSchema,
  transcript: transcriptInfoSchema.nullable(),
  transcriptSegments: transcriptSegmentSchema.array(),
  summary: summarySchema.nullable(),
  notesPreview: z
    .object({
      status: z.enum(["pending", "ready"]),
      content: z.string().max(MAX_MEETING_NOTES_PREVIEW_LENGTH),
    })
    .nullable()
    .optional(),
  actionItems: actionItemSchema.array(),
  tasks: meetingTaskListSchema.nullable().default(null),
  linearTaskReview: linearTaskReviewRunSchema.nullable().default(null),
  capabilityRecommendations: capabilityRecommendationViewSchema.array().default([]),
  webResearchRuns: voiceWebResearchRunViewSchema.array().default([]),
  researchRuns: meetingResearchRunViewSchema.array().default([]),
  postMeetingDisposition: postMeetingDispositionSchema.nullable().default(null),
  notesAccess: meetingNotesAccessSchema.default({ locked: false, reason: null }),
});

// A notes view never implies that transcript or secondary documents have loaded.
export const meetingNotesViewResponseSchema = z.object({
  meeting: meetingDetailResponseSchema.shape.meeting,
  meetingRuntime: meetingDetailResponseSchema.shape.meetingRuntime,
  transcript: meetingDetailResponseSchema.shape.transcript,
  summary: meetingDetailResponseSchema.shape.summary,
  notesPreview: meetingDetailResponseSchema.shape.notesPreview,
  actionItems: meetingDetailResponseSchema.shape.actionItems,
  tasks: meetingDetailResponseSchema.shape.tasks,
  postMeetingDisposition: meetingDetailResponseSchema.shape.postMeetingDisposition,
  notesAccess: meetingDetailResponseSchema.shape.notesAccess,
  hasTranscriptSegments: z.boolean(),
});

export const guestMeetingTasksStatusSchema = z.object({
  status: meetingTaskListStatusSchema,
  phase: z.string().trim().min(1),
  error: z.string().nullable(),
  isTerminal: z.boolean(),
  isCurrent: z.boolean(),
  tasks: meetingTaskListSchema
    .extend({
      error: z.null(),
      model: z.null(),
      promptVersion: z.null(),
      transcriptHash: z.null(),
    })
    .nullable(),
  progress: guestMeetingTaskProgressSchema.nullable().default(null),
});

export const guestMeetingNotesResponseSchema = z.object({
  meeting: meetingSchema,
  meetingRuntime: meetingRuntimeStateSchema,
  transcript: transcriptInfoSchema.nullable(),
  summary: summarySchema.nullable(),
  inProgressConclusions: meetingPreparationLinesSchema.or(z.tuple([])).default([]),
  preparationPreview: meetingPreparationPreviewResponseSchema.nullable().default(null),
  tasksStatus: guestMeetingTasksStatusSchema.nullable().default(null),
  postMeetingDisposition: postMeetingDispositionSchema.nullable().default(null),
  notesAccess: meetingNotesAccessSchema.default({ locked: false, reason: null }),
});

export const linkGuestSessionRequestSchema = z.object({
  guestToken: z.string().min(1),
});

export const linkGuestSessionResponseSchema = z.object({
  ok: z.literal(true),
  linkedUserId: z.string().uuid(),
  transferredMeetingIds: z.array(z.string().uuid()),
  request: meetingJoinRequestSchema.nullable().optional(),
});

export const livekitTokenRequestSchema = z.object({
  meetingId: z.string().uuid(),
  participantName: z.string().min(1),
});

export const livekitTokenResponseSchema = z.object({
  token: z.string(),
  wsUrl: z.string(),
  roomName: z.string(),
});

export const createInstantMeetingRequestSchema = z.object({
  title: z.string().min(1).optional(),
  existingMeetingId: z.string().uuid().nullable().optional(),
  intent: z.enum(["standard", "agent_intro"]).default("standard"),
});

export const createInstantMeetingResponseSchema = z.object({
  meeting: meetingSchema,
  meetingLink: meetingLinkSchema,
  reused: z.boolean(),
  livekit: livekitTokenResponseSchema,
  user: userSchema.optional(),
});

export const appendTranscriptSegmentRequestSchema = z.object({
  speakerName: z.string().min(1),
  content: z.string().min(1),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
});

export const endMeetingRequestSchema = z.object({
  action: z.enum(["leave", "end_for_all"]).default("leave"),
});

export const runMeetingSummaryResponseSchema = z.object({
  summary: summarySchema,
  actionItems: actionItemSchema.array(),
});

export const meetingExtractionResponseSchema = z.object({
  extraction: meetingExtractionSchema,
});

export const meetingExtractionLookupResponseSchema = z.object({
  extraction: meetingExtractionSchema.nullable(),
});

export const meetingSnapshotRunResponseSchema = z.object({
  job: aiWorkflowJobViewSchema,
  snapshot: meetingSnapshotSchema.nullable().optional(),
});

export const meetingNotesRegenerationStatusSchema = z.enum(["started", "in_progress", "not_needed", "recently_failed"]);
export const regenerateMeetingNotesResponseSchema = z.object({
  status: meetingNotesRegenerationStatusSchema,
});
export type RegenerateMeetingNotesResponse = z.infer<typeof regenerateMeetingNotesResponseSchema>;
/** Where a started fallback-notes run stands: still running, ended without real notes, or nothing left to wait for. */
export const meetingNotesRegenerationProgressSchema = z.enum(["in_progress", "failed", "done"]);
export const meetingNotesRegenerationProgressResponseSchema = z.object({
  status: meetingNotesRegenerationProgressSchema,
});
export type MeetingNotesRegenerationProgress = z.infer<typeof meetingNotesRegenerationProgressSchema>;

export const meetingTasksStatusResponseSchema = z.object({
  status: meetingTaskListStatusSchema,
  phase: z.string().trim().min(1),
  error: z.string().nullable(),
  isTerminal: z.boolean(),
  isCurrent: z.boolean(),
  job: aiWorkflowJobViewSchema.nullable(),
  tasks: meetingTaskListSchema.nullable(),
  progress: meetingTaskProgressSchema.nullable().default(null),
  serverNow: z.string().datetime(),
});

export const updateMeetingTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH).optional(),
  description: z.string().trim().min(1).max(MAX_TASK_DESCRIPTION_LENGTH).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  assigneeName: z.string().trim().min(1).max(MAX_TASK_NAME_LENGTH).nullable().optional(),
  assigneeEmail: z.string().email().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  ownerName: z.string().trim().min(1).max(MAX_TASK_NAME_LENGTH).nullable().optional(),
  ownerEmail: z.string().email().nullable().optional(),
  dueDateValue: z.string().trim().min(1).max(MAX_DUE_DATE_VALUE_LENGTH).nullable().optional(),
  status: z.enum(["open", "completed", "dismissed"]).optional(),
});

export const updateMeetingTaskResponseSchema = z.object({
  task: meetingTaskSchema,
});

export const reportMeetingTaskRenderedRequestSchema = z.object({
  renderedAt: z.string().datetime(),
  realtimeReceivedAt: z.string().datetime().nullable().optional(),
  refetchStartedAt: z.string().datetime().nullable().optional(),
  refetchCompletedAt: z.string().datetime().nullable().optional(),
  taskRevision: z.number().int().positive().optional(),
  observedKinds: z
    .array(z.enum(["appearance", "owner", "due_date", "completion"]))
    .min(1)
    .max(MAX_TASK_OBSERVED_KIND_COUNT)
    .optional(),
  clientContinuity: z.enum(["continuous", "recovered"]).optional(),
});

export const reportMeetingTaskRenderedResponseSchema = z.object({ accepted: z.boolean() });

export const createWorkspaceTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH).optional(),
  description: z.string().trim().min(1).max(MAX_TASK_DESCRIPTION_LENGTH).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  dueDateValue: z.string().trim().min(1).max(MAX_DUE_DATE_VALUE_LENGTH).nullable().optional(),
  sectionId: z.string().uuid().optional(),
  beforeTaskId: z.string().uuid().optional(),
  afterTaskId: z.string().uuid().optional(),
});

export const updateWorkspaceTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH).optional(),
  description: z.string().trim().min(1).max(MAX_TASK_DESCRIPTION_LENGTH).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  dueDateValue: z.string().trim().min(1).max(MAX_DUE_DATE_VALUE_LENGTH).nullable().optional(),
  status: z.enum(["open", "completed", "dismissed"]).optional(),
  sectionId: z.string().uuid().optional(),
});

export const deleteWorkspaceTasksRequestSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH_TASK_ID_COUNT),
});

export const upsertWorkspaceTaskSectionRequestSchema = z.object({
  title: z.string().trim().min(1).max(MAX_WORKSPACE_SECTION_TITLE_LENGTH),
  position: z.number().int().nonnegative().optional(),
});

export const reorderWorkspaceTasksRequestSchema = z
  .object({
    movedTaskIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH_TASK_ID_COUNT),
    targetSectionId: z.string().uuid(),
    beforeTaskId: z.string().uuid().optional(),
    afterTaskId: z.string().uuid().optional(),
  })
  .refine(
    (value) => value.beforeTaskId !== undefined || value.afterTaskId !== undefined || value.movedTaskIds.length !== 0,
    {
      message: WORKSPACE_REORDER_TARGET_REQUIRED_MESSAGE,
    },
  );

export const workspaceAssignedTasksResponseSchema = z.object({
  sections: z.array(workspaceTaskSectionSchema),
  tasks: z.array(unifiedAssignedTaskSchema),
});

export const assignedTaskMeetingMetadataSchema = z.object({
  id: meetingSchema.shape.id,
  workspaceId: meetingSchema.shape.workspaceId,
  createdByUserId: meetingSchema.shape.createdByUserId,
  kind: meetingSchema.shape.kind,
  isConfidential: meetingSchema.shape.isConfidential,
  viewerRole: meetingSchema.shape.viewerRole,
  participants: meetingSchema.shape.participants,
});
export type AssignedTaskMeetingMetadata = z.infer<typeof assignedTaskMeetingMetadataSchema>;

export const personalAssignedTasksResponseSchema = z.object({
  tasks: z.array(unifiedAssignedTaskSchema),
  sourceMeetings: z.array(assignedTaskMeetingMetadataSchema).optional().default([]),
});

export const workspaceTaskResponseSchema = z.object({
  task: workspaceTaskSchema,
});

export const workspaceTaskSectionResponseSchema = z.object({
  section: workspaceTaskSectionSchema,
});

export const deleteWorkspaceTaskSectionResponseSchema = z.object({
  sectionId: z.string().uuid(),
  taskIds: z.array(z.string().uuid()),
});

export const reorderWorkspaceTasksResponseSchema = z.object({
  tasks: z.array(unifiedAssignedTaskSchema),
});

export const workspaceMembersResponseSchema = z.object({
  members: z.array(workspaceMemberSchema),
});

export const userWorkspaceIdsResponseSchema = z.object({
  workspaceIds: z.array(z.string().uuid()),
});

export const assignedTasksResponseSchema = z.object({
  tasks: z.array(assignedTaskSummarySchema),
});

export const assignedTaskContextResponseSchema = z.object({
  context: assignedTaskContextSchema,
});

export const runCapabilitySelectionRequestSchema = z.object({
  meetingId: z.string().uuid(),
  extractionId: z.string().uuid().optional(),
  forceRefresh: z.boolean().optional(),
});

export const capabilitySelectionResponseSchema = capabilitySelectionResultSchema;

export const capabilityListResponseSchema = z.object({
  capabilities: userCapabilityViewSchema.array(),
});

export const updateCapabilityPreferenceRequestSchema = z.object({
  isEnabled: z.boolean(),
});

export const updateCapabilityPreferenceResponseSchema = z.object({
  capability: userCapabilityViewSchema,
});

export const startCapabilityWorkflowResponseSchema = capabilityWorkflowResponseSchema;
export const startCapabilityWorkflowRequestSchema = z.object({
  forceRefresh: z.boolean().optional(),
});
export const listCapabilityWorkflowsResponseSchema = capabilityWorkflowsResponseSchema;
export const sendCapabilityWorkflowMessageRequestSchema = capabilityWorkflowMessageRequestSchema;
export const sendCapabilityWorkflowMessageResponseSchema = capabilityWorkflowResponseSchema;
export const updateCapabilityWorkflowDraftResponseSchema = capabilityWorkflowResponseSchema;
export const syncCapabilityWorkflowResponseSchema = capabilityWorkflowResponseSchema;

export const linearConnectResponseSchema = z.object({
  authorizationUrl: z.string().url(),
});

export const linearConnectRequestSchema = z.object({
  returnTo: z.string().trim().min(1).optional(),
});

export const linearDisconnectResponseSchema = z.object({
  ok: z.boolean(),
});

export const meetingAgentToolInvocationActionResponseSchema = z.object({
  ok: z.boolean(),
  invocationId: z.string().uuid(),
  status: z.enum(["completed", "cancelled"]),
  resultSummary: z.record(z.string(), z.unknown()).nullable(),
});

export const calendarConnectResponseSchema = z.object({
  authorizationUrl: z.string().url(),
});

export const calendarConnectRequestSchema = z.object({
  provider: calendarProviderSchema,
  accountKind: providerAccountKindSchema.optional(),
  returnTo: z.string().trim().min(1).optional(),
  meetingId: z.string().uuid().optional(),
});

export const calendarDisconnectRequestSchema = z.object({
  provider: calendarProviderSchema,
});

export const calendarDisconnectResponseSchema = z.object({
  ok: z.boolean(),
});

export const calendarAccountsResponseSchema = z.object({
  accounts: z.array(calendarAccountSchema),
});

export const updateCalendarAccountRequestSchema = z.object({
  accountKind: providerAccountKindSchema,
});

export const updateCalendarAccountResponseSchema = z.object({
  account: calendarAccountSchema,
});

export const deleteProviderDataRequestSchema = z.object({
  confirmationEmail: z.string().email(),
});

export const providerDataDeletionResponseSchema = z.object({
  ok: z.literal(true),
  deletionId: z.string().uuid().optional(),
});

export const calendarEventsQuerySchema = z.object({
  timeMin: z.string().datetime().optional(),
  timeMax: z.string().datetime().optional(),
  provider: calendarProviderSchema.optional(),
  includeCancelled: z.coerce.boolean().optional(),
});

export const calendarPrepAccessSchema = z.object({
  canStartCalendarPrep: z.boolean(),
  freeCalendarPrepLimit: z.number().int().positive(),
  hasPrepPlan: z.boolean(),
  calendarPrepCount: z.number().int().nonnegative(),
});

export const calendarEventsResponseSchema = z.object({
  events: z.array(normalizedCalendarEventSchema),
  connectedProviders: z.array(calendarProviderSchema),
  needsConnection: z.boolean(),
  photoPermissionMissingProviders: z.array(calendarProviderSchema).optional(),
  prepAccess: calendarPrepAccessSchema.optional(),
  prepSummaries: z
    .array(
      z.object({
        calendarEventId: z.string().trim().min(1),
        eventFingerprint: z.string().trim().min(1),
        prepId: z.string().uuid(),
        status: z.enum(["pending", "running", "completed", "failed"]),
        companyVisible: z.boolean(),
        progress: z
          .object({
            totalRuns: z.number().int().min(0),
            queuedRuns: z.number().int().min(0),
            runningRuns: z.number().int().min(0),
            completedRuns: z.number().int().min(0),
            failedRuns: z.number().int().min(0),
            peopleStatus: z.enum(["pending", "running", "completed", "failed"]),
            companyStatus: z.enum(["pending", "running", "completed", "failed"]),
            peopleProgressPercent: z.number().min(0).max(MAX_CALENDAR_PREP_PROGRESS_PERCENT).nullable(),
            companyProgressPercent: z.number().min(0).max(MAX_CALENDAR_PREP_PROGRESS_PERCENT).nullable(),
            peopleMessage: z.string().trim().min(1).nullable(),
            companyMessage: z.string().trim().min(1).nullable(),
            peopleMessages: z.array(z.string().trim().min(1)).default([]),
            companyMessages: z.array(z.string().trim().min(1)).default([]),
            startedAt: z.string().datetime().optional(),
            updatedAt: z.string().datetime(),
          })
          .nullable()
          .optional(),
      }),
    )
    .default([]),
});

export const deleteCalendarEventParamsSchema = z.object({
  accountId: z.string().uuid(),
  providerEventId: z.string().trim().min(1),
});

export const deleteCalendarEventQuerySchema = z.object({
  calendarId: z.string().trim().min(1),
});

export const deleteCalendarEventResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string().trim().min(1),
});

export const addReadyMeetingToCalendarEventParamsSchema = z.object({
  accountId: z.string().uuid(),
  providerEventId: z.string().trim().min(1),
});

export const addReadyMeetingToCalendarEventRequestSchema = z.object({
  calendarId: z.string().trim().min(1),
  providerRecurringEventId: z.string().trim().min(1).nullable().optional(),
});

export const addReadyMeetingToCalendarEventResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string().trim().min(1),
  providerEventId: z.string().trim().min(1),
  providerEventKey: z.string().trim().min(1),
  patchedProviderEventId: z.string().trim().min(1),
  readyMeeting: calendarReadyMeetingSchema,
  alreadyAdded: z.boolean(),
});

export const calendarEventPrepStatusSchema = z.enum(["pending", "running", "completed", "failed"]);

export const calendarEventPrepSourceSchema = z.object({
  title: z.string().trim().min(1),
  url: z.string().url(),
});

export const calendarEventPrepProgressSchema = z.object({
  totalRuns: z.number().int().min(0),
  queuedRuns: z.number().int().min(0),
  runningRuns: z.number().int().min(0),
  completedRuns: z.number().int().min(0),
  failedRuns: z.number().int().min(0),
  peopleStatus: calendarEventPrepStatusSchema,
  companyStatus: calendarEventPrepStatusSchema,
  peopleProgressPercent: z.number().min(0).max(MAX_CALENDAR_PREP_PROGRESS_PERCENT).nullable(),
  companyProgressPercent: z.number().min(0).max(MAX_CALENDAR_PREP_PROGRESS_PERCENT).nullable(),
  peopleMessage: z.string().trim().min(1).nullable(),
  companyMessage: z.string().trim().min(1).nullable(),
  peopleMessages: z.array(z.string().trim().min(1)).default([]),
  companyMessages: z.array(z.string().trim().min(1)).default([]),
  startedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime(),
});

export const calendarEventPrepPeopleSchema = z.object({
  status: calendarEventPrepStatusSchema,
  bullets: z.array(z.string().trim().min(1)),
  sources: z.array(calendarEventPrepSourceSchema),
});

export const calendarEventPrepCompanySchema = z.object({
  status: calendarEventPrepStatusSchema,
  companyName: z.string().trim().min(1).nullable(),
  website: z.string().url().nullable(),
  bullets: z.array(z.string().trim().min(1)),
  sources: z.array(calendarEventPrepSourceSchema),
});

export const calendarEventPrepBriefSchema = z.object({
  status: calendarEventPrepStatusSchema,
  bullets: z.array(z.string().trim().min(1)),
});

export const calendarEventPrepErrorSchema = z.object({
  code: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1),
});

export const calendarEventPrepProcessorSchema = z.enum(["core", "pro", "ultra"]);

export const calendarEventPrepRequestSchema = z.object({
  event: normalizedCalendarEventSchema,
  processor: calendarEventPrepProcessorSchema.optional(),
});

export const calendarEventPrepEstimateRequestSchema = z.object({
  event: normalizedCalendarEventSchema,
});

export const calendarEventPrepEstimateOptionSchema = z.object({
  processor: calendarEventPrepProcessorSchema,
  label: z.string().trim().min(1),
  pricePerThousandRequestsUsd: z.number().positive(),
  latency: z.string().trim().min(1),
  maxFields: z.string().trim().min(1),
  taskRunCount: z.number().int().nonnegative(),
  advancedSearchRequestCount: z.number().int().nonnegative(),
  rawCostMicroUsd: z.number().int().nonnegative(),
  pricePerCreditMicroUsd: z.number().int().positive(),
  markupMultiplier: z.number().nonnegative(),
  creditsCharged: z.number().int().nonnegative(),
  revenueMicroUsd: z.number().int().nonnegative(),
});

export const calendarEventPrepEstimateResponseSchema = z.object({
  plan: z.object({
    totalRuns: z.number().int().nonnegative(),
    peopleRunCount: z.number().int().nonnegative(),
    companyRunCount: z.number().int().nonnegative(),
    externalParticipantCount: z.number().int().nonnegative(),
    peopleTargetCount: z.number().int().nonnegative(),
    companyVisible: z.boolean(),
    advancedSearchRequestCount: z.number().int().nonnegative(),
  }),
  options: z.array(calendarEventPrepEstimateOptionSchema),
});

export const calendarEventPrepResponseSchema = z.object({
  prepId: z.string().uuid(),
  status: calendarEventPrepStatusSchema,
  brief: calendarEventPrepBriefSchema.optional().default({ status: "completed", bullets: [] }),
  people: calendarEventPrepPeopleSchema,
  company: calendarEventPrepCompanySchema.nullable(),
  sources: z.array(calendarEventPrepSourceSchema),
  error: calendarEventPrepErrorSchema.nullable().optional(),
  progress: calendarEventPrepProgressSchema.nullable().optional(),
});

export type CalendarEventPrepStatus = z.infer<typeof calendarEventPrepStatusSchema>;
export type CalendarEventPrepProcessor = z.infer<typeof calendarEventPrepProcessorSchema>;
export type CalendarEventPrepProgress = z.infer<typeof calendarEventPrepProgressSchema>;
export type CalendarEventPrepSource = z.infer<typeof calendarEventPrepSourceSchema>;
export type CalendarEventPrepEstimateResponse = z.infer<typeof calendarEventPrepEstimateResponseSchema>;
export type CalendarEventPrepResponse = z.infer<typeof calendarEventPrepResponseSchema>;
export type CalendarEventsResponse = z.infer<typeof calendarEventsResponseSchema>;

export const updateAgentProfileRequestSchema = z.object({
  displayName: z.string().min(1).optional(),
  llmModel: z.string().min(1).nullable().optional(),
  systemPrompt: z.string().min(1).nullable().optional(),
});

export const addAgentMemoryRequestSchema = z.object({
  memoryType: z.string().min(1),
  content: z.string().min(1),
  source: z.string().min(1).optional(),
});

export const upsertAgentConnectorRequestSchema = z.object({
  provider: z.string().min(1),
  status: z.enum(["connected", "disconnected", "error"]),
  scope: z.enum(["private", "public", "shared"]).optional(),
  externalAccountEmail: z.string().email().nullable().optional(),
  secretRef: z.string().min(1).nullable().optional(),
});

export const upsertAgentToolPolicyRequestSchema = z.object({
  toolName: z.string().min(1),
  mode: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const agentSettingsResponseSchema = agentSettingsSchema;
export const updateAgentProfileResponseSchema = z.object({
  profile: agentProfileSchema,
});
export const addAgentMemoryResponseSchema = z.object({
  memory: agentMemorySchema,
});
export const upsertAgentConnectorResponseSchema = z.object({
  connector: agentConnectorSchema,
});
export const upsertAgentToolPolicyResponseSchema = z.object({
  toolPolicy: agentToolPolicySchema,
});

export const logoutAllDevicesResponseSchema = z.object({
  ok: z.literal(true),
});

export const updateUserProfileRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(MAX_USER_PROFILE_DISPLAY_NAME_LENGTH),
});

export const updateUserProfileResponseSchema = z.object({
  user: userSchema,
});

export const mediaPreferencesSchema = z.object({
  backgroundBlurEnabled: z.boolean(),
});

export const mediaPreferencesResponseSchema = z.object({
  preferences: mediaPreferencesSchema,
});

export const updateMediaPreferencesRequestSchema = z.object({
  backgroundBlurEnabled: z.boolean(),
});

export const deleteAccountRequestSchema = z.object({
  confirmationEmail: z.string().email(),
});

export const deleteAccountResponseSchema = z.object({
  ok: z.literal(true),
  deletionId: z.string().uuid().optional(),
});
