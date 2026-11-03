import type {
  ActionItem,
  CapabilityRecommendationView,
  LinearTaskReviewRun,
  Meeting,
  meetingNotesAccessSchema,
  meetingNotesViewResponseSchema,
  MeetingResearchRunView,
  MeetingRuntimeState,
  MeetingTaskList,
  Summary,
  TranscriptInfo,
  TranscriptSegment,
  User,
  VoiceWebResearchRunView,
} from "@readymeet/shared";
import type { z } from "zod";

type MeetingNotesAccess = z.infer<typeof meetingNotesAccessSchema>;

export type PostMeetingDisposition = {
  status: "skipped";
  reason: "too_short_duration" | "too_short_transcript";
  redirectTo: "/workspace?view=upcoming";
  message: string;
};

export type AuthSession = {
  token: string;
  user: User;
};

export type MeetingDetailPayload = {
  meeting: Meeting;
  meetingRuntime: MeetingRuntimeState;
  transcript: TranscriptInfo | null;
  transcriptSegments: TranscriptSegment[];
  summary: Summary | null;
  notesPreview?: { status: "pending" | "ready"; content: string } | null;
  actionItems: ActionItem[];
  tasks: MeetingTaskList | null;
  linearTaskReview?: LinearTaskReviewRun | null;
  capabilityRecommendations: CapabilityRecommendationView[];
  webResearchRuns?: VoiceWebResearchRunView[];
  researchRuns?: MeetingResearchRunView[];
  postMeetingDisposition: PostMeetingDisposition | null;
  notesAccess: MeetingNotesAccess;
};

export type MeetingNotesViewPayload = z.infer<typeof meetingNotesViewResponseSchema>;
