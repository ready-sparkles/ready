import type { LanguageModelUsage } from "ai";
import { z } from "zod";

export type BillingIdentity = {
  userId: string;
  workspaceId: string;
  feature: string;
};

export type GatewayBillingIdentity = BillingIdentity & { gatewayApiKey: string; maxInputTokens?: number };

export type TotalUsage = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  cacheWriteInputTokens: number | undefined;
};

export function billingProviderOptions(billing: BillingIdentity): { user: string; tags: string[] } {
  return { user: billing.userId, tags: [`workspace:${billing.workspaceId}`, `feature:${billing.feature}`] };
}

export function normalizeTotalUsage(usage: LanguageModelUsage): TotalUsage | undefined {
  if (
    usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.inputTokenDetails.cacheReadTokens === undefined &&
    usage.inputTokenDetails.cacheWriteTokens === undefined
  ) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
    cacheWriteInputTokens: usage.inputTokenDetails.cacheWriteTokens,
  };
}

const tokenCountSchema = z.number().int().nonnegative().optional();
const wireUsageSchema = z.object({
  input_tokens: tokenCountSchema,
  output_tokens: tokenCountSchema,
  input_tokens_details: z.object({ cached_tokens: tokenCountSchema, cache_write_tokens: tokenCountSchema }).optional(),
});

export function usageFromPayload(payload: unknown): TotalUsage | undefined {
  const parsed = z.object({ usage: wireUsageSchema }).safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }

  const usage = {
    inputTokens: parsed.data.usage.input_tokens,
    outputTokens: parsed.data.usage.output_tokens,
    cachedInputTokens: parsed.data.usage.input_tokens_details?.cached_tokens,
    cacheWriteInputTokens: parsed.data.usage.input_tokens_details?.cache_write_tokens,
  };

  return Object.values(usage).every((value) => value === undefined) ? undefined : usage;
}
