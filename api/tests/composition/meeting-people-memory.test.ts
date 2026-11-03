import { type MemoryPerson, memoryPreferencesSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { MeetingRecord } from "../../adapters/primary/http/support/meeting-access";
import { meetingPeopleMemory } from "../../application/meeting-people-memory";

type Deps = NonNullable<Parameters<typeof meetingPeopleMemory>[2]>;
type UserRow = NonNullable<Awaited<ReturnType<NonNullable<Deps["getUserById"]>>>>;
type MeetingParticipant = Awaited<ReturnType<NonNullable<Deps["listParticipantsForMeeting"]>>>[number];
type WaitingJoinRequest = Awaited<ReturnType<NonNullable<Deps["listWaitingJoinRequestsForMeeting"]>>>[number];
type MemoryReadContext = Awaited<ReturnType<NonNullable<Deps["memoryReadContext"]>>>;

const EXPECTED_MEMORY_PERSON_MESSAGE = "Expected a memory person";
const EXPECTED_MEMORY_SECTION_PERSON_MESSAGE = "Expected a memory person for the section";
const NO_PHOTO_INITIALS_MESSAGE = "no photo means initials, not another linked account";

const TEST_AVATAR_URL = "https://example.test/avatar.jpg";
const TEST_ACTUAL_HOST_AVATAR_URL = "https://example.test/actual-host.jpg";
const TEST_DIFFERENT_ACCOUNT_AVATAR_URL = "https://example.test/different-account.jpg";
const TEST_MEMORY_PREFERENCES_REVISION = 0;
const WAITING_MEMORY_PERSON_INDEX = 2;
const HOST_MEMORY_PERSON_INDEX = 0;
const FIRST_RESULT_INDEX = 0;
const EXPECTED_COHOST_CARD_COUNT = 2;

const now = new Date("2026-09-29T12:00:00.000Z");
const viewer = randomUUID();
const host = randomUUID();
const attendee = randomUUID();
const waiting = randomUUID();
const left = randomUUID();
const assistant = randomUUID();
const scope = { userId: viewer, workspaceId: randomUUID() };
const meeting = buildMeetingRecord({
  id: randomUUID(),
  createdByUserId: randomUUID(),
  createdAt: now,
});

function buildMeetingRecord(input: { id: string; createdByUserId: string; createdAt: Date }): MeetingRecord {
  return {
    id: input.id,
    title: "Fixture meeting",
    roomName: "fixture-room",
    meetingLinkId: null,
    instanceNumber: 1,
    workspaceId: scope.workspaceId,
    createdByUserId: input.createdByUserId,
    kind: "standard",
    status: "active",
    isConfidential: false,
    confidentialitySource: null,
    confidentialityUpdatedByUserId: null,
    confidentialityUpdatedAt: null,
    createdAt: input.createdAt,
    startedAt: input.createdAt,
    endedAt: null,
    hiddenFromHistoryAt: null,
    hiddenFromHistoryReason: null,
  } satisfies MeetingRecord;
}

function buildMemoryReadContext(input: { sourceIds: string[] }): MemoryReadContext {
  return {
    preferences: { ...memoryPreferencesSchema.parse({}), revision: TEST_MEMORY_PREFERENCES_REVISION },
    sources: [],
    sourceIds: input.sourceIds,
  };
}

function buildUser(input: { avatarUrl: string | null }): UserRow {
  return {
    id: randomUUID(),
    email: "fixture@example.test",
    displayName: "Fixture",
    avatarUrl: input.avatarUrl,
    source: "auth",
    plan: "free",
    privateBetaProEnabledAt: null,
    hasCompletedFirstMeeting: false,
    lastSeenAt: null,
    activeWorkspaceId: null,
    agentIntroCompletedAt: null,
    sessionVersion: 0,
    deletedAt: null,
    createdAt: now,
    workspaceId: scope.workspaceId,
  };
}

function buildParticipant(input: {
  userId: string;
  role: MeetingParticipant["role"];
  joinedAt: Date;
  leftAt: Date | null;
}): MeetingParticipant {
  return {
    userId: input.userId,
    email: `${input.userId}@example.test`,
    displayName: "Fixture participant",
    source: "auth",
    role: input.role,
    joinedAt: input.joinedAt,
    leftAt: input.leftAt,
  };
}

function buildWaitingJoinRequest(input: { userId: string }): WaitingJoinRequest {
  const timestamp = now.toISOString();

  return {
    id: randomUUID(),
    meetingLinkId: randomUUID(),
    meetingId: meeting.id,
    userId: input.userId,
    displayName: "Waiting",
    status: "waiting",
    sipCallId: null,
    sipParticipantIdentity: null,
    sipHoldingRoom: null,
    requestedAt: timestamp,
    decidedAt: null,
    decidedByUserId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const person = (name: string): MemoryPerson => ({
  id: randomUUID(),
  name,
  lastContact: now.toISOString(),
  categories: [],
});

function personAt(input: { people: MemoryPerson[]; index: number }) {
  const match = input.people[input.index];
  if (match === undefined) {
    throw new Error(EXPECTED_MEMORY_PERSON_MESSAGE);
  }

  return match;
}

function passthroughCallExpressionCallback<THandler>(handler: THandler): THandler {
  return handler;
}

type MemoryPeopleForMeetingUsers = NonNullable<Deps["memoryPeopleForMeetingUsers"]>;
type MemoryPeopleForMeetingUsersRequest = Parameters<MemoryPeopleForMeetingUsers>[0];

function buildFixtureMemoryPeopleForMeetingUsers(input: {
  people: MemoryPerson[];
  onResolvedUserIds: (userIds: string[]) => void;
}): MemoryPeopleForMeetingUsers {
  const trackedUserIds = [host, attendee, waiting];

  return passthroughCallExpressionCallback(async (request: MemoryPeopleForMeetingUsersRequest) => {
    assert.deepEqual(request.scope, scope);
    input.onResolvedUserIds(request.userIds);

    return trackedUserIds
      .filter((id) => request.userIds.includes(id))
      .map((userId) => ({
        userId,
        personId: personAt({ people: input.people, index: trackedUserIds.indexOf(userId) }).id,
      }));
  });
}

function defaultFixtureParticipants(): MeetingParticipant[] {
  const participantUserIds: string[] = [host, viewer, attendee, left, assistant];

  return participantUserIds.map((userId) =>
    buildParticipant({
      userId,
      joinedAt: now,
      leftAt: userId === left ? now : null,
      role: userId === host ? "host" : userId === assistant ? "assistant" : "guest",
    }),
  );
}

function fixture(isHost = false) {
  const people = [person("Host"), person("Attendee"), person("Waiting")];
  const identity: { users: string[]; waitingReads: number } = { users: [], waitingReads: 0 };
  const deps: Deps = {
    getUserById: async () => buildUser({ avatarUrl: TEST_AVATAR_URL }),
    memoryReadContext: async (receivedScope) => {
      assert.deepEqual(receivedScope, scope);

      return buildMemoryReadContext({ sourceIds: [randomUUID()] });
    },
    listMemoryPeople: async (request) => {
      assert.deepEqual(request.scope, scope);

      return people;
    },
    isAuthorizedMeetingHost: async () => isHost,
    listParticipantsForMeeting: async () => defaultFixtureParticipants(),
    listWaitingJoinRequestsForMeeting: async () => {
      identity.waitingReads += 1;

      return [buildWaitingJoinRequest({ userId: waiting })];
    },
    memoryPeopleForMeetingUsers: buildFixtureMemoryPeopleForMeetingUsers({
      people,
      onResolvedUserIds: (userIds) => {
        identity.users = [...userIds];
      },
    }),
    memorySectionFor: passthroughCallExpressionCallback(async (receivedScope, name) => {
      assert.deepEqual(receivedScope, scope);
      const matched = people.find((entry) => entry.name === name);
      if (matched === undefined) {
        throw new Error(EXPECTED_MEMORY_SECTION_PERSON_MESSAGE);
      }

      return {
        personId: matched.id,
        name,
        summary: ["Private context"],
        standing: [],
        lastContact: null,
      };
    }),
  };

  return { deps, people, users: () => identity.users, waitingReads: () => identity.waitingReads };
}

void test("joining shows a host who did not create the meeting and current people using only the viewer’s memory", async () => {
  const f = fixture();
  const result = await meetingPeopleMemory(scope, meeting, f.deps);
  assert.deepEqual(
    result.items.map((item) => item.displayName),
    ["Host", "Attendee"],
  );
  assert.deepEqual(f.users(), [host, attendee]);
  assert.equal(f.waitingReads(), 0);
  assert.ok(
    result.items.every(
      (item) => item.privateDetails.memory !== null && item.status === "ready" && (item.summary ?? "") === "",
    ),
  );
  assert.ok(result.items.every((item) => item.privateImageUrl === TEST_AVATAR_URL));
});

void test("hosts also see known waiting-room arrivals; admission keeps the same card identity", async () => {
  const f = fixture(true);
  const result = await meetingPeopleMemory(scope, meeting, f.deps);
  assert.equal(
    result.items[WAITING_MEMORY_PERSON_INDEX]?.id,
    personAt({ people: f.people, index: WAITING_MEMORY_PERSON_INDEX }).id,
  );
  f.deps.listWaitingJoinRequestsForMeeting = async () => [];
  f.deps.listParticipantsForMeeting = async () => [
    buildParticipant({ userId: waiting, joinedAt: now, leftAt: null, role: "guest" }),
  ];
  const admitted = await meetingPeopleMemory(scope, meeting, f.deps);
  assert.equal(
    admitted.items.find((item) => item.displayName === "Waiting")?.id,
    result.items[WAITING_MEMORY_PERSON_INDEX].id,
  );
});

void test("no memory, revoked source access, ambiguous identity and empty details produce no card", async () => {
  await ["no-sources", "no-people", "no-identity", "ambiguous", "empty"].reduce(async (previous, mode) => {
    await previous;
    const f = fixture();
    if (mode === "no-sources") {
      f.deps.memoryReadContext = async () => buildMemoryReadContext({ sourceIds: [] });
    }
    if (mode === "no-people") {
      f.deps.listMemoryPeople = async () => [];
    }
    if (mode === "no-identity") {
      f.deps.memoryPeopleForMeetingUsers = async () => [];
    }
    if (mode === "ambiguous") {
      f.deps.memoryPeopleForMeetingUsers = async () => [
        { userId: host, personId: personAt({ people: f.people, index: HOST_MEMORY_PERSON_INDEX }).id },
        { userId: host, personId: personAt({ people: f.people, index: HOST_MEMORY_PERSON_INDEX + 1 }).id },
      ];
    }
    if (mode === "empty") {
      f.deps.memorySectionFor = async () => null;
    }
    assert.deepEqual(await meetingPeopleMemory(scope, meeting, f.deps), { items: [] }, mode);
  }, Promise.resolve());
});

void test("assigned co-hosts are included before arrival, while an absent non-host creator is not", async () => {
  const f = fixture();
  f.deps.listParticipantsForMeeting = async () => [
    buildParticipant({ userId: host, joinedAt: now, leftAt: null, role: "host" }),
    buildParticipant({ userId: attendee, joinedAt: now, leftAt: null, role: "host" }),
    // joined_at is NOT NULL, so an absent guest creator is one who has left.
    buildParticipant({ userId: meeting.createdByUserId, joinedAt: now, leftAt: now, role: "guest" }),
  ];
  const result = await meetingPeopleMemory(scope, meeting, f.deps);
  assert.deepEqual(f.users(), [host, attendee]);
  assert.equal(result.items.length, EXPECTED_COHOST_CARD_COUNT);
});

void test("arrival photos use the matched account, never another account linked to the memory person", async () => {
  const f = fixture();
  personAt({ people: f.people, index: HOST_MEMORY_PERSON_INDEX }).imageUrl = TEST_DIFFERENT_ACCOUNT_AVATAR_URL;
  f.deps.getUserById = async (id) => buildUser({ avatarUrl: id === host ? TEST_ACTUAL_HOST_AVATAR_URL : null });
  const result = await meetingPeopleMemory(scope, meeting, f.deps);
  assert.equal(result.items[FIRST_RESULT_INDEX]?.privateImageUrl, TEST_ACTUAL_HOST_AVATAR_URL);
  assert.equal(result.items[FIRST_RESULT_INDEX].privateDetails.memory?.imageUrl, TEST_ACTUAL_HOST_AVATAR_URL);
  f.deps.getUserById = async () => buildUser({ avatarUrl: null });
  const cleared = await meetingPeopleMemory(scope, meeting, f.deps);
  assert.equal(cleared.items[FIRST_RESULT_INDEX]?.privateImageUrl, null, NO_PHOTO_INITIALS_MESSAGE);
});
