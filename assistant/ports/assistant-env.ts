import { DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL, openAIModelPricesEnvSchema } from "@readymeet/shared";
import { z } from "zod";

const DEFAULT_ASSISTANT_PORT = 4100;
const DEFAULT_LIVEKIT_REALTIME_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_LIVEKIT_REALTIME_STOP_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_OPENAI_MEETING_SUMMARY_PROGRESS_DELAY_MS = 500;
const DEFAULT_OPENAI_MEETING_SUMMARY_TIMEOUT_MS = 45_000;
const DEFAULT_OPENAI_MEETING_SNAPSHOT_TIMEOUT_MS = 30_000;
const DEFAULT_OPENAI_MEETING_TITLE_TIMEOUT_MS = 10_000;
const DEFAULT_OPENAI_MEETING_TASKS_TIMEOUT_MS = 90_000;
const DEFAULT_OPENAI_MEETING_EXTRACTION_TIMEOUT_MS = 180_000;
const DEFAULT_MEETING_EXTRACTION_MAX_TURNS = 50;
const DEFAULT_OPENAI_CAPABILITY_SELECTION_TIMEOUT_MS = 90_000;
const DEFAULT_OPENAI_CAPABILITY_WORKFLOW_TIMEOUT_MS = 60_000;

const ASSISTANT_ENV_NOT_CONFIGURED_MESSAGE = "Assistant environment is not configured.";
const developmentDefaultInProductionMessage = (key: string) =>
  `Set ${key} in production; its default is for local development only.`;

/** Local-only values. Production must override each one, because these point at localhost or a public secret. */
const DEVELOPMENT_DEFAULTS = {
  API_BASE_URL: "http://localhost:4000",
  LIVEKIT_REALTIME_SERVICE_URL: "http://localhost:4200",
  LIVEKIT_REALTIME_SERVICE_SECRET: "livekit_realtime_shared_secret",
} as const;

const assistantEnvObjectSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ASSISTANT_PORT: z.coerce.number().default(DEFAULT_ASSISTANT_PORT),
  DATABASE_URL: z.string().url(),
  API_BASE_URL: z.string().url().default(DEVELOPMENT_DEFAULTS.API_BASE_URL),
  ASSISTANT_SERVICE_SECRET: z.string().min(1),
  LIVEKIT_REALTIME_SERVICE_URL: z.string().url().default(DEVELOPMENT_DEFAULTS.LIVEKIT_REALTIME_SERVICE_URL),
  LIVEKIT_REALTIME_SERVICE_SECRET: z.string().min(1).default(DEVELOPMENT_DEFAULTS.LIVEKIT_REALTIME_SERVICE_SECRET),
  LIVEKIT_REALTIME_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIVEKIT_REALTIME_REQUEST_TIMEOUT_MS),
  // A clean stop can legitimately spend 12s draining tracks before caption,
  // transcript-settle, disconnect, and final-callback work runs.
  LIVEKIT_REALTIME_STOP_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIVEKIT_REALTIME_STOP_REQUEST_TIMEOUT_MS),
  LIVEKIT_URL: z.string().url().or(z.string().startsWith("wss://")).optional().or(z.literal("")),
  LIVEKIT_API_KEY: z.string().optional().or(z.literal("")),
  LIVEKIT_API_SECRET: z.string().optional().or(z.literal("")),
  LIVEKIT_ROOM_ASSISTANT_NAME: z.string().default("readymeet-meeting-agent"),
  AI_GATEWAY_API_KEY: z.string().optional().or(z.literal("")),
  OPENAI_API_KEY: z.string().optional().or(z.literal("")),
  OPENAI_INPUT_TOKEN_COUNT_BILLING: z.enum(["unverified", "free"]).default("unverified"),
  OPENAI_MEETING_SUMMARY_MODEL: z.string().default("gpt-5.5"),
  OPENAI_MEETING_SUMMARY_PROGRESS_DELAY_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_OPENAI_MEETING_SUMMARY_PROGRESS_DELAY_MS),
  OPENAI_MEETING_SUMMARY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPENAI_MEETING_SUMMARY_TIMEOUT_MS),
  OPENAI_MEMORY_MODEL: z.string().optional(),
  OPENAI_MEETING_EXTRACTION_MODEL: z.string().default("gpt-5.4-mini"),
  OPENAI_MEETING_SNAPSHOT_MODEL: z.string().default(DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL),
  OPENAI_MEETING_SNAPSHOT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPENAI_MEETING_SNAPSHOT_TIMEOUT_MS),
  OPENAI_MEETING_TITLE_MODEL: z.string().default("gpt-5.4-nano"),
  OPENAI_MEETING_TITLE_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_OPENAI_MEETING_TITLE_TIMEOUT_MS),
  OPENAI_MEETING_TASKS_MODEL: z.string().default("gpt-5.6-sol"),
  OPENAI_MEETING_TASKS_TIMEOUT_MS: z.coerce.number().int().positive().default(DEFAULT_OPENAI_MEETING_TASKS_TIMEOUT_MS),
  OPENAI_MEETING_EXTRACTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPENAI_MEETING_EXTRACTION_TIMEOUT_MS),
  MEETING_EXTRACTION_MAX_TURNS: z.coerce.number().int().positive().default(DEFAULT_MEETING_EXTRACTION_MAX_TURNS),
  OPENAI_CAPABILITY_SELECTION_MODEL: z.string().default("gpt-5.4-nano"),
  OPENAI_CAPABILITY_SELECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPENAI_CAPABILITY_SELECTION_TIMEOUT_MS),
  OPENAI_CAPABILITY_WORKFLOW_MODEL: z.string().default("gpt-5.4-mini"),
  OPENAI_CAPABILITY_WORKFLOW_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPENAI_CAPABILITY_WORKFLOW_TIMEOUT_MS),
  OPENAI_MODEL_PRICES_JSON: openAIModelPricesEnvSchema,
  SENTRY_DSN: z.string().url().optional().or(z.literal("")).default(""),
  SENTRY_ENVIRONMENT: z.string().trim().optional().or(z.literal("")).default(""),
});

export const assistantEnvSchema = assistantEnvObjectSchema.superRefine((env, context) => {
  if (env.NODE_ENV !== "production") {
    return;
  }

  const values = new Map<string, unknown>(Object.entries(env));
  Object.entries(DEVELOPMENT_DEFAULTS)
    .filter(([key, developmentValue]) => values.get(key) === developmentValue)
    .forEach(([key]) => {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: developmentDefaultInProductionMessage(key),
      });
    });
});

type AssistantEnv = z.infer<typeof assistantEnvSchema>;

const assistantEnvState: { env?: AssistantEnv } = {};

export function configureAssistantEnv(env: AssistantEnv): void {
  assistantEnvState.env = env;
}

export function assistantEnv(): AssistantEnv {
  if (assistantEnvState.env === undefined) {
    throw new Error(ASSISTANT_ENV_NOT_CONFIGURED_MESSAGE);
  }

  return assistantEnvState.env;
}
