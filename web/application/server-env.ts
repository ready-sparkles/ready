import { z } from "zod";

const AUTH_SECRET_MIN_LENGTH = 16;
const AUTH_SECRET_PRODUCTION_REQUIRED_MESSAGE = "AUTH_SECRET must be set in production";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTH_SECRET: z.string().min(AUTH_SECRET_MIN_LENGTH).optional(),
  AUTH_TRUST_HOST: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z.string().url().optional(),
  DEV_LOGIN_EMAIL: z.string().email().optional(),
  DEV_LOGIN_DISPLAY_NAME: z.string().optional(),
  INTERNAL_API_BASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:4000"),
  AUTH_EXCHANGE_SECRET: z.string().min(AUTH_SECRET_MIN_LENGTH).default("dev_auth_exchange_secret_change_me"),
});

const parsed = serverEnvSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST,
  AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
  AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
  AUTH_MICROSOFT_ENTRA_ID_ID: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
  AUTH_MICROSOFT_ENTRA_ID_SECRET: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
  DEV_LOGIN_EMAIL: process.env.DEV_LOGIN_EMAIL,
  DEV_LOGIN_DISPLAY_NAME: process.env.DEV_LOGIN_DISPLAY_NAME,
  INTERNAL_API_BASE_URL: process.env.INTERNAL_API_BASE_URL,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  AUTH_EXCHANGE_SECRET: process.env.AUTH_EXCHANGE_SECRET,
});

const resolvedAuthSecret =
  parsed.AUTH_SECRET ??
  (parsed.NODE_ENV === "production" ? undefined : "readymeet_dev_auth_secret_change_me_1234567890");

if (resolvedAuthSecret === undefined) {
  throw new Error(AUTH_SECRET_PRODUCTION_REQUIRED_MESSAGE);
}

export const serverEnv = {
  ...parsed,
  AUTH_SECRET: resolvedAuthSecret,
  /** @external NextAuth AUTH_TRUST_HOST env contract */
  AUTH_TRUST_HOST: parsed.AUTH_TRUST_HOST ?? true,
  INTERNAL_API_BASE_URL: parsed.INTERNAL_API_BASE_URL ?? parsed.NEXT_PUBLIC_API_BASE_URL,
};
