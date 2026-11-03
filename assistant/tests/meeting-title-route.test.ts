import "../composition/wire";

import { MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { internalRoutes } from "../adapters/primary/http/routes";
import { assistantEnv } from "../ports/assistant-env";
import { repositories } from "../ports/repository-runtime";

type TranscriptForMeeting = Awaited<ReturnType<ReturnType<typeof repositories>["getTranscriptForMeeting"]>>;

const HTTP_UNPROCESSABLE_ENTITY = 422;
const MEETING_ID = "550e8400-e29b-41d4-a716-446655440001";
const UNEXPECTED_MODEL_CALL_MESSAGE = "A meeting with no human speech must not call the model";

const titleRejectionSchema = z.object({ code: z.string(), message: z.string() });

const EMPTY_TRANSCRIPT: TranscriptForMeeting = {
  transcript: { id: "transcript", meetingId: MEETING_ID, source: "live", metadata: {}, createdAt: new Date(0) },
  segments: [],
};

async function postTitleForMeetingWithTranscript(input: {
  t: test.TestContext;
  transcript: TranscriptForMeeting;
}): Promise<z.infer<typeof titleRejectionSchema> & { statusCode: number }> {
  const { t, transcript } = input;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(UNEXPECTED_MODEL_CALL_MESSAGE);
  });
  t.mock.method(repositories(), "getMeetingById", async () => ({
    id: MEETING_ID,
    title: "Untitled meeting",
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
  }));
  t.mock.method(repositories(), "getTranscriptForMeeting", async () => transcript);
  t.mock.method(repositories(), "listParticipantsForMeeting", async () => []);
  t.mock.method(repositories(), "listVoiceSearchEvidenceForMeeting", async () => []);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(internalRoutes);

  const response = await app.inject({
    method: "POST",
    url: `/internal/meetings/${MEETING_ID}/title`,
    payload: { meetingId: MEETING_ID },
    headers: { "x-assistant-service-secret": assistantEnv().ASSISTANT_SERVICE_SECRET },
  });

  return { statusCode: response.statusCode, ...titleRejectionSchema.parse(response.json()) };
}

void test("title route answers 422 with a stable code when the meeting has no human speech", async (t) => {
  const response = await postTitleForMeetingWithTranscript({ t, transcript: EMPTY_TRANSCRIPT });

  assert.equal(response.statusCode, HTTP_UNPROCESSABLE_ENTITY);
  assert.equal(response.code, MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE);
  assert.match(response.message, /requires human transcript content/);
});

void test("title route answers the same 422 when the meeting has no transcript row yet", async (t) => {
  const response = await postTitleForMeetingWithTranscript({ t, transcript: null });

  assert.equal(response.statusCode, HTTP_UNPROCESSABLE_ENTITY);
  assert.equal(response.code, MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE);
  assert.match(response.message, /requires human transcript content/);
});
