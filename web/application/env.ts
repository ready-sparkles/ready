import { z } from "zod";

function parseBooleanFlag(input: { value: string | undefined; isEnabledByDefault: boolean }) {
  if (input.value === undefined) {
    return input.isEnabledByDefault;
  }

  const value = input.value;

  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return input.isEnabledByDefault;
}

const webEnvSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.string().url().default("http://localhost:4000"),
  NEXT_PUBLIC_DEBUG_NEW_EXTRACTION: z.boolean(),
  NEXT_PUBLIC_DEBUG_SELECTION: z.boolean(),
  NEXT_PUBLIC_AMBIENT_CONTEXT_ENABLED: z.boolean(),
});

export const webEnv = webEnvSchema.parse({
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  /** @external existing public env contract */
  NEXT_PUBLIC_DEBUG_NEW_EXTRACTION: parseBooleanFlag({
    value: process.env.NEXT_PUBLIC_DEBUG_NEW_EXTRACTION,
    isEnabledByDefault: process.env.NODE_ENV !== "production",
  }),
  /** @external existing public env contract */
  NEXT_PUBLIC_DEBUG_SELECTION: parseBooleanFlag({
    value: process.env.NEXT_PUBLIC_DEBUG_SELECTION,
    isEnabledByDefault: process.env.NODE_ENV !== "production",
  }),
  /** @external existing public env contract */
  NEXT_PUBLIC_AMBIENT_CONTEXT_ENABLED: parseBooleanFlag({
    value: process.env.NEXT_PUBLIC_AMBIENT_CONTEXT_ENABLED,
    isEnabledByDefault: true,
  }),
});
