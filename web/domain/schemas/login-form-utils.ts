import { z } from "zod";

export const googleAddonFlowMarkerSchema = z.object({
  accountId: z.string(),
  callbackUrl: z.string(),
  expiresAt: z.number(),
});
