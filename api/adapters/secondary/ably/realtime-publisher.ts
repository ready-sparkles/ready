import type { RealtimeEvent } from "@readymeet/db/ports/realtime";
import { isLegacyJoinRequestRealtimeChannel } from "@readymeet/shared";
import { z } from "zod";

import { apiEnv } from "../../../ports/api-env";

import Ably from "./sdk";

const ABLY_CAPABILITY_ERROR_CODE = 40160;
const HTTP_UNAUTHORIZED = 401;

const capabilityErrorSchema = z.object({
  code: z.unknown().optional(),
  statusCode: z.unknown().optional(),
  message: z.string().optional(),
});

export function isLegacyJoinRequestCapabilityError(error: unknown): boolean {
  const parsed = capabilityErrorSchema.safeParse(error);

  return (
    parsed.success &&
    (parsed.data.code === ABLY_CAPABILITY_ERROR_CODE ||
      (parsed.data.statusCode === HTTP_UNAUTHORIZED &&
        /not permitted|unauthori[sz]ed|capabilit/i.test(parsed.data.message ?? "")))
  );
}

/** Client cursor recovery remains available when realtime is not configured. */
export async function publishRealtimeEvent(event: RealtimeEvent): Promise<void> {
  if (apiEnv().ABLY_API_KEY === "") {
    return;
  }
  const rest = new Ably.Rest({ key: apiEnv().ABLY_API_KEY });
  try {
    await rest.channels.get(event.channel).publish(event.eventName, event.payload);
  } catch (error) {
    if (isLegacyJoinRequestRealtimeChannel(event.channel) && isLegacyJoinRequestCapabilityError(error)) {
      return;
    }
    throw error;
  }
}
