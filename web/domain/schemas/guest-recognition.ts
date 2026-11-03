import { z } from "zod";

export const guestRecognitionStatusResponseSchema = z.object({
  /** @external guest recognition available wire field */
  available: z.boolean(),
  /** @external guest recognition recognized wire field */
  recognized: z.boolean(),
  lastDisplayName: z.string().nullable().optional(),
});
