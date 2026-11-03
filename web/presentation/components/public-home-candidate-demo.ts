import type { MeetingAmbientContextItem } from "@readymeet/shared";

import {
  DEMO_PERSON_BY,
  DEMO_PERSON_BY_COMPANY,
  DEMO_PERSON_BY_SOURCES,
  DEMO_PERSON_BY_STANDING,
  DEMO_PERSON_BY_SUMMARY,
} from "../../domain/workspace-demo/personby";

// Illustrative marketing data only. No private records or provider calls.
const DEMO_TIME = "2026-09-28T17:42:00.000Z";
const candidate: MeetingAmbientContextItem = {
  id: "00000000-0000-4000-8000-000000000001",
  meetingId: "00000000-0000-4000-8000-000000000002",
  entityKind: "person",
  canonicalKey: "person:personby",
  displayName: DEMO_PERSON_BY,
  qualifier: DEMO_PERSON_BY_COMPANY,
  professionalTitle: "COO",
  companyName: DEMO_PERSON_BY_COMPANY,
  headquarters: null,
  officialWebsite: null,
  profileUrl: null,
  imageUrl: null,
  imageStatus: "unavailable",
  summary: null,
  facts: [],
  citations: [],
  facets: [],
  status: "researching",
  mentionCount: 1,
  error: null,
  firstMentionedAt: DEMO_TIME,
  lastMentionedAt: DEMO_TIME,
  researchStartedAt: DEMO_TIME,
  researchCompletedAt: null,
  createdAt: DEMO_TIME,
  updatedAt: DEMO_TIME,
};

export const PUBLIC_HOME_CANDIDATE_DEMO = {
  researching: candidate,
  ready: {
    ...candidate,
    status: "ready",
    researchCompletedAt: DEMO_TIME,
    summary: DEMO_PERSON_BY_SUMMARY,
    facts: DEMO_PERSON_BY_STANDING,
    citations: DEMO_PERSON_BY_SOURCES,
  },
} satisfies Record<string, MeetingAmbientContextItem>;
