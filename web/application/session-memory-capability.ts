import { type User, userSchema } from "@readymeet/shared";
import { z } from "zod";

const SESSION_MEMORY_CAPABILITY_TIMEOUT_MS = 3_000;

const authMePayloadSchema = z.object({
  user: userSchema,
});

// Upgrade older cookies before returning the session to the browser. Failure
// keeps sign-in intact; the sidebar can still use its normal status request.
export async function withSessionMemoryCapability(params: {
  user: User;
  apiToken: string;
  apiBaseUrl: string;
}): Promise<User> {
  const { user, apiToken, apiBaseUrl } = params;
  if (user.memoryAvailable !== undefined || user.source === "guest") {
    return user;
  }
  try {
    const response = await fetch(`${apiBaseUrl}/v1/auth/me`, {
      headers: { authorization: `Bearer ${apiToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(SESSION_MEMORY_CAPABILITY_TIMEOUT_MS),
    });
    if (!response.ok) {
      return user;
    }
    const payloadResult = authMePayloadSchema.safeParse(await response.json());
    if (!payloadResult.success) {
      return user;
    }
    const current = payloadResult.data.user;
    if (current.id !== user.id || current.memoryAvailable === undefined) {
      return user;
    }

    return {
      ...user,
      // @external memoryAvailable
      memoryAvailable: current.memoryAvailable,
    };
  } catch (error) {
    if (error instanceof Error) {
      return user;
    }
    throw error;
  }
}
