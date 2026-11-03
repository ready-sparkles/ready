type MemorySourceApp = "zoom" | "gmail" | "slack" | "linkedin" | "ashby" | "notion" | "highlight";
type EvidenceKind = "transcript";

interface Evidence {
  kind: EvidenceKind;
  label: string;
  snippet?: string;
}

export interface DemoMoment {
  id: string;
  meetingId?: string;
  ts: string;
  sources: MemorySourceApp[];
  kind: "meeting" | "email_sent" | "email_received" | "stage_change" | "sourcing_session" | "thread" | "doc_work";
  boundedness: "event" | "session";
  title: string;
  description: string;
  category?: string;
  note?: string;
  entities: { people?: string[]; roles?: string[]; companies?: string[] };
  // Explicit direct exchanges with the viewer; mentions alone do not qualify.
  interactionWith?: string[];
  evidence: Evidence[];
  state?: "pinned" | "fading" | "retained";
  fadesOn?: string;
  durationMin?: number;
}

type InterviewNote = {
  heading: string;
  bullets: string[];
};

type InterviewTask = {
  id?: string;
  title: string;
  description: string;
  owner: string;
  initials: string;
  color: string;
};

export type CandidateInterview = {
  id: string;
  sensitiveReviewId?: string;
  startedAt: string;
  endedAt?: string;
  company?: string;
  category?: string;
  sourceMemoryIds?: string[];
  title: string;
  time: string;
  preview: string;
  date: string;
  participants: {
    name: string;
    initials: string;
    color: string;
  }[];
  notes: InterviewNote[];
  tasks: InterviewTask[];
};

export type PersonPreview = {
  summary: string;
  standing: string[];
  // Only direct exchanges on this person's timeline may support their recap.
  sourceMemoryIds: string[];
};

export interface TranscriptTurn {
  speaker: string;
  text: string;
  seconds: number;
  isEvidence?: boolean;
}
