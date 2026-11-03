import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool } from "../adapters/secondary/postgres/client";
import {
  countUserCreatedStandardMeetings,
  createMeetingLinkWithInitialMeeting,
  listMeetingsForUser,
  markMeetingEnded,
  markMeetingHiddenFromHistory,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

const MEETING_ALLOWANCE_TEST_TITLE = "Meeting allowance test";
const AGENT_INTRO_MEETING_TITLE = "Meet your agent";
const TEST_MEETING_CODE_PREFIX = "test-";
const MEETING_ACCESS_TESTER_DISPLAY_NAME = "Meeting Access Tester";
const MEETING_ACCESS_TEST_EMAIL_DOMAIN = "@meeting-access.readymeet.test";

const createTestMeetingCode = (): string => `${TEST_MEETING_CODE_PREFIX}${randomUUID()}`;

after(async () => {
  await closeDbPool();
});

async function createLinkedMeeting(input: {
  createdByUserId: string;
  workspaceId: string;
  kind?: "standard" | "agent_intro";
}) {
  return createMeetingLinkWithInitialMeeting({
    title: input.kind === "agent_intro" ? AGENT_INTRO_MEETING_TITLE : MEETING_ALLOWANCE_TEST_TITLE,
    code: createTestMeetingCode(),
    createdByUserId: input.createdByUserId,
    workspaceId: input.workspaceId,
    kind: input.kind,
  });
}

void test("standard meeting count excludes agent intro and debug onboarding reset meetings", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}${MEETING_ACCESS_TEST_EMAIL_DOMAIN}`,
    displayName: MEETING_ACCESS_TESTER_DISPLAY_NAME,
  });

  assert.equal(await countUserCreatedStandardMeetings(user.id), 0);

  await createLinkedMeeting({
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  assert.equal(await countUserCreatedStandardMeetings(user.id), 1);

  await createLinkedMeeting({
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
    kind: "agent_intro",
  });
  assert.equal(await countUserCreatedStandardMeetings(user.id), 1);

  const debugResetMeeting = await createLinkedMeeting({
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  await markMeetingHiddenFromHistory({
    meetingId: debugResetMeeting.meeting.id,
    reason: "debug_onboarding_reset",
    actorUserId: user.id,
  });
  assert.equal(await countUserCreatedStandardMeetings(user.id), 1);
});

void test("meeting list includes ended agent intro meetings but not scheduled intro meetings", async () => {
  const user = await upsertUser({
    email: `${randomUUID()}@meeting-list.readymeet.test`,
    displayName: "Meeting List Tester",
  });

  const intro = await createLinkedMeeting({
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
    kind: "agent_intro",
  });

  assert.equal(
    (await listMeetingsForUser(user.id)).some((meeting) => meeting.id === intro.meeting.id),
    false,
  );

  await markMeetingEnded(intro.meeting.id);

  const meetings = await listMeetingsForUser(user.id);
  assert.equal(
    meetings.some((meeting) => meeting.id === intro.meeting.id),
    true,
  );
});
