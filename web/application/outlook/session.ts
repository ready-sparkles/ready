import { z } from "zod";

const SIGN_IN_FAILURE_MESSAGE = "Could not start sign-in. Please try again.";
const CSRF_PATH = "/api/auth/csrf";
const SIGN_OUT_PATH = "/api/auth/signout";

const jsonObjectSchema = z.object({}).passthrough();
const csrfTokenSchema = z.object({ csrfToken: z.string().min(1) }).passthrough();

type JsonObject = z.infer<typeof jsonObjectSchema>;

const isCsrfResponse = (value: JsonObject): boolean => csrfTokenSchema.safeParse(value).success;

export const readResponseJson = async ({
  response,
  fallback,
  isValid = () => true,
}: {
  response: Response;
  fallback: string;
  isValid?: (value: JsonObject) => boolean;
}): Promise<JsonObject> => {
  const payload = await (async (): Promise<JsonObject | null> => {
    try {
      return jsonObjectSchema.parse(await response.json());
    } catch (error) {
      if (error instanceof Error) {
        return null;
      }

      return null;
    }
  })();
  if (!response.ok || payload === null || !isValid(payload)) {
    throw new Error(fallback);
  }

  return payload;
};

export const signInAgainWithFetcher = async ({
  callbackUrl,
  fetcher,
}: {
  callbackUrl: string;
  fetcher: typeof fetch;
}): Promise<string> => {
  const csrf = csrfTokenSchema.parse(
    await readResponseJson({
      response: await fetcher(CSRF_PATH, { cache: "no-store" }),
      fallback: SIGN_IN_FAILURE_MESSAGE,
      isValid: isCsrfResponse,
    }),
  );
  const loginUrl = `/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
  await readResponseJson({
    response: await fetcher(SIGN_OUT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: loginUrl }),
    }),
    fallback: SIGN_IN_FAILURE_MESSAGE,
  });

  return loginUrl;
};
