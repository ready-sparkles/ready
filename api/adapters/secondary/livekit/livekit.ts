import { z } from "zod";

import { apiEnv } from "../../../ports/api-env";

import type { IngressInfo, ParticipantInfo, TrackSource, WebhookEvent } from "./sdk";
import { AccessToken, IngressClient, IngressInput, RoomServiceClient, TwirpError, WebhookReceiver } from "./sdk";

const SIP_DISPATCH_DELETE_TIMEOUT_MS = 30_000;
const HTTP_NOT_FOUND_STATUS = 404;
const HTTP_CONFLICT_STATUS = 409;
const MESSAGE_MISSING_AUTHORIZATION_HEADER = "Missing authorization header";

const liveKitSipErrorPayloadSchema = z.object({
  code: z.string().optional(),
});

const sipDispatchRuleResponseSchema = z.object({
  sip_dispatch_rule_id: z.string().optional(),
  sipDispatchRuleId: z.string().optional(),
});

type SipDispatchRuleResponse = z.infer<typeof sipDispatchRuleResponseSchema>;

function toServiceHost(livekitUrl: string) {
  return livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

export async function createLiveKitToken(input: {
  roomName: string;
  participantIdentity: string;
  participantName: string;
  participantUserId: string;
  participantAvatarUrl?: string | null;
  participantMetadata?: Record<string, unknown>;
  canPublishSources?: TrackSource[];
  canPublishData?: boolean;
}): Promise<string> {
  const token = new AccessToken(apiEnv().LIVEKIT_API_KEY, apiEnv().LIVEKIT_API_SECRET, {
    identity: input.participantIdentity,
    name: input.participantName,
    metadata: JSON.stringify({
      userId: input.participantUserId,
      avatarUrl: input.participantAvatarUrl ?? null,
      ...(input.participantMetadata ?? {}),
    }),
    attributes: {
      userId: input.participantUserId,
      avatarUrl: input.participantAvatarUrl ?? "",
      ...Object.fromEntries(
        Object.entries(input.participantMetadata ?? {}).map(([key, value]) => [key, String(value)]),
      ),
    },
    ttl: "2h",
  });

  token.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: true,
    canPublishData: input.canPublishData ?? true,
    canPublishSources: input.canPublishSources,
    canSubscribe: true,
    // Cached signed-in clients still publish presentation intent as attributes.
    // Authorization uses their immutable connection identity, never these fields.
    // Guests depend on server-stamped metadata and must remain read-only.
    canUpdateOwnMetadata: input.participantIdentity.split(":", 1)[0] === input.participantUserId,
  });

  return token.toJwt();
}

async function createLiveKitSipAdminToken() {
  const token = new AccessToken(apiEnv().LIVEKIT_API_KEY, apiEnv().LIVEKIT_API_SECRET, {
    identity: "ready-api-sip-admin",
    ttl: "10m",
  });

  token.addSIPGrant({
    admin: true,
    call: true,
  });

  return token.toJwt();
}

class LiveKitSipError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(...args: [method: string, status: number, code: string | undefined, detail: string]) {
    const [method, status, code, detail] = args;
    super(`LiveKit SIP ${method} failed (${status}): ${detail}`);
    this.name = "LiveKitSipError";
    this.status = status;
    this.code = code;
  }
}

function parseSipDispatchRuleResponseText(input: { text: string }): SipDispatchRuleResponse {
  if (input.text.length === 0) {
    return {};
  }

  const jsonPayload: unknown = JSON.parse(input.text);
  const parsed = sipDispatchRuleResponseSchema.safeParse(jsonPayload);

  return parsed.success ? parsed.data : {};
}

