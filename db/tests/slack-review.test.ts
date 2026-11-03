import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import { withSlackChannelSharingLock } from "../adapters/secondary/postgres/slack-review";

after(closeDbPool);

const REFRESH_REVIEW_MESSAGE = "The meeting changed or is confidential. Refresh the review before sharing.";
const SLACK_FAILURE_MESSAGE = "Slack failed";
const shareableMeeting = { isConfidential: false, status: "ended", createdByUserId: "owner" };

function mockMeetingRead({ t, read }: { t: TestContext; read: () => Promise<unknown[]> }) {
  const meetings = db.meetings;
  const original = meetings.findUnique.bind(meetings);
  Reflect.set(meetings, "findUnique", async () => {
    const rows = await read();

    return rows[0] ?? null;
  });
  t.after(() => {
    Reflect.set(meetings, "findUnique", original);
  });
}

[
  { name: "missing", rows: [] },
  { name: "confidential", rows: [{ ...shareableMeeting, isConfidential: true }] },
  { name: "active", rows: [{ ...shareableMeeting, status: "active" }] },
  { name: "scheduled", rows: [{ ...shareableMeeting, status: "scheduled" }] },
  { name: "another owner's", rows: [{ ...shareableMeeting, createdByUserId: "other" }] },
].forEach(({ name, rows }) => {
  void test(`channel sharing rejects ${name} meetings before sending`, async (t) => {
    mockMeetingRead({ t, read: async () => rows });
    await assert.rejects(
      withSlackChannelSharingLock({
        meetingId: "meeting",
        userId: "owner",
        send: async () => assert.fail("Must not send"),
      }),
      { message: REFRESH_REVIEW_MESSAGE },
    );
  });
});

void test("channel sharing reads the guard before calling send without a connection and preserves its error", async (t) => {
  const events = { current: [] as string[] };
  mockMeetingRead({
    t,
    read: async () => {
      events.current = [...events.current, "read"];

      return [shareableMeeting];
    },
  });
  const failure = new Error(SLACK_FAILURE_MESSAGE);
  const send = t.mock.fn(async (...args: unknown[]) => {
    events.current = [...events.current, "send"];
    assert.deepEqual(args, []);
    throw failure;
  });
  await assert.rejects(withSlackChannelSharingLock({ meetingId: "meeting", userId: "owner", send }), failure);
  assert.deepEqual(events.current, ["read", "send"]);
  assert.equal(send.mock.callCount(), 1);
});
