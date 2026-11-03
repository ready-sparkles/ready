import type { MeetingAmbientContextItem } from "@readymeet/shared";

/** Synthetic data shared by context tests and the development preview. */
export function createAmbientContextItem(
  overrides: Partial<MeetingAmbientContextItem> = {},
): MeetingAmbientContextItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    meetingId: "22222222-2222-4222-8222-222222222222",
    entityKind: "company",
    canonicalKey: "company:linear",
    displayName: "Linear",
    qualifier: null,
    imageUrl: null,
    imageStatus: "unavailable",
    professionalTitle: null,
    companyName: null,
    headquarters: null,
    officialWebsite: null,
    profileUrl: null,
    summary: null,
    facts: [],
    citations: [],
    facets: [],
    status: "pending",
    mentionCount: 1,
    error: null,
    firstMentionedAt: "2026-09-25T10:00:00Z",
    lastMentionedAt: "2026-09-25T10:00:00Z",
    researchStartedAt: null,
    researchCompletedAt: null,
    createdAt: "2026-09-25T10:00:00Z",
    updatedAt: "2026-09-25T10:00:00Z",
    ...overrides,
  };
}
