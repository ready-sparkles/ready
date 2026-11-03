import { DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL, openAIModelPricesEnvSchema } from "@readymeet/shared";
import { z } from "zod";

const API_ENV_NUMBER_0_0005 = 0.0005;

const API_ENV_NUMBER_3 = 3;

const API_ENV_NUMBER_14 = 14;

const API_ENV_NUMBER_16 = 16;

const API_ENV_NUMBER_20 = 20;

const API_ENV_NUMBER_32 = 32;

const API_ENV_NUMBER_100 = 100;

const API_ENV_NUMBER_250 = 250;

const API_ENV_NUMBER_4000 = 4000;

const API_ENV_NUMBER_10000 = 10000;

const API_ENV_NUMBER_12000 = 12000;

const API_ENV_NUMBER_20000 = 20000;

const API_ENV_NUMBER_30000 = 30000;

const API_ENV_NUMBER_60000 = 60000;

const API_ENV_NUMBER_70000 = 70000;

const API_ENV_NUMBER_75000 = 75000;

const API_ENV_NUMBER_120000 = 120000;

const API_ENV_NUMBER_150000 = 150000;

const API_ENV_NUMBER_195000 = 195000;

const API_ENV_NUMBER_260000 = 260000;

const API_ENV_NUMBER_300000 = 300000;

const API_ENV_NUMBER_600000 = 600000;

const API_ENV_NUMBER_86400000 = 86400000;

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off", ""].includes(normalized)) {
    return false;
  }

  return value;
}, z.boolean());

/** Admin access before ADMIN_EMAIL existed; kept so an unset variable never locks admins out. */
export const DEFAULT_ADMIN_EMAILS: readonly string[] = ["sam@ready.app"];
const ADMIN_EMAIL_SEPARATOR = ",";

