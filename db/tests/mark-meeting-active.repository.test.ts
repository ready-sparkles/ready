import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  createMeeting,
  getMeetingById,
  markMeetingActive,
  markMeetingEnded,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

after(async () => {
  await closeDbPool();
});

const EXISTING_START_WRITE_NUMBER = 2;

async function createActivationMeeting() {
  const host = await upsertUser({
    email: `${randomUUID()}@activation.readymeet.test`,
    displayName: "Activation Host",
  });

  return createMeeting({
    title: "Activation meeting",
    roomName: `activation-${randomUUID()}`,
    createdByUserId: host.id,
    workspaceId: host.workspaceId,
  });
}

const meetingWriteIntercept: {
  isInstalled: boolean;
  current: (<T>(run: () => Promise<T>) => Promise<T>) | null;
} = { isInstalled: false, current: null };

function installMeetingWriteIntercept(): void {
  if (meetingWriteIntercept.isInstalled) {
    return;
  }
  meetingWriteIntercept.isInstalled = true;
  const meetings = db.meetings;
  const updateMany = meetings.updateMany.bind(meetings);
  const updateManyAndReturn = meetings.updateManyAndReturn.bind(meetings);
  const sequenceWrite = <T>(write: () => Promise<T>): Promise<T> => {
    const intercept = meetingWriteIntercept.current;

    return intercept === null ? write() : intercept(write);
  };
  Reflect.set(meetings, "updateMany", (args: Parameters<typeof updateMany>[0]) =>
    sequenceWrite(() => updateMany(args)),
  );
  Reflect.set(meetings, "updateManyAndReturn", (args: Parameters<typeof updateManyAndReturn>[0]) =>
    sequenceWrite(() => updateManyAndReturn(args)),
  );
  const client = db;
  Reflect.set(client, "meetings", meetings);
}

function beforeActivationWrite(input: {
  context: TestContext;
  update: () => Promise<void>;
  writeNumber?: number;
}): void {
  installMeetingWriteIntercept();
  const calls = { count: 0 };
  const targetWrite = input.writeNumber ?? 1;
  meetingWriteIntercept.current = async (run) => {
    calls.count += 1;
    if (calls.count === targetWrite) {
      await input.update();
    }

    return run();
  };
  input.context.after(() => {
    meetingWriteIntercept.current = null;
  });
}

void test("markMeetingActive keeps ended meetings ended", async () => {
  const meeting = await createActivationMeeting();
  await markMeetingEnded(meeting.id);
  const ended = await getMeetingById(meeting.id);

  await markMeetingActive(meeting.id);

  const actual = await getMeetingById(meeting.id);
  assert.equal(actual?.status, "ended");
  assert.equal(actual.startedAt, null);
  assert.deepEqual(actual.endedAt, ended?.endedAt);
});

void test("markMeetingActive cannot overwrite an end committed before its write", async (context) => {
  const meeting = await createActivationMeeting();
  const endedAt = new Date("2026-01-01T00:00:00.000Z");
  beforeActivationWrite({
    context,
    update: async () => {
      await db.meetings.updateMany({ where: { id: meeting.id }, data: { status: "ended", endedAt } });
    },
  });

  await markMeetingActive(meeting.id);

  const actual = await getMeetingById(meeting.id);
  assert.equal(actual?.status, "ended");
  assert.equal(actual.startedAt, null);
  assert.deepEqual(actual.endedAt, endedAt);
});

void test("markMeetingActive preserves the first start time across competing and repeated activation", async (context) => {
  const meeting = await createActivationMeeting();
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  beforeActivationWrite({
    context,
    update: async () => {
      await db.meetings.updateMany({ where: { id: meeting.id }, data: { status: "active", startedAt } });
    },
  });

  await markMeetingActive(meeting.id);

  const afterCompetingActivation = await getMeetingById(meeting.id);
  assert.equal(afterCompetingActivation?.status, "active");
  assert.deepEqual(afterCompetingActivation.startedAt, startedAt);

  await markMeetingActive(meeting.id);
  const afterRepeatedActivation = await getMeetingById(meeting.id);
  assert.deepEqual(afterRepeatedActivation?.startedAt, startedAt);
});

void test("markMeetingActive cannot overwrite an end before its existing-start write", async (context) => {
  const meeting = await createActivationMeeting();
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const endedAt = new Date("2026-01-01T00:01:00.000Z");
  await db.meetings.updateMany({ where: { id: meeting.id }, data: { startedAt } });
  beforeActivationWrite({
    context,
    writeNumber: EXISTING_START_WRITE_NUMBER,
    update: async () => {
      await db.meetings.updateMany({ where: { id: meeting.id }, data: { status: "ended", endedAt } });
    },
  });

  await markMeetingActive(meeting.id);

  const actual = await getMeetingById(meeting.id);
  assert.equal(actual?.status, "ended");
  assert.deepEqual(actual.startedAt, startedAt);
  assert.deepEqual(actual.endedAt, endedAt);
});

void test("markMeetingActive activates a meeting with an existing start time without replacing it", async () => {
  const meeting = await createActivationMeeting();
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  await db.meetings.updateMany({ where: { id: meeting.id }, data: { startedAt } });

  await markMeetingActive(meeting.id);

  const actual = await getMeetingById(meeting.id);
  assert.equal(actual?.status, "active");
  assert.deepEqual(actual.startedAt, startedAt);
});

void test("markMeetingActive starts a scheduled meeting only once", async () => {
  const meeting = await createActivationMeeting();
  assert.equal(meeting.startedAt, null);

  await markMeetingActive(meeting.id);
  const first = await getMeetingById(meeting.id);
  assert.equal(first?.status, "active");
  assert.ok(first.startedAt instanceof Date);

  await markMeetingActive(meeting.id);
  const repeated = await getMeetingById(meeting.id);
  assert.deepEqual(repeated?.startedAt, first.startedAt);
});
