import type { repositoryPort } from "../index";

export type { WorkspaceAshbyIntegration } from "../adapters/secondary/postgres/ashby";
export type { CallInDbConnection } from "../adapters/secondary/postgres/meeting-call-in-lock";
export type { MemoryJob, MemoryScope, MemorySource } from "../adapters/secondary/postgres/relationship-memory";
export type {
  StoredMeetingAmbientContextItem,
  VoiceWebResearchRunRow,
} from "../adapters/secondary/postgres/repositories";

// This input stays independent of the assembled repository to avoid recursive inference.
export type MeetingBriefPastMeetingContextCandidate = {
  meetingId: string;
  title: string;
  endedAt: string;
  summary: string | null;
  participants: {
    email: string;
    displayName: string;
  }[];
};

export type RepositoryPort = typeof repositoryPort;

export type CalendarEventPrepRow = NonNullable<Awaited<ReturnType<RepositoryPort["getCalendarEventPrepByIdForUser"]>>>;
