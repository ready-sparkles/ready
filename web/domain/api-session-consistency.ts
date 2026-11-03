import { z } from "zod";

const API_TOKEN_PAYLOAD_SCHEMA = z.object({
  sub: z.unknown().optional(),
});

function parseApiTokenPayload(apiToken: unknown): z.infer<typeof API_TOKEN_PAYLOAD_SCHEMA> | null {
  if (typeof apiToken !== "string") {
    return null;
  }
  const encodedPayload = apiToken.split(".")[1];
  if (encodedPayload === undefined || encodedPayload === "") {
    return null;
  }

  try {
    const raw: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const parsed = API_TOKEN_PAYLOAD_SCHEMA.safeParse(raw);

    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }

    throw error;
  }
}

export function apiTokenMatchesUser(input: { apiToken: unknown; userId: string | null | undefined }): boolean {
  if (input.userId === null || input.userId === undefined || input.userId === "") {
    return false;
  }

  return parseApiTokenPayload(input.apiToken)?.sub === input.userId;
}
