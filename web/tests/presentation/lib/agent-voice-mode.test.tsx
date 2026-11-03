import { ConnectionState, ParticipantKind, type RemoteParticipant } from "livekit-client";
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  createOwedVoiceStop,
  createVoiceModeIntent,
  getVoiceModeControlState,
  isSoloVoiceAvailable,
  START_CONVERSATION_MODE_RPC,
  STOP_CONVERSATION_MODE_RPC,
} from "../../../presentation/lib/agent-voice-mode";

const TEST_VALUE_2 = 2;
const TEST_VALUE_3 = 3;
const TEST_VALUE_4 = 4;
const ARIA_START_VOICE_MODE = "Voice chat with Ready";
const ARIA_END_VOICE_CONVERSATION = "End voice chat with Ready";
const ARIA_STARTING_VOICE_MODE = "Starting voice chat with Ready";
const ARIA_ENDING_VOICE_CONVERSATION = "Ending voice chat with Ready";
const ARIA_VOICE_IN_USE = "Voice chat with Ready is in use by another participant";
const MESSAGE_CONNECTION_LOST = "connection lost";
const MESSAGE_OFFLINE = "offline";

type SoloVoiceRoom = NonNullable<Parameters<typeof isSoloVoiceAvailable>[0]>;
type OwedVoiceStopRoom = Parameters<typeof createOwedVoiceStop>[0];

function isSoloVoiceRoom(value: unknown): value is SoloVoiceRoom {
  return typeof value === "object" && value !== null && "state" in value && "remoteParticipants" in value;
}

function isFakeRemoteParticipant(value: object): value is RemoteParticipant {
  return "kind" in value && "attributes" in value;
}

function fakeRemoteParticipant(value: object): RemoteParticipant {
  assert.ok(isFakeRemoteParticipant(value));

  return value;
}

function soloVoiceRoom(value: object): SoloVoiceRoom {
  assert.ok(isSoloVoiceRoom(value));

  return value;
}

function isOwedVoiceStopRoom(value: unknown): value is OwedVoiceStopRoom {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "remoteParticipants" in value &&
    "localParticipant" in value
  );
}

function owedVoiceStopRoom(value: object): OwedVoiceStopRoom {
  assert.ok(isOwedVoiceStopRoom(value));

  return value;
}

function voiceControlState(input: {
  action: "start" | "stop" | "none";
  ariaLabel: string;
  /** @external voice mode control wire field */
  disabled: boolean;
  /** @external voice mode control wire field */
  pressed: boolean;
}) {
  return input;
}
void test("voice mode control starts, stops, and rejects takeover by another participant", () => {
  assert.equal(START_CONVERSATION_MODE_RPC, "start_conversation_mode");
  assert.equal(STOP_CONVERSATION_MODE_RPC, "stop_conversation_mode");

  assert.deepEqual(
    getVoiceModeControlState({
      conversationModeActive: false,
      localParticipantIdentity: "personbr",
      ownerParticipantIdentity: null,
      pendingAction: null,
    }),
    voiceControlState({
      action: "start",
      ariaLabel: ARIA_START_VOICE_MODE,
      disabled: false,
      pressed: false,
    }),
  );

  assert.deepEqual(
    getVoiceModeControlState({
      conversationModeActive: true,
      localParticipantIdentity: "personbr",
      ownerParticipantIdentity: "personbr",
      pendingAction: null,
    }),
    voiceControlState({
      action: "stop",
      ariaLabel: ARIA_END_VOICE_CONVERSATION,
      disabled: false,
      pressed: true,
    }),
  );

  assert.deepEqual(
    getVoiceModeControlState({
      conversationModeActive: true,
      localParticipantIdentity: "personbr",
      ownerParticipantIdentity: "personbr",
      pendingAction: "starting",
    }),
    voiceControlState({
      action: "none",
      ariaLabel: ARIA_STARTING_VOICE_MODE,
      disabled: false,
      pressed: true,
    }),
  );

  assert.deepEqual(
    getVoiceModeControlState({
      conversationModeActive: false,
      localParticipantIdentity: "personbr",
      ownerParticipantIdentity: null,
      pendingAction: "stopping",
    }),
    voiceControlState({
      action: "none",
      ariaLabel: ARIA_ENDING_VOICE_CONVERSATION,
      disabled: false,
      pressed: false,
    }),
  );

  assert.deepEqual(
    getVoiceModeControlState({
      conversationModeActive: true,
      localParticipantIdentity: "personbr",
      ownerParticipantIdentity: "personaa",
      pendingAction: null,
    }),
    voiceControlState({
      action: "none",
      ariaLabel: ARIA_VOICE_IN_USE,
      disabled: true,
      pressed: true,
    }),
  );
});

