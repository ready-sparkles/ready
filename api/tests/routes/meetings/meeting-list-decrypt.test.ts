import rateLimit from "@fastify/rate-limit";
import { MeetingContentCryptoError } from "@readymeet/db/domain/content-key-errors";
import { meetingListResponseSchema } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { apiErrorResponse } from "../../../adapters/primary/http/error-handler";
import { meetingLifecycleRoutes } from "../../../adapters/primary/http/routes/meetings/meeting-lifecycle";
import { signAuthToken } from "../../../adapters/primary/http/support/auth";
import { repositories } from "../../../ports/repository-runtime";

const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const GOOD_TITLE = "Visible meeting";
const OTHER_TITLE = "Second meeting";
const SUMMARY_SENTINEL = "PRIVATE-SUMMARY-SENTINEL";
const SHARED_NOTES = "Shared notes";
const SECOND_NOTES = "Second notes";
const CIPHER_PREFIX = "ready-content:v1:";
const SUMMARY_MODEL = "test";
type SummaryReader = ReturnType<typeof repositories>["getSummaryForMeeting"];

function summary(input: { meetingId: string; content: string }): Awaited<ReturnType<SummaryReader>> {
  const recordedAt = new Date("2026-10-21T13:00:00.000Z");

  return {
    id: randomUUID(),
    meetingId: input.meetingId,
    content: input.content,
    model: SUMMARY_MODEL,
    generatedAt: recordedAt,
    createdAt: recordedAt,
  };
}

function meeting(input: { id: string; workspaceId: string; userId: string; title: string }) {
  return {
    isParticipant: true,
    id: input.id,
    workspaceId: input.workspaceId,
    title: input.title,
    roomName: `room-${input.id}`,
    meetingLinkId: null,
    instanceNumber: 1,
    createdByUserId: input.userId,
    kind: "standard" as const,
    status: "ended" as const,
    isConfidential: false,
    confidentialitySource: null,
    createdAt: new Date("2026-10-21T12:00:00.000Z"),
    startedAt: new Date("2026-10-21T12:00:00.000Z"),
    endedAt: new Date("2026-10-21T13:00:00.000Z"),
  };
}

async function listApp(input: { summary: SummaryReader }): Promise<{
  goodId: string;
  otherId: string;
  inject: () => Promise<{ statusCode: number; body: string }>;
  close: () => Promise<void>;
}> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const goodId = randomUUID();
  const otherId = randomUUID();
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => apiErrorResponse({ error, request, reply }));
  await app.register(rateLimit, { global: false });
  const port = repositories();
  const previous = {
    getUserAuthState: port.getUserAuthState,
    touchUserLastSeen: port.touchUserLastSeen,
    listWorkspaceVisibleMeetingsForUser: port.listWorkspaceVisibleMeetingsForUser,
    listHumanParticipantsForMeetings: port.listHumanParticipantsForMeetings,
    getSummaryForMeeting: port.getSummaryForMeeting,
    getSummariesForMeetings: port.getSummariesForMeetings,
  };
  port.getUserAuthState = async () => ({
    id: userId,
    email: "owner@example.com",
    displayName: "Owner",
    avatarUrl: null,
    source: "auth",
    plan: "free",
    agentIntroCompletedAt: null,
    sessionVersion: 1,
    activeWorkspaceId: null,
    deletedAt: null,
  });
  port.touchUserLastSeen = async () => undefined;
  port.listWorkspaceVisibleMeetingsForUser = async () => [
    meeting({ id: goodId, workspaceId, userId, title: GOOD_TITLE }),
    meeting({ id: otherId, workspaceId, userId, title: OTHER_TITLE }),
  ];
  port.listHumanParticipantsForMeetings = async () => new Map();
  port.getSummaryForMeeting = input.summary;
  port.getSummariesForMeetings = async (meetingIds) => {
    const entries = await Promise.all(
      meetingIds.map(async (meetingId) => {
        const value = await input.summary(meetingId);

        return value === null ? [] : [[meetingId, value] as const];
      }),
    );

    return new Map(entries.flat());
  };
  await app.register(meetingLifecycleRoutes);
  const token = signAuthToken({
    sub: userId,
    email: "owner@example.com",
    displayName: "Owner",
    workspaceId,
    sessionVersion: 1,
  });

  return {
    goodId,
    otherId,
    inject: () => app.inject({ method: "GET", url: "/meetings", headers: { authorization: `Bearer ${token}` } }),
    close: async () => {
      Object.assign(port, previous);
      await app.close();
    },
  };
}

void test("the meeting list returns every readable meeting", async () => {
  const fixture = await listApp({
    summary: async (meetingId) => summary({ meetingId, content: `- ${SHARED_NOTES}` }),
  });
  try {
    const response = await fixture.inject();
    assert.equal(response.statusCode, HTTP_OK);
    const titles = meetingListResponseSchema.parse(JSON.parse(response.body)).meetings.map((item) => item.title);
    assert.deepEqual(titles, [GOOD_TITLE, OTHER_TITLE]);
    assert.equal(response.body.includes(SHARED_NOTES), true);
  } finally {
    await fixture.close();
  }
});

void test("one undecryptable summary does not fail the meeting list or reveal stored text", async () => {
  const fixture = await listApp({
    summary: async (meetingId) => {
      if (meetingId === fixture.goodId) {
        throw new MeetingContentCryptoError();
      }

      return summary({ meetingId, content: `- ${SECOND_NOTES}` });
    },
  });
  try {
    const response = await fixture.inject();
    assert.equal(response.statusCode, HTTP_OK);
    const meetings = meetingListResponseSchema.parse(JSON.parse(response.body)).meetings;
    assert.deepEqual(
      meetings.map((item) => item.title),
      [GOOD_TITLE, OTHER_TITLE],
    );
    assert.equal(meetings.find((item) => item.id === fixture.goodId)?.notePreview, null);
    assert.equal(meetings.find((item) => item.id === fixture.otherId)?.notePreview, SECOND_NOTES);
    assert.equal(response.body.includes(SUMMARY_SENTINEL), false);
    assert.equal(response.body.includes(CIPHER_PREFIX), false);
  } finally {
    await fixture.close();
  }
});

void test("a summary failure that is not a decrypt error still fails the meeting list closed", async () => {
  const fixture = await listApp({
    summary: async () => {
      throw new Error(SUMMARY_SENTINEL);
    },
  });
  try {
    const response = await fixture.inject();
    assert.equal(response.statusCode, HTTP_INTERNAL_SERVER_ERROR);
    assert.equal(response.body.includes(SUMMARY_SENTINEL), false);
    assert.equal(response.body.includes(GOOD_TITLE), false);
  } finally {
    await fixture.close();
  }
});
