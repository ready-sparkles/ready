import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";

import type { Prisma } from "../../../../adapters/secondary/postgres/client";
import { closeDbPool, db, pool } from "../../../../adapters/secondary/postgres/client";
import {
  createMeeting,
  createMeetingLinkWithInitialMeeting,
  createOrReuseCalendarAddonConference,
  ensureMeetingParticipantRecord,
  ensureWorkspaceMembership,
  getMeetingById,
  markMeetingEnded,
  resolveMeetingLink,
  upsertParticipantPresence,
  upsertUser,
} from "../../../../adapters/secondary/postgres/repositories";
import {
  canUserViewMeetingScopedData,
  listWorkspaceAuditEvents,
  maybeAutoMarkMeetingConfidential,
  MeetingConfidentialityRequiredError,
  setMeetingConfidentiality,
} from "../../../../adapters/secondary/postgres/workspace-admin";
import { configureRealtimePublisher, type RealtimeEvent } from "../../../../ports/realtime";

const BARRIER_TIMEOUT_MS = 5_000;
const INTERNAL_PARTICIPANT_COUNT = 2;
const MESSAGE_JOIN_FINISHED_BEFORE_BARRIER = "Participant mutation settled before the transaction barrier.";
const MESSAGE_BARRIER_TIMEOUT = "Operation did not reach the controlled barrier.";
const MESSAGE_WRITE_FAILURE = "Injected confidentiality write failure.";
const TRANSACTION_TIMEOUT_MS = 20_000;

function holdTransactions(input: {
  context: TestContext;
  beforeStart?: () => Promise<void>;
  afterWork?: () => Promise<void>;
  prepareClient?: (tx: Prisma.TransactionClient) => void;
}): { mock: { restore: () => void } } {
  const original = db.$transaction.bind(db);
  const client = db;
  const state = { isRestored: false };
  const restore = () => {
    if (state.isRestored) {
      return;
    }
    state.isRestored = true;
    Reflect.deleteProperty(client, "$transaction");
  };
  const install = (transaction: object): void => {
    Reflect.set(client, "$transaction", transaction);
  };
  install(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => {
    if (input.beforeStart) {
      await input.beforeStart();
    }
    const nextOptions = { timeout: TRANSACTION_TIMEOUT_MS, ...options };
    if (input.prepareClient === undefined && input.afterWork === undefined) {
      return original(callback, nextOptions);
    }

    return original(async (tx) => {
      input.prepareClient?.(tx);
      const result = await callback(tx);
      if (input.afterWork) {
        await input.afterWork();
      }

      return result;
    }, nextOptions);
  });
  input.context.after(restore);

  return { mock: { restore } };
}

after(closeDbPool);

async function fixture() {
  const host = await upsertUser({ email: `${randomUUID()}@privacy.test`, displayName: "Host" });
  const member = await upsertUser({ email: `${randomUUID()}@privacy.test`, displayName: "Member" });
  const colleague = await upsertUser({ email: `${randomUUID()}@privacy.test`, displayName: "Colleague" });
  await Promise.all(
    [member, colleague].map(async (user) =>
      ensureWorkspaceMembership({ workspaceId: host.workspaceId, userId: user.id }),
    ),
  );
  const meeting = await createMeeting({
    title: "Concurrent privacy",
    roomName: `privacy-${randomUUID()}`,
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
    isConfidential: false,
  });

  return { host, member, colleague, meeting };
}

function barrier() {
  const state = { resolve: () => {} };
  const promise = new Promise<void>((resolve) => {
    state.resolve = resolve;
  });

  return { promise, resolve: state.resolve };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  const state: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined };
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        state.timer = setTimeout(() => {
          reject(new Error(MESSAGE_BARRIER_TIMEOUT));
        }, BARRIER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(state.timer);
  }
}

async function failIfFinished(pending: Promise<unknown>): Promise<never> {
  await pending;
  throw new Error(MESSAGE_JOIN_FINISHED_BEFORE_BARRIER);
}

