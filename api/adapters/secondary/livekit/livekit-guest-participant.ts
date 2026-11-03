import type { RepositoryPort } from "@readymeet/db/ports/repository";
import { z } from "zod";

import { repositories } from "../../../ports/repository-runtime";

const joinRequestIdSchema = z.string().uuid();
type JoinRequest = Pick<
  NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingJoinRequestById"]>>>,
  "meetingId" | "userId" | "status"
>;

export async function resolveLiveKitGuestUserId(input: {
  meetingId: string;
  identity: string;
  isLeaving: boolean;
  getJoinRequest?: (id: string) => Promise<JoinRequest | null>;
}): Promise<string | null> {
  const getJoinRequest = input.getJoinRequest ?? repositories().getMeetingJoinRequestById;
  if (!input.identity.startsWith("guest:")) {
    return null;
  }
  const parsed = joinRequestIdSchema.safeParse(input.identity.slice("guest:".length));
  if (!parsed.success) {
    return null;
  }

  const joinRequest = await getJoinRequest(parsed.data);
  if (!joinRequest || joinRequest.meetingId !== input.meetingId) {
    return null;
  }

  // A host can revoke/deny access before LiveKit delivers the departure event.
  // Those departures still need cleanup, but must never restore presence.
  if (
    joinRequest.status !== "admitted" &&
    !(input.isLeaving && ["denied", "revoked", "expired"].includes(joinRequest.status))
  ) {
    return null;
  }

  return joinRequest.userId;
}
