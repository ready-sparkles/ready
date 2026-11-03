import { z } from "zod";

// Final transcript segments are already stable when they arrive. Keep a short
// tail so the detector can use the next phrase for disambiguation without
// making every useful result feel five seconds late.
export const AMBIENT_CONTEXT_SETTLE_MS = 2_000;
export const AMBIENT_CONTEXT_KNOWN_ENTITY_LIMIT = 12;

export const AMBIENT_IDENTITY_UNVERIFIED = "Could not verify the requested identity. Retry explicitly to search again.";
// Compatibility with persisted errors from earlier versions. New suppression
// deletes untouched duplicates, but old rows must remain hidden and retryable.
export const AMBIENT_VOICE_SEARCH_HANDLED = "This request is already handled by the voice search.";

export const ambientContextEntityKindSchema = z.enum(["person", "company"]);
export type AmbientContextEntityKind = z.infer<typeof ambientContextEntityKindSchema>;

export const ambientContextResearchStatusSchema = z.enum(["pending", "researching", "ready", "failed"]);
export type AmbientContextResearchStatus = z.infer<typeof ambientContextResearchStatusSchema>;

export const ambientContextImageStatusSchema = z.enum(["pending", "ready", "unavailable"]);
export type AmbientContextImageStatus = z.infer<typeof ambientContextImageStatusSchema>;

export const ambientContextCitationSchema = z.object({
  isArticle: z.boolean().optional(),
  title: z.string().trim().min(1),
  url: z.string().url(),
  domain: z.string().trim().min(1).nullable().default(null),
  excerpt: z.string().trim().min(1).nullable().default(null),
});
export type AmbientContextCitation = z.infer<typeof ambientContextCitationSchema>;

export const meetingAmbientContextItemSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  entityKind: ambientContextEntityKindSchema,
  canonicalKey: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  qualifier: z.string().trim().min(1).nullable(),
  imageUrl: z.string().trim().min(1).nullable(),
  imageStatus: ambientContextImageStatusSchema,
  professionalTitle: z.string().trim().min(1).nullable(),
  companyName: z.string().trim().min(1).nullable(),
  headquarters: z.string().trim().min(1).nullable(),
  officialWebsite: z.string().url().nullable(),
  profileUrl: z.string().url().nullable(),
  summary: z.string().trim().min(1).nullable(),
  facts: z.array(z.string().trim().min(1)),
  citations: z.array(ambientContextCitationSchema),
  facets: z.array(z.string().trim().min(1)),
  status: ambientContextResearchStatusSchema,
  mentionCount: z.number().int().positive(),
  error: z.string().trim().min(1).nullable(),
  firstMentionedAt: z.string().datetime(),
  lastMentionedAt: z.string().datetime(),
  researchStartedAt: z.string().datetime().nullable(),
  researchCompletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MeetingAmbientContextItem = z.infer<typeof meetingAmbientContextItemSchema>;

export function canRetryAmbientContextResearch(item: Pick<MeetingAmbientContextItem, "status" | "error">): boolean {
  return item.status === "failed" || (item.status === "ready" && item.error === AMBIENT_IDENTITY_UNVERIFIED);
}

export const meetingAmbientContextResponseSchema = z.object({
  items: z.array(meetingAmbientContextItemSchema),
});
export type MeetingAmbientContextResponse = z.infer<typeof meetingAmbientContextResponseSchema>;

/**
 * The private sections of a person card, computed for one viewer and never
 * stored on the shared card: what the viewer's own memory says about the
 * person, and Ashby application facts when the viewer turned Ashby on.
 */
export const ambientContextPrivateDetailsSchema = z.object({
  memory: z
    .object({
      personId: z.string().uuid(),
      name: z.string(),
      imageUrl: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      summary: z.array(z.string()),
      standing: z.array(z.string()),
      lastContact: z.string().nullable(),
    })
    .nullable(),
  ashby: z
    .object({
      candidateName: z.string(),
      profileUrl: z.string().url(),
      facts: z.array(z.string()),
    })
    .nullable(),
});
export type AmbientContextPrivateDetails = z.infer<typeof ambientContextPrivateDetailsSchema>;

/** Returned only to the authenticated viewer; never published on a meeting channel. */
export const meetingPeopleMemoryResponseSchema = z.object({
  items: z.array(
    meetingAmbientContextItemSchema.extend({
      privateImageUrl: z.string().nullable(),
      privateDetails: ambientContextPrivateDetailsSchema,
    }),
  ),
});

export const ambientContextRealtimeEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().uuid(),
  meetingId: z.string().uuid(),
  itemId: z.string().uuid(),
  status: ambientContextResearchStatusSchema,
  occurredAt: z.string().datetime(),
});
export type AmbientContextRealtimeEvent = z.infer<typeof ambientContextRealtimeEventSchema>;

export const AMBIENT_CONTEXT_REALTIME_EVENT_NAME = "ambient-context.updated" as const;