async function liveKitSipRequest(input: {
  method: string;
  body: Record<string, unknown>;
}): Promise<SipDispatchRuleResponse> {
  const token = await createLiveKitSipAdminToken();
  const response = await fetch(`${toServiceHost(apiEnv().LIVEKIT_URL)}/twirp/livekit.SIP/${input.method}`, {
    method: "POST",
    // Creation is not idempotent: aborting after provider commit would lose
    // the rule ID. Only bound deletion, which can safely be retried.
    ...(input.method === "DeleteSIPDispatchRule"
      ? { signal: AbortSignal.timeout(SIP_DISPATCH_DELETE_TIMEOUT_MS) }
      : {}),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new LiveKitSipError(input.method, response.status, readLiveKitSipErrorCode({ text }), text);
  }

  return parseSipDispatchRuleResponseText({ text });
}

function readLiveKitSipErrorCode(input: { text: string }): string | undefined {
  try {
    const jsonPayload: unknown = JSON.parse(input.text);
    const parsed = liveKitSipErrorPayloadSchema.safeParse(jsonPayload);
    if (!parsed.success) {
      return undefined;
    }

    return parsed.data.code;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }

    return undefined;
  }
}

export function getSipDispatchRuleId(rule: SipDispatchRuleResponse): string | null {
  return rule.sip_dispatch_rule_id ?? rule.sipDispatchRuleId ?? null;
}

// Callers are dispatched into per-call holding rooms (the PIN still selects
// the meeting link); admission into the real meeting room is host-gated.
export async function createCallInHoldingSipDispatchRule(input: {
  phoneNumber: string;
  holdingRoomPrefix: string;
  pin: string;
  name: string;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, string>;
}): Promise<SipDispatchRuleResponse> {
  return liveKitSipRequest({
    method: "CreateSIPDispatchRule",
    body: {
      dispatch_rule: {
        rule: {
          dispatch_rule_individual: {
            room_prefix: input.holdingRoomPrefix,
            pin: input.pin,
          },
        },
        name: input.name,
        metadata: input.metadata ? JSON.stringify(input.metadata) : "",
        attributes: input.attributes ?? {},
        numbers: [input.phoneNumber],
      },
    },
  });
}

export async function deleteSipDispatchRule(sipDispatchRuleId: string): Promise<SipDispatchRuleResponse | null> {
  try {
    return await liveKitSipRequest({
      method: "DeleteSIPDispatchRule",
      body: {
        sip_dispatch_rule_id: sipDispatchRuleId,
      },
    });
  } catch (error) {
    // An already-deleted rule is the desired state. Other 404s, auth failures,
    // and network failures must still prevent unsafe replacement/cleanup.
    if (error instanceof LiveKitSipError && error.status === HTTP_NOT_FOUND_STATUS && error.code === "not_found") {
      return null;
    }
    throw error;
  }
}

const webhookReceiverState: { receiver?: WebhookReceiver } = {};

function getWebhookReceiver(): WebhookReceiver {
  return (webhookReceiverState.receiver ??= new WebhookReceiver(
    apiEnv().LIVEKIT_API_KEY,
    apiEnv().LIVEKIT_WEBHOOK_SECRET,
  ));
}

export async function parseLiveKitWebhook(
  ...args: [body: string, authHeader: string | undefined]
): Promise<WebhookEvent> {
  const [body, authHeader] = args;
  if (authHeader === undefined || authHeader === "") {
    throw new Error(MESSAGE_MISSING_AUTHORIZATION_HEADER);
  }

  return getWebhookReceiver().receive(body, authHeader);
}

export async function deleteLiveKitRoom(roomName: string): Promise<boolean> {
  const roomServiceClient = new RoomServiceClient(
    toServiceHost(apiEnv().LIVEKIT_URL),
    apiEnv().LIVEKIT_API_KEY,
    apiEnv().LIVEKIT_API_SECRET,
  );

  try {
    await roomServiceClient.deleteRoom(roomName);

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/not\s*found|does\s*not\s*exist|404/i.test(message)) {
      return false;
    }
    throw error;
  }
}

export async function removeLiveKitParticipant(
  ...args: [roomName: string, participantIdentity: string]
): Promise<boolean> {
  const [roomName, participantIdentity] = args;
  const roomServiceClient = new RoomServiceClient(
    toServiceHost(apiEnv().LIVEKIT_URL),
    apiEnv().LIVEKIT_API_KEY,
    apiEnv().LIVEKIT_API_SECRET,
  );

  try {
    await roomServiceClient.removeParticipant(roomName, participantIdentity);

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/not\s*found|does\s*not\s*exist|404/i.test(message)) {
      return false;
    }
    throw error;
  }
}

