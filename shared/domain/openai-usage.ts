import { z } from "zod";

const MICRO_USD_PER_USD = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000;
const ZERO_TOKEN_COUNT = 0;

const openAIModelPriceSchema = z.object({
  inputPerMillion: z.number().optional(),
  cachedInputPerMillion: z.number().optional(),
  outputPerMillion: z.number().optional(),
  totalPerMillion: z.number().optional(),
});

const openAIModelPricesSchema = z.record(z.string(), openAIModelPriceSchema);

export type OpenAIModelPrice = z.infer<typeof openAIModelPriceSchema>;

export type OpenAIResponseUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};

function toTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Parses the OPENAI_MODEL_PRICES_JSON setting; invalid JSON or shape means no prices are configured. */
export function parseOpenAIModelPrices(json: string): Record<string, OpenAIModelPrice> {
  try {
    const parsed = openAIModelPricesSchema.safeParse(JSON.parse(json));

    return parsed.success ? parsed.data : {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {};
    }
    throw error;
  }
}

export function extractOpenAIResponseUsage(response: unknown): OpenAIResponseUsage | null {
  const payload = objectRecord(response);
  const usage = objectRecord(payload?.usage);
  if (usage === null) {
    return null;
  }

  const inputTokens = toTokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = toTokenCount(usage.output_tokens ?? usage.completion_tokens);
  const totalFromUsage = toTokenCount(usage.total_tokens);
  const totalTokens = totalFromUsage > ZERO_TOKEN_COUNT ? totalFromUsage : inputTokens + outputTokens;
  const inputDetails = objectRecord(usage.input_tokens_details ?? usage.prompt_tokens_details);
  const cachedInputTokens = toTokenCount(inputDetails?.cached_tokens);

  if (totalTokens <= ZERO_TOKEN_COUNT) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
  };
}

export function calculateOpenAIUsageCostMicroUsd(params: {
  price: OpenAIModelPrice | undefined;
  usage: OpenAIResponseUsage;
}): {
  costMicroUsd: number;
  // @external rateConfigured
  rateConfigured: boolean;
  unitPriceMicroUsd: number | null;
  price: OpenAIModelPrice | undefined;
} {
  const { price, usage } = params;
  if (price === undefined) {
    return {
      costMicroUsd: 0,
      rateConfigured: false,
      unitPriceMicroUsd: null,
      price,
    };
  }

  if (typeof price.totalPerMillion === "number") {
    const costUsd = (usage.totalTokens / TOKENS_PER_MILLION) * price.totalPerMillion;

    return {
      costMicroUsd: Math.max(0, Math.round(costUsd * MICRO_USD_PER_USD)),
      rateConfigured: true,
      unitPriceMicroUsd: Math.round((price.totalPerMillion * MICRO_USD_PER_USD) / TOKENS_PER_MILLION),
      price,
    };
  }

  if (typeof price.inputPerMillion === "number" || typeof price.outputPerMillion === "number") {
    // input_tokens includes cached tokens, which OpenAI bills at a discount;
    // price them separately so caching lowers the recorded cost.
    const cachedTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
    const freshInputTokens = usage.inputTokens - cachedTokens;
    const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion ?? 0;
    const inputCostUsd =
      (freshInputTokens / TOKENS_PER_MILLION) * (price.inputPerMillion ?? 0) +
      (cachedTokens / TOKENS_PER_MILLION) * cachedRate;
    const outputCostUsd = (usage.outputTokens / TOKENS_PER_MILLION) * (price.outputPerMillion ?? 0);

    return {
      costMicroUsd: Math.max(0, Math.round((inputCostUsd + outputCostUsd) * MICRO_USD_PER_USD)),
      rateConfigured: true,
      unitPriceMicroUsd: null,
      price,
    };
  }

  return {
    costMicroUsd: 0,
    rateConfigured: false,
    unitPriceMicroUsd: null,
    price,
  };
}

/** Built-in tariffs for the models selected by the default service configuration. */
/* eslint-disable @typescript-eslint/no-magic-numbers -- Published tariff table; literal values are independently auditable. */
/** Notes (meeting snapshot) model. The assistant runs it and the notes lock prices its smallest run. */
export const DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL = "gpt-5.6-sol";

