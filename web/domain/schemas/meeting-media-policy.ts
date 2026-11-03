import { z } from "zod";

export const deviceHistorySchema = z.object({
  cpuLimitedAt: z.record(z.string(), z.record(z.string(), z.number())).optional(),
});

export const storedNumberSchema = z.number();

export const cachedProbeEntrySchema = z.object({
  at: z.number(),
  result: z.object({
    codec: z.string(),
    status: z.string(),
    cached: z.boolean(),
    cost: z
      .object({
        supported: z.boolean(),
        smooth: z.boolean(),
        powerEfficient: z.boolean(),
      })
      .nullable(),
  }),
});

export type CachedProbeEntrySchemaValue = z.infer<typeof cachedProbeEntrySchema>;
