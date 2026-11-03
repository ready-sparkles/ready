import { type Participant, type Room, RoomEvent } from "livekit-client";

import {
  PRESENTATION_CLAIM_TOPIC,
  presentationClaimWireSchema,
  type PresentationClaimWireSchemaValue,
  type SchemaSafeParseResult,
} from "../../domain/schemas/presentation-claim-sync";

export { PRESENTATION_CLAIM_TOPIC } from "../../domain/schemas/presentation-claim-sync";
export const PRESENTATION_CLAIM_TTL_MS = 10_000;
const PRESENTATION_CLAIM_FUTURE_SKEW_MS = 5_000;
export type PresentationClaim = {
  participantIdentity: string;
  participantName?: string;
  requestedAt: number;
};
export type PresentationClaimPayload =
  | { type: typeof PRESENTATION_CLAIM_TOPIC; state: "starting"; requestedAt: number }
  | { type: typeof PRESENTATION_CLAIM_TOPIC; state: "clear" | "sync-request" };

async function ignorePresentationClaimFailure(error: unknown) {
  void error;
}

export function isPlausiblePresentationClaimTimestamp(input: { requestedAt: number; now?: number }): boolean {
  const now = input.now ?? Date.now();

  return (
    Number.isFinite(input.requestedAt) &&
    input.requestedAt >= now - PRESENTATION_CLAIM_TTL_MS &&
    input.requestedAt <= now + PRESENTATION_CLAIM_FUTURE_SKEW_MS
  );
}

export async function publishPresentationClaim(input: {
  room: Room;
  payload: PresentationClaimPayload;
  destinationIdentities?: string[];
}): Promise<unknown> {
  return input.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(input.payload)), {
    reliable: true,
    topic: PRESENTATION_CLAIM_TOPIC,
    destinationIdentities: input.destinationIdentities,
  });
}

export async function requestPresentationClaimSync(input: { room: Room }): Promise<unknown> {
  return publishPresentationClaim({
    room: input.room,
    payload: { type: PRESENTATION_CLAIM_TOPIC, state: "sync-request" },
  });
}

/**
 * Reliable packets are not retained for late/reconnecting participants.
 * Ask each sender for its own current claim; never trust a relayed identity.
 * https://docs.livekit.io/transport/data/packets/
 */
export function attachPresentationClaimSync(input: {
  room: Room;
  options: {
    getLocalClaim: () => PresentationClaim | null;
    onRemoteClaim: (claimInput: { identity: string; claim: PresentationClaim | null }) => void;
  };
}): () => void {
  const { room, options } = input;

  async function publishLocal(publishInput?: { destinationIdentities?: string[] }) {
    const claim = options.getLocalClaim();
    const isLocalClaimActive =
      claim !== null &&
      claim.participantIdentity === room.localParticipant.identity &&
      isPlausiblePresentationClaimTimestamp({ requestedAt: claim.requestedAt });

    return publishPresentationClaim({
      room,
      payload: isLocalClaimActive
        ? { type: PRESENTATION_CLAIM_TOPIC, state: "starting", requestedAt: claim.requestedAt }
        : { type: PRESENTATION_CLAIM_TOPIC, state: "clear" },
      destinationIdentities: publishInput?.destinationIdentities,
    });
  }

  const synchronize = () => {
    void (async () => {
      try {
        await Promise.all([publishLocal(), requestPresentationClaimSync({ room })]);
      } catch (error) {
        await ignorePresentationClaimFailure(error);
      }
    })();
  };

  const joined = (participant: Participant) => {
    void (async () => {
      try {
        await publishLocal({ destinationIdentities: [participant.identity] });
      } catch (error) {
        await ignorePresentationClaimFailure(error);
      }
    })();
  };

  const receive = (bytes: Uint8Array, participant?: Participant, _kind?: unknown, topic?: string) => {
    if (
      topic !== PRESENTATION_CLAIM_TOPIC ||
      participant === undefined ||
      !room.remoteParticipants.has(participant.identity)
    ) {
      return;
    }
    const parsedPayload = ((): SchemaSafeParseResult<PresentationClaimWireSchemaValue> | null => {
      try {
        return presentationClaimWireSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      } catch (error) {
        void error;

        return null;
      }
    })();
    if (parsedPayload === null || !parsedPayload.success) {
      return;
    }
    const payload = parsedPayload.data;
    if (payload.state === "sync-request" && payload.requestedAt === undefined) {
      void (async () => {
        try {
          await publishLocal({ destinationIdentities: [participant.identity] });
        } catch (error) {
          await ignorePresentationClaimFailure(error);
        }
      })();
    } else if (payload.state === "clear" && payload.requestedAt === undefined) {
      options.onRemoteClaim({ identity: participant.identity, claim: null });
    } else if (
      payload.state === "starting" &&
      typeof payload.requestedAt === "number" &&
      isPlausiblePresentationClaimTimestamp({ requestedAt: payload.requestedAt })
    ) {
      const participantName =
        participant.name !== undefined && participant.name.length > 0 ? participant.name : participant.identity;
      options.onRemoteClaim({
        identity: participant.identity,
        claim: {
          participantIdentity: participant.identity,
          participantName,
          requestedAt: payload.requestedAt,
        },
      });
    }
  };
  room.on(RoomEvent.DataReceived, receive);
  room.on(RoomEvent.ParticipantConnected, joined);
  room.on(RoomEvent.Connected, synchronize);
  room.on(RoomEvent.Reconnected, synchronize);
  // This is attached after the join promise resolves, so request initial state.
  synchronize();

  return () => {
    room.off(RoomEvent.DataReceived, receive);
    room.off(RoomEvent.ParticipantConnected, joined);
    room.off(RoomEvent.Connected, synchronize);
    room.off(RoomEvent.Reconnected, synchronize);
  };
}