export async function moveLiveKitParticipant(
  ...args: [roomName: string, participantIdentity: string, destinationRoomName: string]
): Promise<void> {
  const [roomName, participantIdentity, destinationRoomName] = args;
  const roomServiceClient = new RoomServiceClient(
    toServiceHost(apiEnv().LIVEKIT_URL),
    apiEnv().LIVEKIT_API_KEY,
    apiEnv().LIVEKIT_API_SECRET,
  );

  await roomServiceClient.moveParticipant(roomName, participantIdentity, destinationRoomName);
}

export async function updateLiveKitParticipantInfo(input: {
  roomName: string;
  participantIdentity: string;
  name?: string;
  attributes?: Record<string, string>;
}): Promise<void> {
  const roomServiceClient = new RoomServiceClient(
    toServiceHost(apiEnv().LIVEKIT_URL),
    apiEnv().LIVEKIT_API_KEY,
    apiEnv().LIVEKIT_API_SECRET,
  );

  await roomServiceClient.updateParticipant(input.roomName, input.participantIdentity, {
    name: input.name,
    attributes: input.attributes,
  });
}

function createIngressClient() {
  return new IngressClient(toServiceHost(apiEnv().LIVEKIT_URL), apiEnv().LIVEKIT_API_KEY, apiEnv().LIVEKIT_API_SECRET);
}

export async function startRoomAudioPlayback(input: {
  roomName: string;
  audioUrl: string;
  participantIdentity: string;
  participantName: string;
}): Promise<IngressInfo> {
  return createIngressClient().createIngress(IngressInput.URL_INPUT, {
    name: `hold-audio-${input.roomName}`,
    roomName: input.roomName,
    participantIdentity: input.participantIdentity,
    participantName: input.participantName,
    url: input.audioUrl,
  });
}

export async function stopRoomAudioPlayback(roomName: string): Promise<void> {
  const ingressClient = createIngressClient();
  const ingresses = await ingressClient.listIngress({ roomName });
  await Promise.all(
    ingresses
      .filter((ingress) => Boolean(ingress.ingressId))
      .map(async (ingress) => {
        try {
          await ingressClient.deleteIngress(ingress.ingressId);
        } catch (error) {
          if (error instanceof Error) {
            return;
          }
        }
      }),
  );
}

export async function listLiveKitRoomNames(): Promise<Set<string>> {
  const roomServiceClient = new RoomServiceClient(
    toServiceHost(apiEnv().LIVEKIT_URL),
    apiEnv().LIVEKIT_API_KEY,
    apiEnv().LIVEKIT_API_SECRET,
  );

  const rooms = await roomServiceClient.listRooms();

  return new Set(rooms.map((room) => room.name).filter((name): name is string => Boolean(name)));
}

function isAbsentRoomError(error: unknown): boolean {
  return error instanceof TwirpError && error.code === "not_found";
}

/** LiveKit reports the terminal-close race as a 409 `aborted`, a code it also uses for other aborted work. */
function isAbortedConflictError(error: unknown): boolean {
  return error instanceof TwirpError && error.code === "aborted" && error.status === HTTP_CONFLICT_STATUS;
}

/** Rejects when LiveKit cannot report room state, so an unreadable room never counts as empty. */
async function isRoomGone(input: { client: RoomServiceClient; roomName: string }): Promise<boolean> {
  const rooms = await input.client.listRooms([input.roomName]);

  return !rooms.some((room) => room.name === input.roomName);
}

export async function listLiveKitParticipants(roomName: string): Promise<ParticipantInfo[]> {
  const client = new RoomServiceClient(
    toServiceHost(apiEnv().LIVEKIT_URL),
    apiEnv().LIVEKIT_API_KEY,
    apiEnv().LIVEKIT_API_SECRET,
  );
  try {
    return await client.listParticipants(roomName);
  } catch (error) {
    // An absent room has no connections. A 409 `aborted` is the terminal-close race only when
    // LiveKit confirms that the room is gone; any other failure (auth, network, service, or an
    // aborted call on a live room, or a failed room-state lookup) propagates so callers cannot mistake it for an empty roster.
    if (isAbsentRoomError(error) || (isAbortedConflictError(error) && (await isRoomGone({ client, roomName })))) {
      return [];
    }
    throw error;
  }
}