async function waitForMeetingLock(deadline = Date.now() + BARRIER_TIMEOUT_MS): Promise<void> {
  const result = await pool.query<{ isWaiting: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%"meetings"%' AND pid <> pg_backend_pid()
        AND cardinality(pg_blocking_pids(pid)) > 0
    ) AS "isWaiting"
  `);
  if (result.rows[0]?.isWaiting === true) {
    return;
  }
  assert.ok(Date.now() < deadline, MESSAGE_BARRIER_TIMEOUT);
  await waitForMeetingLock(deadline);
}

[upsertParticipantPresence, ensureMeetingParticipantRecord].forEach((join) => {
  void test(`${join.name}: second internal join and privacy commit together while a queued unlock rechecks`, async (t) => {
    const { host, member, colleague, meeting } = await fixture();
    const joinGate = barrier();
    const joinReady = barrier();
    const notifications: { events: RealtimeEvent[] } = { events: [] };
    configureRealtimePublisher(async (event) => {
      notifications.events = [...notifications.events, event];
    });
    t.after(() => {
      configureRealtimePublisher(async () => undefined);
    });
    // Hold the real participant transaction after policy enforcement, before commit.
    const transaction = holdTransactions({
      context: t,
      afterWork: async () => {
        joinReady.resolve();
        await joinGate.promise;
      },
    });
    const joining = join({ meetingId: meeting.id, userId: member.id });
    try {
      await bounded(Promise.race([joinReady.promise, failIfFinished(joining)]));
      transaction.mock.restore();
      assert.equal((await getMeetingById(meeting.id))?.isConfidential, false);
      const participants = await db.meetingParticipants.findMany({ where: { meetingId: meeting.id } });
      assert.equal(participants.length, 1, "uncommitted join is not visible");
      assert.equal(notifications.events.length, 0, "no notification before commit");
      const unlocking = assert.rejects(
        setMeetingConfidentiality({
          meetingId: meeting.id,
          isConfidential: false,
          source: "manual",
          actorUserId: host.id,
        }),
        MeetingConfidentialityRequiredError,
      );
      try {
        await waitForMeetingLock();
      } finally {
        joinGate.resolve();
        await joining;
        await unlocking;
      }
    } finally {
      transaction.mock.restore();
      joinGate.resolve();
      await joining;
    }

    const updated = await getMeetingById(meeting.id);
    assert.ok(updated);
    assert.equal(updated.isConfidential, true, "no committed public internal one-to-one between join and auto-mark");
    assert.equal(updated.confidentialitySource, "auto");
    assert.equal(await maybeAutoMarkMeetingConfidential(meeting.id), false, "existing caller is an idempotent no-op");
    assert.equal(await canUserViewMeetingScopedData({ meeting: updated, userId: colleague.id }), false);
    assert.equal(await canUserViewMeetingScopedData({ meeting: updated, userId: member.id }), true);
    assert.equal(notifications.events.length, 1);
    assert.equal(notifications.events[0]?.payload.isConfidential, true);
    const events = await listWorkspaceAuditEvents({
      workspaceId: host.workspaceId,
      subjectType: "meeting",
      subjectId: meeting.id,
    });
    assert.equal(events.length, 1, "rejected unlock emits no audit change");
    assert.equal(events[0]?.metadata.source, "auto");
  });

  void test(`${join.name}: participant mutation waits on the same meeting boundary as an unlock`, async () => {
    const { member, meeting } = await fixture();
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    try {
      // This lock does not block an insert's foreign-key key-share check.
      await blocker.query("SELECT id FROM meetings WHERE id = $1 FOR NO KEY UPDATE", [meeting.id]);
      const joining = join({ meetingId: meeting.id, userId: member.id });
      try {
        await bounded(Promise.race([waitForMeetingLock(), failIfFinished(joining)]));
        const rows = await db.meetingParticipants.findMany({ where: { userId: member.id } });
        assert.equal(rows.length, 0, "participant is not written outside the meeting lock");
      } finally {
        await blocker.query("ROLLBACK");
        await joining;
      }
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
});

void test("failed automatic privacy write rolls back the join without audit or realtime notifications", async (t) => {
  const { host, member, meeting } = await fixture();
  const notifications: { events: RealtimeEvent[] } = { events: [] };
  configureRealtimePublisher(async (event) => {
    notifications.events = [...notifications.events, event];
  });
  t.after(() => {
    configureRealtimePublisher(async () => undefined);
  });
  holdTransactions({
    context: t,
    prepareClient: (tx) => {
      const meetings = tx.meetings;
      meetings.update = () => {
        throw new Error(MESSAGE_WRITE_FAILURE);
      };
      const connection = tx;
      Reflect.set(connection, "meetings", meetings);
    },
  });
  await assert.rejects(upsertParticipantPresence({ meetingId: meeting.id, userId: member.id }), {
    message: MESSAGE_WRITE_FAILURE,
  });
  const participants = await db.meetingParticipants.findMany({ where: { meetingId: meeting.id } });
  assert.equal(participants.length, 1);
  assert.equal(notifications.events.length, 0);
  assert.equal((await getMeetingById(meeting.id))?.isConfidential, false);
  assert.equal((await listWorkspaceAuditEvents({ workspaceId: host.workspaceId, subjectId: meeting.id })).length, 0);
});

void test("solo and three-person meetings may be unlocked; a later internal join commits privately", async () => {
  const { host, member, colleague, meeting } = await fixture();
  const unlocked = await setMeetingConfidentiality({
    meetingId: meeting.id,
    isConfidential: false,
    source: "manual",
    actorUserId: host.id,
  });
  assert.equal(unlocked?.isConfidential, false);
  await upsertParticipantPresence({ meetingId: meeting.id, userId: member.id });
  assert.equal((await getMeetingById(meeting.id))?.isConfidential, true);
  await upsertParticipantPresence({ meetingId: meeting.id, userId: colleague.id });
  assert.equal(
    (await db.meetingParticipants.findMany({ where: { meetingId: meeting.id } })).length,
    INTERNAL_PARTICIPANT_COUNT + 1,
  );
  assert.equal((await getMeetingById(meeting.id))?.isConfidential, true);
  const opened = await setMeetingConfidentiality({
    meetingId: meeting.id,
    isConfidential: false,
    source: "manual",
    actorUserId: host.id,
  });
  assert.equal(opened?.isConfidential, false);
  assert.equal(opened.confidentialitySource, "manual");
});

void test("initial host insertion and a concurrent first join cannot commit a public internal one-to-one", async (t) => {
  const { host } = await fixture();
  const roomName = `initial-host-${randomUUID()}`;
  const hostGate = barrier();
  const hostReady = barrier();
  const transaction = holdTransactions({
    context: t,
    afterWork: async () => {
      hostReady.resolve();
      await hostGate.promise;
    },
  });
  const creating = createMeeting({
    title: "Concurrent initial host",
    roomName,
    createdByUserId: host.id,
    isConfidential: false,
  });
  try {
    await bounded(Promise.race([hostReady.promise, failIfFinished(creating)]));
    transaction.mock.restore();
    const [meeting] = await db.meetings.findMany({ where: { roomName } });
    assert.ok(meeting);
    const member = await upsertUser({ email: `${randomUUID()}@privacy.test`, displayName: "First joiner" });
    await ensureWorkspaceMembership({ workspaceId: host.workspaceId, userId: member.id });
    const joining = upsertParticipantPresence({ meetingId: meeting.id, userId: member.id });
    try {
      await bounded(Promise.race([waitForMeetingLock(), failIfFinished(joining)]));
    } finally {
      hostGate.resolve();
      await creating;
      await joining;
    }
    assert.equal((await getMeetingById(meeting.id))?.isConfidential, true);
  } finally {
    transaction.mock.restore();
    hostGate.resolve();
    await creating;
  }
});

[upsertParticipantPresence, ensureMeetingParticipantRecord].forEach((join) => {
  void test(`${join.name}: changing an assistant record to a human atomically applies privacy`, async () => {
    const { member, meeting } = await fixture();
    await join({ meetingId: meeting.id, userId: member.id, role: "assistant" });
    assert.equal((await getMeetingById(meeting.id))?.isConfidential, false);
    await join({ meetingId: meeting.id, userId: member.id, role: "guest" });
    assert.equal((await getMeetingById(meeting.id))?.isConfidential, true);
  });
});

type CreationPath = "direct" | "linked" | "calendar" | "next instance";

async function prepareCreation(input: {
  path: CreationPath;
  host: Awaited<ReturnType<typeof upsertUser>>;
  title: string;
}) {
  const { host, title, path } = input;
  const code = `reverse-host-${randomUUID()}`;
  const creator = { title, code, createdByUserId: host.id, workspaceId: host.workspaceId };
  switch (path) {
    case "direct":
      return async () => createMeeting({ ...creator, roomName: code, isConfidential: false });
    case "linked":
      return async () => (await createMeetingLinkWithInitialMeeting(creator)).meeting;
    case "calendar":
      return async () =>
        (await createOrReuseCalendarAddonConference({ ...creator, idempotencyKey: randomUUID() })).meeting;
    case "next instance": {
      const initial = await createMeetingLinkWithInitialMeeting(creator);
      await markMeetingEnded(initial.meeting.id);

      return async () => (await resolveMeetingLink({ code }))?.meeting;
    }
  }
}

(["direct", "linked", "calendar", "next instance"] as const).forEach((path) => {
  void test(`${path}: creation returns updated privacy when another internal participant commits before the initial host`, async (t) => {
    const { host, member } = await fixture();
    const title = `Reverse initial host ${randomUUID()}`;
    const create = await prepareCreation({ path, host, title });
    const hostGate = barrier();
    const hostReady = barrier();
    // Pause before the initial host transaction locks the already committed meeting.
    const transaction = holdTransactions({
      context: t,
      beforeStart: async () => {
        hostReady.resolve();
        await hostGate.promise;
      },
    });
    const creating = create();
    try {
      await bounded(Promise.race([hostReady.promise, failIfFinished(creating)]));
      transaction.mock.restore();
      const candidates = await db.meetings.findMany({ where: { createdByUserId: host.id, status: "scheduled" } });
      const meeting = candidates.find((candidate) => candidate.title === title);
      assert.ok(meeting);
      const beforeHost = await db.meetingParticipants.findMany({ where: { meetingId: meeting.id } });
      assert.equal(beforeHost.length, 0);
      await bounded(upsertParticipantPresence({ meetingId: meeting.id, userId: member.id }));
      const beforeRelease = await db.meetingParticipants.findMany({ where: { meetingId: meeting.id } });
      assert.equal(beforeRelease.length, 1, "the other participant committed before the host starts");
      hostGate.resolve();
      const returned = await bounded(creating);
      const stored = await getMeetingById(meeting.id);
      assert.ok(stored);
      assert.equal(stored.isConfidential, true);
      assert.equal(stored.confidentialitySource, "auto");
      assert.ok(returned);
      assert.equal(returned.isConfidential, stored.isConfidential);
      assert.equal(returned.confidentialitySource, stored.confidentialitySource);
      assert.equal(returned.confidentialityUpdatedAt?.getTime(), stored.confidentialityUpdatedAt?.getTime());
      assert.equal(returned.confidentialityUpdatedByUserId, stored.confidentialityUpdatedByUserId);
    } finally {
      transaction.mock.restore();
      hostGate.resolve();
      await bounded(creating);
    }
  });
});
