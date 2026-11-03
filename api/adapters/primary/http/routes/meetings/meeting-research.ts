import {
  meetingResearchRunResponseSchema,
  meetingResearchRunsResponseSchema,
  startMeetingResearchRunRequestSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  AgentToolBrokerError,
  cancelVoiceWebResearchRun,
  deepenVoiceWebResearchRun,
  voiceWebResearchRunToPanelPayload,
} from "../../../../../application/agent-tool-broker";
import { repositories } from "../../../../../ports/repository-runtime";
import { getMeetingAccess } from "../../support/meeting-access";
import { requireMeetingNotesAccess } from "../../support/meeting-notes-guard";

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

const WEB_RESEARCH_RUNS_LIST_LIMIT = 50;
const MEETING_RESEARCH_RUNS_LIST_LIMIT = 50;
const DEEPEN_WEB_RESEARCH_QUERY_MAX_LENGTH = 500;

const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_RESEARCH_RECOMMENDATION_NOT_FOUND = "Research recommendation not found for this meeting.";
const MESSAGE_RECOMMENDATION_NOT_DEEP_RESEARCH = "Recommendation is not a deep research recommendation.";
const MESSAGE_DEEP_RESEARCH_MISSING_QUERY = "Deep research recommendation is missing a valid query.";
const MESSAGE_RESEARCH_RUN_NOT_FOUND = "Research run not found";
const MESSAGE_WEB_RESEARCH_RUN_NOT_FOUND = "Web research run not found";

const runIdParamsSchema = z.object({
  runId: z.string().uuid(),
});
const deepenWebResearchRunBodyObjectSchema = z.object({
  query: z.string().trim().min(1).max(DEEPEN_WEB_RESEARCH_QUERY_MAX_LENGTH).optional(),
});

const startMeetingResearchRunBodySchema = z
  .union([startMeetingResearchRunRequestSchema, z.null(), z.undefined()])
  .transform((value) => value ?? {})
  .pipe(startMeetingResearchRunRequestSchema);

const deepenWebResearchRunBodySchema = z
  .union([deepenWebResearchRunBodyObjectSchema, z.null(), z.undefined()])
  .transform((value) => value ?? {});

function requireRequestUser(request: FastifyRequest) {
  const user = request.user;
  if (user === undefined) {
    throw new Error(MESSAGE_UNAUTHORIZED);
  }

  return user;
}

const requireResearchParticipant = requireMeetingNotesAccess({
  level: "participant",
  options: {
    forbiddenMessage: "Meeting research is available only to participants.",
  },
});

function sendResearchBrokerError(input: { reply: FastifyReply; error: unknown }) {
  const { reply, error } = input;
  if (error instanceof AgentToolBrokerError) {
    return reply.code(error.statusCode).send({
      message: error.message,
      code: error.code,
    });
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getPayloadString(input: { payload: Record<string, unknown>; key: string }) {
  const { payload, key } = input;
  const value = payload[key];

  return typeof value === "string" ? value.trim() : "";
}

function isWebResearchRunVisibleInPanel(run: { result: unknown }) {
  if (!isRecord(run.result)) {
    return true;
  }

  return run.result.presentationSuperseded !== true;
}

async function handleListWebResearchRuns(request: FastifyRequest) {
  const { meeting } = getMeetingAccess(request);
  const runs = await repositories().listVoiceWebResearchRunsForMeeting({
    meetingId: meeting.id,
    limit: WEB_RESEARCH_RUNS_LIST_LIMIT,
  });

  return {
    runs: runs.filter(isWebResearchRunVisibleInPanel).map((run) => voiceWebResearchRunToPanelPayload(run)),
  };
}

async function handleCreateMeetingResearchRun(request: FastifyRequest, reply: FastifyReply) {
  const { meeting } = getMeetingAccess(request);
  const user = requireRequestUser(request);
  const meetingId = meeting.id;

  const parsedBody = startMeetingResearchRunBodySchema.safeParse(request.body);
  if (!parsedBody.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsedBody.error.message });
  }

  const recommendation = await repositories().getRecommendationById(parsedBody.data.recommendationId);
  if (!recommendation || recommendation.meetingId !== meetingId) {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_RESEARCH_RECOMMENDATION_NOT_FOUND });
  }
  if (recommendation.capabilityKey !== "research_open_question") {
    return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_RECOMMENDATION_NOT_DEEP_RESEARCH });
  }

  const payload = isRecord(recommendation.payload) ? recommendation.payload : {};
  const query = getPayloadString({ payload, key: "query" });
  if (query.length === 0) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_DEEP_RESEARCH_MISSING_QUERY });
  }
  const taskKindValue = getPayloadString({ payload, key: "task_kind" });
  const taskKind = taskKindValue.length !== 0 ? taskKindValue : "answer_question";
  const profile = await repositories().ensureDefaultAgentProfileForUser({
    userId: user.id,
    displayName: user.displayName,
  });

  const { run, created: isRunCreated } = await repositories().createOrGetMeetingResearchRun({
    meetingId,
    recommendationId: recommendation.id,
    userId: user.id,
    agentProfileId: profile.id,
    query,
    taskKind,
    runRefs: {
      source: "meeting_capability_recommendation",
      recommendationId: recommendation.id,
    },
  });

  if (isRunCreated) {
    const { runMeetingResearchJob } = await import("../../../../../application/meeting-research");
    const now = new Date().toISOString();
    await runMeetingResearchJob({
      workerId: "request",
      logger: request.log,
      job: {
        id: randomUUID(),
        meetingId,
        extractionId: recommendation.extractionId,
        type: "run_meeting_research",
        scopeKey: recommendation.id,
        status: "running",
        phase: "queued",
        payload: { researchRunId: run.id, recommendationId: recommendation.id },
        result: {},
        error: null,
        attemptCount: 1,
        maxAttempts: 1,
        runAfter: now,
        lockedBy: null,
        lockedAt: null,
        startedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  return meetingResearchRunResponseSchema.parse({ run });
}

async function handleListMeetingResearchRuns(request: FastifyRequest) {
  const { meeting } = getMeetingAccess(request);
  const runs = await repositories().listMeetingResearchRunsForMeeting({
    meetingId: meeting.id,
    limit: MEETING_RESEARCH_RUNS_LIST_LIMIT,
  });

  return meetingResearchRunsResponseSchema.parse({ runs });
}

async function handleGetMeetingResearchRun(request: FastifyRequest, reply: FastifyReply) {
  const { meeting } = getMeetingAccess(request);
  const parsed = runIdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }
  const run = await repositories().getMeetingResearchRunById({ meetingId: meeting.id, runId: parsed.data.runId });
  if (!run) {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_RESEARCH_RUN_NOT_FOUND });
  }

  return meetingResearchRunResponseSchema.parse({ run });
}