void test("a brief visitor permanently invalidates the old start and stale active presence", () => {
  const intent = createVoiceModeIntent();
  const starting = intent.begin(true);
  assert.equal(intent.canActivate(), true);
  intent.invalidate();
  assert.equal(intent.isCurrent(starting), false);
  assert.equal(intent.canActivate(), false);
  // Returning to a solo roster does not create fresh intent.
  assert.equal(intent.canActivate(), false);
  const restarted = intent.begin(true);
  assert.equal(intent.isCurrent(starting), false);
  assert.equal(intent.isCurrent(restarted), true);
  assert.equal(intent.canActivate(), true);
});

void test("stops and remote shutdowns reject stale active presence", () => {
  const intent = createVoiceModeIntent();
  const starting = intent.begin(true);
  const stopping = intent.begin(false);
  assert.equal(intent.isCurrent(starting), false);
  assert.equal(intent.isCurrent(stopping), true);
  assert.equal(intent.canActivate(), false);
  intent.begin(true);
  intent.deactivate();
  assert.equal(intent.canActivate(), false);
});

void test("the icon returns for a solo connected caller without restarting voice", () => {
  const intent = createVoiceModeIntent();
  const room = soloVoiceRoom({
    state: ConnectionState.Connected,
    remoteParticipants: new Map([["agent", { kind: ParticipantKind.AGENT, attributes: {} }]]),
  });
  assert.equal(isSoloVoiceAvailable(room), true);
  // A caller cannot hide by claiming the assistant role attribute.
  room.remoteParticipants.set(
    "spoofed",
    fakeRemoteParticipant({ kind: ParticipantKind.STANDARD, attributes: { assistantRole: "meeting-agent" } }),
  );
  assert.equal(isSoloVoiceAvailable(room), false);
  room.remoteParticipants.delete("spoofed");
  const start = intent.begin(true);
  room.remoteParticipants.set("guest", fakeRemoteParticipant({ kind: ParticipantKind.STANDARD, attributes: {} }));
  intent.invalidate();
  assert.equal(isSoloVoiceAvailable(room), false);
  room.remoteParticipants.set(
    "second-guest",
    fakeRemoteParticipant({ kind: ParticipantKind.STANDARD, attributes: {} }),
  );
  room.remoteParticipants.delete("guest");
  assert.equal(isSoloVoiceAvailable(room), false);
  room.remoteParticipants.delete("second-guest");
  assert.equal(isSoloVoiceAvailable(room), true);
  assert.equal(intent.canActivate(), false);
  assert.equal(intent.isCurrent(start), false);
  assert.equal(isSoloVoiceAvailable({ ...room, state: ConnectionState.Reconnecting }), false);
  assert.equal(isSoloVoiceAvailable(null), false);
});

void test("owed stops survive missing agents and transient failures until acknowledged", async () => {
  const calls = { count: 0 };
  const participants = new Map();
  const room = owedVoiceStopRoom({
    state: ConnectionState.Connected,
    remoteParticipants: participants,
    localParticipant: {
      performRpc: async () => {
        calls.count += 1;
        if (calls.count === 1) {
          throw new Error(MESSAGE_CONNECTION_LOST);
        }

        return "ignored";
      },
    },
  });
  const stop = createOwedVoiceStop(room, () => true);
  stop.owe();
  assert.equal(await stop.settle(), false);
  assert.equal(stop.hasPending(), true);
  participants.set("agent", { identity: "agent" });
  assert.equal(await stop.settle(), true);
  assert.equal(calls.count, TEST_VALUE_2);
  assert.equal(stop.hasPending(), false);
  await stop.settle();
  assert.equal(calls.count, TEST_VALUE_2);
});

void test("exhausted stop retries stay owed and concurrent settlement sends only one request", async () => {
  const calls = { count: 0 };
  const failure = { isRpcFailing: true };
  const room = owedVoiceStopRoom({
    state: ConnectionState.Connected,
    remoteParticipants: new Map([["agent", { identity: "agent" }]]),
    localParticipant: {
      performRpc: async () => {
        calls.count += 1;
        if (failure.isRpcFailing) {
          throw new Error(MESSAGE_OFFLINE);
        }

        return '{"conversationModeActive":false}';
      },
    },
  });
  const stop = createOwedVoiceStop(room, () => true);
  stop.owe();
  assert.equal(await stop.settle(), false);
  assert.equal(calls.count, TEST_VALUE_3);
  assert.equal(stop.hasPending(), true);
  failure.isRpcFailing = false;
  const first = stop.settle();
  const second = stop.settle();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(calls.count, TEST_VALUE_4);
  assert.equal(stop.hasPending(), false);
});