export const DEFAULT_OPENAI_MODEL_PRICES_JSON = JSON.stringify({
  "gpt-5.6-sol": {
    inputPerMillion: 4,
    cachedInputPerMillion: 0.4,
    outputPerMillion: 20,
    maxContextTokens: 1050000,
    longContext: {
      thresholdTokens: 272000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
    cacheWritePerMillion: 5,
  },
  "gpt-5.5": {
    inputPerMillion: 5,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 30,
    maxContextTokens: 1050000,
    longContext: {
      thresholdTokens: 272000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
  },
  "gpt-5.4": {
    inputPerMillion: 2.5,
    cachedInputPerMillion: 0.25,
    outputPerMillion: 15,
    maxContextTokens: 1050000,
    longContext: {
      thresholdTokens: 272000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
  },
  "gpt-5.4-mini": {
    inputPerMillion: 0.75,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 4.5,
    maxContextTokens: 400000,
    longContext: {
      thresholdTokens: 272000,
      inputMultiplier: 1,
      outputMultiplier: 1,
    },
  },
  "gpt-5.4-nano": {
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    outputPerMillion: 1.25,
    maxContextTokens: 400000,
    longContext: {
      thresholdTokens: 272000,
      inputMultiplier: 1,
      outputMultiplier: 1,
    },
  },
  "gpt-4o-mini": {
    inputPerMillion: 0.15,
    cachedInputPerMillion: 0.075,
    outputPerMillion: 0.6,
    maxContextTokens: 128000,
  },
  "gpt-4o-transcribe": {
    inputPerMillion: 6,
    outputPerMillion: 10,
  },
  "gpt-4o-mini-transcribe": {
    inputPerMillion: 3,
    outputPerMillion: 5,
  },
  "gpt-5.6-luna": {
    inputPerMillion: 0.2,
    cachedInputPerMillion: 0.02,
    cacheWritePerMillion: 0.25,
    outputPerMillion: 1.2,
    maxContextTokens: 1050000,
    longContext: {
      thresholdTokens: 272000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
  },
  "gpt-6-luna": {
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.01,
    cacheWritePerMillion: 0.125,
    outputPerMillion: 0.5,
    maxContextTokens: 1050000,
    longContext: {
      thresholdTokens: 272000,
      inputMultiplier: 2,
      outputMultiplier: 1.5,
    },
  },
});

/* eslint-enable @typescript-eslint/no-magic-numbers */

const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
const CACHE_WRITE_MAJOR_VERSION = 5;
const CACHE_WRITE_MINOR_VERSION = 6;
const TRANSCRIPTION_MODEL_PATTERN = /transcribe/;
const MODEL_GENERATION_PATTERN = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/;
const MODEL_PRICES_INVALID_JSON_MESSAGE = "OPENAI_MODEL_PRICES_JSON is not valid JSON.";
const MODEL_PRICES_INVALID_SHAPE_MESSAGE = "OPENAI_MODEL_PRICES_JSON must map model names to price objects.";
const MODEL_PRICES_INCOMPLETE_MESSAGE = "OPENAI_MODEL_PRICES_JSON is incomplete:";
const configuredModelPriceSchema = z.object({
  inputPerMillion: z.number().finite().nonnegative().optional(),
  cachedInputPerMillion: z.number().finite().nonnegative().optional(),
  cacheWritePerMillion: z.number().finite().nonnegative().optional(),
  outputPerMillion: z.number().finite().nonnegative().optional(),
  totalPerMillion: z.number().finite().nonnegative().optional(),
  maxContextTokens: z.number().int().positive().safe().optional(),
  longContext: z
    .object({
      thresholdTokens: z.number().int().positive().safe(),
      inputMultiplier: z.number().finite().min(1),
      outputMultiplier: z.number().finite().min(1),
    })
    .optional(),
});
const configuredModelPricesSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
type ConfiguredModelPrice = z.infer<typeof configuredModelPriceSchema>;

function requiresCacheWriteTariff(model: string): boolean {
  const generation = MODEL_GENERATION_PATTERN.exec(model);
  if (generation === null) {
    return false;
  }
  const major = Number(generation[1]);
  const minor = Number(generation[2] ?? 0);

  return (
    major > CACHE_WRITE_MAJOR_VERSION || (major === CACHE_WRITE_MAJOR_VERSION && minor >= CACHE_WRITE_MINOR_VERSION)
  );
}

function incompleteModelPricesMessage(problems: string[]): string {
  return `${MODEL_PRICES_INCOMPLETE_MESSAGE} ${problems.join("; ")}.`;
}

function modelPriceProblem({ model, price }: { model: string; price: ConfiguredModelPrice }): string | null {
  if (TRANSCRIPTION_MODEL_PATTERN.test(model)) {
    return null;
  }
  if (price.maxContextTokens === undefined) {
    return `${model} needs maxContextTokens`;
  }
  // The API meters the same models and only supports split input/output tariffs, so a
  // total-token rate alone would pass here and then fail every metered API request.
  if (price.inputPerMillion === undefined || price.outputPerMillion === undefined) {
    return `${model} needs inputPerMillion and outputPerMillion`;
  }
  if (price.maxContextTokens > LONG_CONTEXT_THRESHOLD_TOKENS && price.longContext === undefined) {
    return `${model} needs longContext pricing above ${String(LONG_CONTEXT_THRESHOLD_TOKENS)} tokens`;
  }
  if (requiresCacheWriteTariff(model) && price.cacheWritePerMillion === undefined) {
    return `${model} needs cacheWritePerMillion`;
  }

  return null;
}

/**
 * Resolves the OPENAI_MODEL_PRICES_JSON setting once at startup. Blank uses the built-in tariffs;
 * configured entries override the built-in fields of the same model, so an override that only
 * restates prices keeps the verified context limits. Anything that would make a priced request
 * fail later (bad JSON, a text model without maxContextTokens, missing long-context or cache-write
 * tariffs) throws here so the service refuses to start instead of failing every AI request.
 */
export function resolveOpenAIModelPricesJson(configured: string | undefined): string {
  const defaults = configuredModelPricesSchema.parse(JSON.parse(DEFAULT_OPENAI_MODEL_PRICES_JSON));
  const trimmed = configured?.trim() ?? "";
  if (trimmed === "") {
    return DEFAULT_OPENAI_MODEL_PRICES_JSON;
  }
  const overrides = ((): ReturnType<typeof configuredModelPricesSchema.safeParse> => {
    try {
      return configuredModelPricesSchema.safeParse(JSON.parse(trimmed));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(MODEL_PRICES_INVALID_JSON_MESSAGE, { cause: error });
      }
      throw error;
    }
  })();
  if (!overrides.success) {
    throw new Error(MODEL_PRICES_INVALID_SHAPE_MESSAGE);
  }
  const merged = { ...defaults };
  Object.entries(overrides.data).forEach(([model, override]) => {
    merged[model] = { ...defaults[model], ...override };
  });
  const problems = Object.entries(merged).flatMap(([model, entry]) => {
    const price = configuredModelPriceSchema.safeParse(entry);
    if (!price.success) {
      return [`${model} has invalid price fields`];
    }
    const problem = modelPriceProblem({ model, price: price.data });

    return problem === null ? [] : [problem];
  });
  if (problems.length !== 0) {
    throw new Error(incompleteModelPricesMessage(problems));
  }

  return JSON.stringify(merged);
}
const SELF_CONTAINED_INPUT_REQUIRED = "Local admission requires self-contained plaintext input.";
const WIRE_FRAMING_TOKEN_ALLOWANCE = 4096;
// The AI SDK re-serializes the request (OpenAI or Gateway wire shape). Measured on snapshot and
// tool-call bodies it stays within 1% of JSON.stringify(body); 25% covers that with a wide margin.
const SDK_SERIALIZATION_HEADROOM_NUMERATOR = 5;
const SDK_SERIALIZATION_HEADROOM_DENOMINATOR = 4;

/**
 * Upper bound on input tokens for a self-contained text request, used to reserve credits before
 * dispatch. Byte-level BPE never emits more text tokens than UTF-8 bytes, so the serialized size
 * (plus SDK and chat-template framing) is a hard ceiling. It was 4x the bytes, which held several
 * times the real prompt cost and pushed one Pro meeting snapshot past the 250-credit allowance.
 * The transport re-checks its final serialized request against this limit before dispatch, so an
 * underestimate fails closed (not dispatched, hold released) rather than overspending.
 */
export function maximumOpenAITextInputTokens(body: object): number {
  const serialized = JSON.stringify(body);
  if (/"(?:previous_response_id|conversation|encrypted_content)"\s*:/.test(serialized)) {
    throw new Error(SELF_CONTAINED_INPUT_REQUIRED);
  }
  const bytes = new TextEncoder().encode(serialized).length;

  return (
    Math.ceil((bytes * SDK_SERIALIZATION_HEADROOM_NUMERATOR) / SDK_SERIALIZATION_HEADROOM_DENOMINATOR) +
    WIRE_FRAMING_TOKEN_ALLOWANCE
  );
}

/** Environment field for OPENAI_MODEL_PRICES_JSON: resolves and validates at startup. */
export const openAIModelPricesEnvSchema = z
  .string()
  .optional()
  .transform((value, context) => {
    try {
      return resolveOpenAIModelPricesJson(value);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      context.addIssue({ code: z.ZodIssueCode.custom, message: error.message });

      return z.NEVER;
    }
  });
