import { z } from "zod";

export const PRESENTATION_CLAIM_TOPIC = "readymeet.presentation.claim";

export const presentationClaimWireSchema = z.object({
  type: z.literal(PRESENTATION_CLAIM_TOPIC),
  state: z.enum(["starting", "clear", "sync-request"]),
  requestedAt: z.number().optional(),
});

export type PresentationClaimWireSchemaValue = z.infer<typeof presentationClaimWireSchema>;
export type SchemaSafeParseResult<T> = z.SafeParseReturnType<unknown, T>;
