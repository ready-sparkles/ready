import { MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { resolveAndPersistMeetingTitle } from "../../application/meeting-title-resolution";
import { repositories } from "../../ports/repository-runtime";

const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const CURRENT_TITLE = "Untitled meeting";
const TRANSCRIPT_REQUIRED_MESSAGE = "Meeting title generation requires human transcript content";
const ASSISTANT_FAILURE_MESSAGE = "boom";
const INVALID_BODY_MESSAGE = "invalid body";

function fixtureMeeting(meetingId: string) {
  return {
    id: meetingId,
    title: CURRENT_TITLE,
    roomName: "fixture-room",
    meetingLinkId: null,
    instanceNumber: 1,
    workspaceId: "workspace",
    createdByUserId: "owner",
    kind: "standard",
    status: "ended",
    isConfidential: false,
    confidentialitySource: null,
    confidentialityUpdatedByUserId: null,
    confidentialityUpdatedAt: null,
    createdAt: new Date(0),
    startedAt: null,
    endedAt: null,
    hiddenFromHistoryAt: null,
    hiddenFromHistoryReason: null,
  };
}

void test("a meeting with no human speech keeps its title instead of failing", async (t) => {
  const meetingId = randomUUID();
  t.mock.method(repositories(), "getMeetingById", async () => fixtureMeeting(meetingId));
  const titleWrites = t.mock.method(repositories(), "updateMeetingTitleIfCurrent", async () => null);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE, message: TRANSCRIPT_REQUIRED_MESSAGE },
      { status: HTTP_UNPROCESSABLE_ENTITY },
    ),
  );

  const result = await resolveAndPersistMeetingTitle({ meetingId });

  assert.equal(result.title, CURRENT_TITLE);
  assert.equal(result.updated, false);
  assert.equal(result.model, null);
  assert.deepEqual(result.preparationLines, []);
  assert.equal(titleWrites.mock.callCount(), 0);
});

void test("an unexpected assistant failure while titling still rejects", async (t) => {
  const meetingId = randomUUID();
  t.mock.method(repositories(), "getMeetingById", async () => fixtureMeeting(meetingId));
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: ASSISTANT_FAILURE_MESSAGE }, { status: HTTP_INTERNAL_SERVER_ERROR }),
  );

  await assert.rejects(() => resolveAndPersistMeetingTitle({ meetingId }), /Assistant service error \(500\)/);
});

void test("a 422 without the transcript code is not treated as an empty meeting", async (t) => {
  const meetingId = randomUUID();
  t.mock.method(repositories(), "getMeetingById", async () => fixtureMeeting(meetingId));
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: INVALID_BODY_MESSAGE }, { status: HTTP_UNPROCESSABLE_ENTITY }),
  );

  await assert.rejects(() => resolveAndPersistMeetingTitle({ meetingId }), /Assistant service error \(422\)/);
});
