import { type LocalParticipant, type Room, RoomEvent } from "livekit-client";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  attachPresentationClaimSync,
  PRESENTATION_CLAIM_TOPIC,
  PRESENTATION_CLAIM_TTL_MS,
  type PresentationClaim,
  publishPresentationClaim,
  requestPresentationClaimSync,
} from "../../../presentation/lib/presentation-claim-sync";

function isTestRoom(value: unknown): value is Room {
  return typeof value === "object" && value !== null && "localParticipant" in value && "remoteParticipants" in value;
}

function asTestRoom(value: unknown): Room {
  assert.ok(isTestRoom(value));

  return value;
}

function network() {
  const peers = new Map<string, ReturnType<typeof peer>>();
  const missed = new Set<string>();
  function peer(identity: string) {
    const events = new EventEmitter();
    const claims = new Map<string, PresentationClaim>();
    const ownState = { claim: null as PresentationClaim | null };
    const participant = { identity, name: identity };
    const localParticipant: Pick<LocalParticipant, "identity" | "name" | "publishData"> = {
      ...participant,
      publishData: async (bytes, options) => {
        peers.forEach((target, id) => {
          assert.ok(options);
          const destinationIdentities = options.destinationIdentities;
          const isDestinationMatch = destinationIdentities === undefined || destinationIdentities.includes(id);
          if (id !== identity && !missed.has(id) && isDestinationMatch) {
            target.room.emit(RoomEvent.DataReceived, bytes, participant, undefined, options.topic);
          }
        });
      },
    };
    const room = Object.assign(events, {
      remoteParticipants: new Map<string, typeof participant>(),
      localParticipant,
    });

    const testRoom = asTestRoom(room);

    return {
      room,
      claims,
      participant,
      install: () =>
        attachPresentationClaimSync({
          room: testRoom,
          options: {
            getLocalClaim: () => ownState.claim,
            onRemoteClaim: (claimInput) => {
              if (claimInput.claim !== null) {
                claims.set(claimInput.identity, claimInput.claim);
              } else {
                claims.delete(claimInput.identity);
              }
            },
          },
        }),
      start: async (requestedAt = Date.now()) => {
        ownState.claim = { participantIdentity: identity, requestedAt };
        await publishPresentationClaim({
          room: testRoom,
          payload: {
            type: PRESENTATION_CLAIM_TOPIC,
            state: "starting",
            requestedAt,
          },
        });
      },
      clear: async () => {
        ownState.claim = null;
        await publishPresentationClaim({
          room: testRoom,
          payload: { type: PRESENTATION_CLAIM_TOPIC, state: "clear" },
        });
      },
    };
  }
  const add = (identity: string) => {
    const next = peer(identity);
    const nextRemoteParticipants = new Map(next.room.remoteParticipants);
    peers.forEach((_other, otherId) => {
      const stored = peers.get(otherId);
      if (stored === undefined) {
        return;
      }
      stored.room.remoteParticipants.set(identity, next.participant);
      nextRemoteParticipants.set(stored.participant.identity, stored.participant);
    });
    next.room.remoteParticipants = nextRemoteParticipants;
    peers.set(identity, next);

    return next;
  };

  return { add, missed };
}

void test("a late joiner recovers a pending claim sent before its data listener existed", async () => {
  const net = network();
  const host = net.add("host");
  host.install();
  const requestedAt = Date.now();
  await host.start(requestedAt);
  const late = net.add("late");
  host.room.emit(RoomEvent.ParticipantConnected, late.participant); // replay can precede the listener
  assert.equal(late.claims.size, 0);
  late.install();
  assert.equal(late.claims.get("host")?.requestedAt, requestedAt, "replay preserves arbitration order");
  assert.equal(host.claims.size, 0, "sync requests are not claims");
  await host.clear();
  assert.equal(late.claims.size, 0);
});

void test("reconnection recovers missed starts and clears, without resurrecting cancelled claims", async () => {
  const net = network(),
    host = net.add("host"),
    viewer = net.add("viewer");
  host.install();
  viewer.install();
  net.missed.add("viewer");
  await host.start();
  net.missed.delete("viewer");
  viewer.room.emit(RoomEvent.Reconnected);
  assert.ok(viewer.claims.has("host"));
  net.missed.add("viewer");
  await host.clear();
  net.missed.delete("viewer");
  viewer.room.emit(RoomEvent.Reconnected);
  assert.equal(viewer.claims.size, 0);
});

void test("pre-presentation synchronization restores missing claims and ignores expired claims", async () => {
  const net = network(),
    host = net.add("host"),
    viewer = net.add("viewer");
  host.install();
  viewer.install();
  await host.start();
  viewer.claims.clear();
  await requestPresentationClaimSync({ room: asTestRoom(viewer.room) });
  assert.ok(viewer.claims.has("host"));
  await host.start(Date.now() - PRESENTATION_CLAIM_TTL_MS - 1);
  await requestPresentationClaimSync({ room: asTestRoom(viewer.room) });
  assert.equal(viewer.claims.size, 0);
});

void test("claims bind to the actual sender and detached rooms stop processing messages", async () => {
  const net = network(),
    host = net.add("host"),
    viewer = net.add("viewer");
  host.install();
  const dispose = viewer.install();
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      type: PRESENTATION_CLAIM_TOPIC,
      state: "starting",
      requestedAt: Date.now(),
      participantIdentity: "victim",
    }),
  );
  viewer.room.emit(RoomEvent.DataReceived, bytes, host.participant, undefined, PRESENTATION_CLAIM_TOPIC);
  assert.ok(viewer.claims.has("host"));
  assert.equal(viewer.claims.has("victim"), false);
  dispose();
  viewer.claims.clear();
  await host.start();
  viewer.room.emit(RoomEvent.Reconnected);
  assert.equal(viewer.claims.size, 0);
});