async function handleCancelMeetingResearchRun(request: FastifyRequest, reply: FastifyReply) {
  const { meeting } = getMeetingAccess(request);
  const parsed = runIdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }
  const run = await repositories().cancelMeetingResearchRun({ meetingId: meeting.id, runId: parsed.data.runId });
  if (!run) {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_RESEARCH_RUN_NOT_FOUND });
  }

  return meetingResearchRunResponseSchema.parse({ run });
}

async function handleGetWebResearchRun(request: FastifyRequest, reply: FastifyReply) {
  const { meeting } = getMeetingAccess(request);
  const parsed = runIdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
  }
  const run = await repositories().getVoiceWebResearchRunForMeeting({ meetingId: meeting.id, id: parsed.data.runId });
  if (!run) {
    return reply.code(HTTP_NOT_FOUND).send({ message: MESSAGE_WEB_RESEARCH_RUN_NOT_FOUND });
  }

  return {
    run: voiceWebResearchRunToPanelPayload(run),
  };
}

async function handleDeepenWebResearchRun(request: FastifyRequest, reply: FastifyReply) {
  const { meeting } = getMeetingAccess(request);
  const user = requireRequestUser(request);
  const parsedParams = runIdParamsSchema.safeParse(request.params);
  if (!parsedParams.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
  }
  const parsedBody = deepenWebResearchRunBodySchema.safeParse(request.body);
  if (!parsedBody.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsedBody.error.message });
  }
  try {
    const run = await deepenVoiceWebResearchRun({
      meetingId: meeting.id,
      userId: user.id,
      runId: parsedParams.data.runId,
      query: parsedBody.data.query ?? null,
    });

    return { run };
  } catch (error) {
    return sendResearchBrokerError({ reply, error });
  }
}

async function handleCancelWebResearchRun(request: FastifyRequest, reply: FastifyReply) {
  const { meeting } = getMeetingAccess(request);
  const user = requireRequestUser(request);
  const parsedParams = runIdParamsSchema.safeParse(request.params);
  if (!parsedParams.success) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: parsedParams.error.message });
  }
  try {
    const run = await cancelVoiceWebResearchRun({
      meetingId: meeting.id,
      userId: user.id,
      runId: parsedParams.data.runId,
    });

    return { run };
  } catch (error) {
    return sendResearchBrokerError({ reply, error });
  }
}

export async function meetingResearchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/meetings/:meetingId/web-research-runs",
    {
      preHandler: requireResearchParticipant,
    },
    handleListWebResearchRuns,
  );

  app.post(
    "/meetings/:meetingId/research-runs",
    {
      preHandler: requireResearchParticipant,
    },
    handleCreateMeetingResearchRun,
  );

  app.get(
    "/meetings/:meetingId/research-runs",
    {
      preHandler: requireResearchParticipant,
    },
    handleListMeetingResearchRuns,
  );

  app.get(
    "/meetings/:meetingId/research-runs/:runId",
    {
      preHandler: requireResearchParticipant,
    },
    handleGetMeetingResearchRun,
  );

  app.post(
    "/meetings/:meetingId/research-runs/:runId/cancel",
    {
      preHandler: requireResearchParticipant,
    },
    handleCancelMeetingResearchRun,
  );

  app.get(
    "/meetings/:meetingId/web-research-runs/:runId",
    {
      preHandler: requireResearchParticipant,
    },
    handleGetWebResearchRun,
  );

  app.post(
    "/meetings/:meetingId/web-research-runs/:runId/deepen",
    {
      preHandler: requireResearchParticipant,
    },
    handleDeepenWebResearchRun,
  );

  app.post(
    "/meetings/:meetingId/web-research-runs/:runId/cancel",
    {
      preHandler: requireResearchParticipant,
    },
    handleCancelWebResearchRun,
  );
}