/** Comma-separated admin addresses, trimmed and lowercased. Unset or blank falls back to the default admin. */
const adminEmailsSchema = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(ADMIN_EMAIL_SEPARATOR)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  )
  .pipe(z.array(z.string().email()))
  .transform((emails) => (emails.length === 0 ? [...DEFAULT_ADMIN_EMAILS] : Array.from(new Set(emails))));

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().default(API_ENV_NUMBER_4000),
  API_HOST: z.string().default("0.0.0.0"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),
  CALENDAR_WEBHOOK_BASE_URL: z.string().url().optional().or(z.literal("")).default(""),
  NEXT_PUBLIC_WEB_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().url(),
  AUTH_JWT_SECRET: z.string().min(API_ENV_NUMBER_16),
  ADMIN_EMAIL: adminEmailsSchema,
  LIVEKIT_URL: z.string().url().or(z.string().startsWith("wss://")),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_WEBHOOK_SECRET: z.string().min(1),
  LIVEKIT_DIAL_IN_NUMBER: z.string().trim().optional().or(z.literal("")).default(""),
  LIVEKIT_CALL_IN_HOLD_AUDIO_URL: z.string().trim().optional().or(z.literal("")).default(""),
  ASSISTANT_SERVICE_URL: z.string().url(),
  ASSISTANT_SERVICE_SECRET: z.string().min(1),
  ASSISTANT_SERVICE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_12000),
  // Transcript stop drains participant tracks and flushes final callbacks;
  // it needs a larger budget than ordinary assistant control requests.
  ASSISTANT_SERVICE_TRANSCRIPTION_STOP_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_70000),
  ASSISTANT_SERVICE_SUMMARY_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_60000),
  // Snapshot model calls can run for up to four minutes. Keep transport
  // teardown comfortably outside that semantic timeout.
  ASSISTANT_SERVICE_SNAPSHOT_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_300000),
  ASSISTANT_SERVICE_TITLE_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_12000),
  // The global verification pass scales its model timeout with transcript
  // size up to 240s, so the HTTP timeout must sit above that, like snapshots.
  ASSISTANT_SERVICE_TASKS_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_260000),
  ASSISTANT_SERVICE_EXTRACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_195000),
  ASSISTANT_SERVICE_SELECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_120000),
  ASSISTANT_SERVICE_WORKFLOW_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_75000),
  AUTH_EXCHANGE_SECRET: z.string().min(API_ENV_NUMBER_16).default("dev_auth_exchange_secret_change_me"),
  MEMORY_ENABLED: envBoolean.default(true),
  GUEST_RECOGNITION_ENABLED: envBoolean.default(false),
  GUEST_RECOGNITION_PROXY_SECRET: z.string().min(API_ENV_NUMBER_32).optional(),
  OAUTH_TOKEN_ENCRYPTION_KEY: z.string().min(API_ENV_NUMBER_16).default("dev_oauth_token_encryption_key_change_me"),
  ADMIN_FIXED_INFRA_MONTHLY_USD: z.coerce.number().nonnegative().default(0),
  ADMIN_TRANSCRIPTION_AUDIO_MINUTE_USD: z.coerce.number().nonnegative().default(0),
  ADMIN_LIVEKIT_INCLUDED_PARTICIPANT_MINUTES: z.coerce.number().nonnegative().default(API_ENV_NUMBER_150000),
  ADMIN_LIVEKIT_PARTICIPANT_MINUTE_USD: z.coerce.number().nonnegative().default(API_ENV_NUMBER_0_0005),
  LINEAR_CLIENT_ID: z.string().optional().or(z.literal("")),
  LINEAR_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  LINEAR_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:4000/v1/integrations/linear/callback")
    .or(z.literal("")),
  SLACK_CLIENT_ID: z.string().optional().or(z.literal("")),
  SLACK_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  SLACK_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:4000/v1/integrations/slack/callback")
    .or(z.literal("")),
  OPENAI_SLACK_CLASSIFIER_MODEL: z.string().trim().min(1).default("gpt-5.4-mini"),
  OPENAI_SLACK_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_20000),
  GOOGLE_CALENDAR_CLIENT_ID: z.string().optional().or(z.literal("")),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  // Comma-separated OAuth client ids accepted as `aud` on Google Workspace
  // add-on identity tokens. Empty disables /auth/google-addon-login.
  GOOGLE_ADDON_OAUTH_AUDIENCES: z.string().optional().or(z.literal("")).default(""),
  GOOGLE_CALENDAR_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:4000/v1/integrations/calendar/google_calendar/callback")
    .or(z.literal("")),
  OUTLOOK_CALENDAR_CLIENT_ID: z.string().optional().or(z.literal("")),
  OUTLOOK_CALENDAR_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  OUTLOOK_CALENDAR_REDIRECT_URI: z
    .string()
    .url()
    .default("http://localhost:4000/v1/integrations/calendar/outlook_calendar/callback")
    .or(z.literal("")),
  MAIL_OBJECT_STORAGE_ENDPOINT: z.string().url().optional().or(z.literal("")).default(""),
  MAIL_OBJECT_STORAGE_BUCKET: z.string().optional().or(z.literal("")).default(""),
  MAIL_OBJECT_STORAGE_REGION: z.string().trim().min(1).default("auto"),
  MAIL_OBJECT_STORAGE_ACCESS_KEY_ID: z.string().optional().or(z.literal("")).default(""),
  MAIL_OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().optional().or(z.literal("")).default(""),
  STRIPE_SECRET_KEY: z.string().optional().or(z.literal("")).default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().or(z.literal("")).default(""),
  RESEND_API_KEY: z.string().optional().or(z.literal("")).default(""),
  RESEND_FROM_EMAIL: z.string().trim().min(API_ENV_NUMBER_3).default("Ready <invitations@ready.app>"),
  WORKSPACE_INVITE_EXPIRY_DAYS: z.coerce.number().int().positive().default(API_ENV_NUMBER_14),
  WORKSPACE_MAX_PER_USER: z.coerce.number().int().positive().default(API_ENV_NUMBER_20),
  STRIPE_PRICE_BUSINESS_MONTHLY: z.string().optional().or(z.literal("")).default(""),
  STRIPE_PRICE_BUSINESS_YEARLY: z.string().optional().or(z.literal("")).default(""),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional().or(z.literal("")).default(""),
  STRIPE_PRICE_PRO_YEARLY: z.string().optional().or(z.literal("")).default(""),
  STRIPE_PRICE_MAX_MONTHLY: z.string().optional().or(z.literal("")).default(""),
  STRIPE_PRICE_MAX_YEARLY: z.string().optional().or(z.literal("")).default(""),
  STRIPE_PRICE_CREDIT_TOPUP: z.string().optional().or(z.literal("")).default(""),
  BILLING_MONTHLY_PLAN_INCLUDED_CREDITS: z.coerce.number().int().positive().default(API_ENV_NUMBER_250),
  BILLING_TOPUP_MIN_CREDITS: z.coerce.number().int().positive().default(API_ENV_NUMBER_100),
  BILLING_TOPUP_MAX_CREDITS: z.coerce.number().int().positive().default(API_ENV_NUMBER_10000),
  ASHBY_POST_MEETING_REVIEW_ENABLED: envBoolean.default(false),
  ASHBY_REVIEW_MODEL: z.string().trim().min(1).default("gpt-5.4-mini"),
  ASHBY_REVIEW_JEV_MODEL: z.string().trim().min(1).default("jev-latest"),
  MEETING_TRACKER_ENABLED: envBoolean.default(false),
  MEETING_TRACKER_MODEL: z.string().trim().min(1).default("gpt-6-luna"),
  AI_GATEWAY_API_KEY: z.string().default(""),
  OPENAI_API_KEY: z.string().optional().or(z.literal("")).default(""),
  OPENAI_INPUT_TOKEN_COUNT_BILLING: z.enum(["unverified", "free"]).default("unverified"),
  OPENAI_MEETING_BRIEF_MODEL: z.string().trim().min(1).default("gpt-5.4-mini"),
  OPENAI_MEETING_BRIEF_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_30000),
  AMBIENT_CONTEXT_ENABLED: envBoolean.default(true),
  TYPESAFE_API_KEY: z.string().trim().default(""),
  OPENAI_AMBIENT_CONTEXT_MODEL: z.string().trim().min(1).default("gpt-5.4-nano"),
  OPENAI_AMBIENT_RESEARCH_MODEL: z.string().trim().min(1).default("gpt-5.4-mini"),
  OPENAI_VOICE_WEB_RESEARCH_MODEL: z.string().trim().min(1).default("gpt-5.6-luna"),
  OPENAI_AMBIENT_CONTEXT_TIMEOUT_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_20000),
  OPENAI_MODEL_PRICES_JSON: openAIModelPricesEnvSchema,
  // Must match the assistant's setting: the notes lock prices the smallest run of this model.
  OPENAI_MEETING_SNAPSHOT_MODEL: z.string().trim().min(1).default(DEFAULT_OPENAI_MEETING_SNAPSHOT_MODEL),
  PARALLEL_API_KEY: z.string().optional().or(z.literal("")).default(""),
  PARALLEL_MEETING_PREP_PROCESSOR: z.string().trim().min(1).default("core"),
  PARALLEL_MEETING_PREP_PEOPLE_PROCESSOR: z.string().trim().min(1).default("core"),
  PARALLEL_MEETING_PREP_COMPANY_PROCESSOR: z.string().trim().min(1).default("pro"),
  PARALLEL_MEETING_PREP_INTERACTIVE_PEOPLE_PROCESSOR: z.string().trim().min(1).default("core-fast"),
  PARALLEL_MEETING_PREP_INTERACTIVE_COMPANY_PROCESSOR: z.string().trim().min(1).default("pro-fast"),
  PARALLEL_MEETING_PREP_STALE_PENDING_MS: z.coerce.number().int().positive().default(API_ENV_NUMBER_120000),
  ABLY_API_KEY: z.string().optional().or(z.literal("")).default(""),
  ABLY_CLIENT_TTL_MS: z.coerce.number().int().positive().max(API_ENV_NUMBER_86400000).default(API_ENV_NUMBER_600000),
  SENTRY_DSN: z.string().url().optional().or(z.literal("")).default(""),
  SENTRY_ENVIRONMENT: z.string().trim().optional().or(z.literal("")).default(""),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
