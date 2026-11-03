import { InsufficientAiCreditsError } from "@readymeet/db/domain/persistence-errors";
import {
  bugReportDraftRevisionRequestSchema,
  bugReportIssuePlanningRequestSchema,
  dismissedMeetingTaskTombstoneSchema,
  INSUFFICIENT_CREDITS_CODE,
  linearTaskReviewClassificationRequestSchema,
  linearTaskReviewRevisionRequestSchema,
  liveKitRealtimeEventSchema,
  MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE,
  meetingCoachingGenerationRequestSchema,
  meetingTaskCandidateSchema,
  MeetingTitleTranscriptRequired,
  memoryFailureDiagnostic,
  memoryGenerationInputSchema,
  MemoryGenerationRejected,
} from "@readymeet/shared";
import { voiceSearchIdentityEvidenceSchema } from "@readymeet/shared/server/voice-research-evidence";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { generateCapabilitySelection } from "../../../application/capability-selection";
import { generateMeetingCoachingFeedbackWithModel } from "../../../application/capability-workflow-coaching";
import { planBugReportIssuesWithModel } from "../../../application/capability-workflow-issue-planner";
import { reviseBugReportDraftWithModel } from "../../../application/capability-workflow-revision";
import { classifyLinearTasksWithModel, reviseLinearTaskReviewWithModel } from "../../../application/linear-task-review";
import {
  generateMeetingExtraction,
  generateMeetingSignals,
  generateMeetingSnapshot,
  generateMeetingTaskChunk,
  generateMeetingTasks,
  generateMeetingTitle,
  reconcileMeetingTasks,
} from "../../../application/meeting-extraction";
import { generateMeetingMemory } from "../../../application/memory-generation";
import { generatePostCallArtifacts } from "../../../application/postcall-artifacts";
import { createMemoryModelRunner } from "../../../application/relationship-memory";
import { repositories } from "../../../ports/repository-runtime";
import { LiveKitRoomAssistantDispatchManager } from "../../secondary/livekit/agent-dispatch-manager";
import { processLiveKitRealtimeEvent } from "../../secondary/livekit/realtime-event-processor";
import { LiveKitTranscriptionManager } from "../../secondary/livekit/transcription-manager";

import { withMemoryRequestSignal } from "./memory-request";
import { requireInternalSecret } from "./secure";

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_SERVICE_UNAVAILABLE = 503;
const BYTES_PER_KIBIBYTE = 1024;
const MEMORY_GENERATE_BODY_LIMIT_MEBIBYTES = 16;
const MEMORY_GENERATE_BODY_LIMIT_BYTES = MEMORY_GENERATE_BODY_LIMIT_MEBIBYTES * BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;
const VOICE_SEARCH_EVIDENCE_MAX_ITEMS = 20;

const INTERNAL_ROUTE_MESSAGES = {
  memoryGenerationFailed: "Memory generation failed",
  invalidMemoryGenerationInput: "Invalid memory generation input",
  invalidLiveKitRealtimeEvent: "Invalid LiveKit realtime event",
} as const;

const meetingIdRouteParamsSchema = z.object({ meetingId: z.string().uuid() });
const runIdRouteParamsSchema = z.object({ runId: z.string().uuid() });
const extractionIdRouteParamsSchema = z.object({ extractionId: z.string().uuid() });

const fastifyRequestBodySchema = z.record(z.string(), z.unknown());

const assistantMeteringContextSchema = z
  .object({
    meetingId: z.string().uuid().nullable().optional(),
    jobId: z.string().uuid().nullable().optional(),
    workflowRunId: z.string().uuid().nullable().optional(),
  })
  .nullable()
  .optional();

const summarizeMeetingRequestSchema = z.object({
  meetingId: z.string().uuid(),
  metering: assistantMeteringContextSchema,
});

const meetingTasksRequestSchema = z.object({
  meetingId: z.string().uuid(),
  metering: assistantMeteringContextSchema,
  initialCandidates: z.array(meetingTaskCandidateSchema).default([]),
  dismissedTombstones: z.array(dismissedMeetingTaskTombstoneSchema).default([]),
});

const selectCapabilitiesRequestSchema = z.object({
  extractionId: z.string().uuid(),
  forceRefresh: z.boolean().optional(),
  tasks: z.unknown().optional(),
});

const meetingTaskChunkRequestSchema = z.object({
  voiceSearchIdentityEvidence: z
    .array(voiceSearchIdentityEvidenceSchema)
    .max(VOICE_SEARCH_EVIDENCE_MAX_ITEMS)
    .optional(),
  meetingId: z.string().uuid(),
  metering: assistantMeteringContextSchema,
  title: z.string().nullable(),
  participants: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        roleHint: z.string().nullable().optional(),
      }),
    )
    .default([]),
  chunkIndex: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive(),
  taskHintScore: z.number().int().nonnegative(),
  transcriptText: z.string().trim().min(1),
  languageContext: z.string().trim().min(1).optional(),
  extractionMode: z.enum(["general", "personal_list"]).optional().default("general"),
});

const meetingTaskReconciliationRequestSchema = z.object({
  voiceSearchIdentityEvidence: z
    .array(voiceSearchIdentityEvidenceSchema)
    .max(VOICE_SEARCH_EVIDENCE_MAX_ITEMS)
    .optional(),
  meetingId: z.string().uuid(),
  metering: assistantMeteringContextSchema,
  evidencePacket: z.record(z.string(), z.unknown()),
});

const liveKitTranscriptionManager = new LiveKitTranscriptionManager();
const liveKitRoomAssistantDispatchManager = new LiveKitRoomAssistantDispatchManager();

function sendMemoryFailure(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  error: unknown;
  meetingId: string | null;
}): FastifyReply {
  const { request, reply, error, meetingId } = params;
  const diagnostic = memoryFailureDiagnostic(error, "model");
  request.log.warn({ meetingId, diagnostic }, "Memory generation rejected");

  return reply
    .code(error instanceof MemoryGenerationRejected ? HTTP_UNPROCESSABLE_ENTITY : HTTP_SERVICE_UNAVAILABLE)
    .send({ message: INTERNAL_ROUTE_MESSAGES.memoryGenerationFailed, diagnostic });
}

function registerInternalMemoryRoute(app: FastifyInstance): void {
  app.post(
    "/internal/memory/generate",
    { preHandler: requireInternalSecret, bodyLimit: MEMORY_GENERATE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = memoryGenerationInputSchema
        .extend({ jobId: z.string().uuid(), leaseToken: z.string().uuid() })
        .safeParse(request.body);
      if (!parsed.success) {
        const diagnostic = memoryFailureDiagnostic(parsed.error, "input");
        request.log.warn({ diagnostic }, "Memory generation rejected");

        return reply
          .code(HTTP_BAD_REQUEST)
          .send({ message: INTERNAL_ROUTE_MESSAGES.invalidMemoryGenerationInput, diagnostic });
      }
      try {
        return await withMemoryRequestSignal({
          request,
          reply,
          operation: (signal) =>
            generateMeetingMemory({
              input: parsed.data,
              runner: createMemoryModelRunner({
                signal,
                authorization: {
                  jobId: parsed.data.jobId,
                  leaseToken: parsed.data.leaseToken,
                  ownerUserId: parsed.data.ownerUserId,
                  meetingId: parsed.data.meetingId,
                  historyMemoryIds: [
                    ...new Set(parsed.data.history.flatMap((person) => person.memories.map((memory) => memory.id))),
                  ],
                },
              }),
            }),
        });
      } catch (error) {
        return sendMemoryFailure({ request, reply, error, meetingId: parsed.data.meetingId });
      }
    },
  );
}

function registerInternalMeetingTitleRoute(app: FastifyInstance): void {
  app.post("/internal/meetings/:meetingId/title", { preHandler: requireInternalSecret }, async (request, reply) => {
    const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
    if (!routeParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
    }
    const { meetingId } = routeParams.data;
    const meetingTitleRequestSchema = summarizeMeetingRequestSchema.extend({
      meetingInProgress: z.boolean().default(false),
    });
    const bodyParsed = meetingTitleRequestSchema
      .omit({ /** @external zod omit field key */ meetingId: true })
      .safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
    }
    const parsed = meetingTitleRequestSchema.safeParse({
      ...bodyParsed.data,
      meetingId,
    });
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    try {
      return await generateMeetingTitle({
        meetingId,
        metering: parsed.data.metering ?? null,
        meetingInProgress: parsed.data.meetingInProgress,
      });
    } catch (error) {
      if (error instanceof MeetingTitleTranscriptRequired) {
        // Expected for a meeting with no human speech: answer 422, not 500.
        request.log.info({ meetingId }, "Meeting title skipped: no human transcript content");

        return reply
          .code(HTTP_UNPROCESSABLE_ENTITY)
          .send({ code: MEETING_TITLE_TRANSCRIPT_REQUIRED_CODE, message: error.message });
      }
      throw error;
    }
  });
}

function registerInternalMeetingSummaryRoutes(app: FastifyInstance): void {
  app.post("/internal/meetings/:meetingId/summarize", { preHandler: requireInternalSecret }, async (request, reply) => {
    const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
    if (!routeParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
    }
    const { meetingId } = routeParams.data;

    const bodyParsed = summarizeMeetingRequestSchema
      .omit({ /** @external zod omit field key */ meetingId: true })
      .safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
    }
    const parsed = summarizeMeetingRequestSchema.safeParse({
      ...bodyParsed.data,
      // The route param is authoritative; body fields must never override it.
      meetingId,
    });
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    const { summary, actionItems } = await generatePostCallArtifacts(meetingId);

    return {
      summary: {
        id: summary.id,
        meetingId: summary.meetingId,
        content: summary.content,
        model: summary.model,
        generatedAt: summary.generatedAt.toISOString(),
      },
      actionItems: actionItems.map((item) => ({
        id: item.id,
        meetingId: item.meetingId,
        text: item.text,
        assignee: item.assignee,
        status: item.status,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  });

  app.post("/internal/meetings/:meetingId/snapshot", { preHandler: requireInternalSecret }, async (request, reply) => {
    const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
    if (!routeParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
    }
    const { meetingId } = routeParams.data;

    const bodyParsed = summarizeMeetingRequestSchema
      .omit({ /** @external zod omit field key */ meetingId: true })
      .safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
    }
    const parsed = summarizeMeetingRequestSchema.safeParse({
      ...bodyParsed.data,
      // The route param is authoritative; body fields must never override it.
      meetingId,
    });
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    const snapshot = await generateMeetingSnapshot({
      meetingId,
      metering: parsed.data.metering ?? null,
    });

    return { snapshot };
  });
}

function registerInternalMeetingTaskRoutes(app: FastifyInstance): void {
  app.post("/internal/meetings/:meetingId/tasks", { preHandler: requireInternalSecret }, async (request, reply) => {
    const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
    if (!routeParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
    }
    const { meetingId } = routeParams.data;

    const bodyParsed = meetingTasksRequestSchema
      .omit({ /** @external zod omit field key */ meetingId: true })
      .safeParse(request.body);
    if (!bodyParsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
    }
    const parsed = meetingTasksRequestSchema.safeParse({
      ...bodyParsed.data,
      // The route param is authoritative; body fields must never override it.
      meetingId,
    });
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    request.log.info({ meetingId }, "Assistant meeting tasks request started");
    const startedAt = Date.now();
    const tasks = await generateMeetingTasks({
      meetingId,
      initialCandidates: parsed.data.initialCandidates,
      dismissedTombstones: parsed.data.dismissedTombstones,
      metering: parsed.data.metering ?? null,
    });
    request.log.info(
      {
        meetingId,
        taskCount: tasks.items.length,
        taskModel: tasks.taskModel,
        durationMs: Date.now() - startedAt,
        taskDiagnostics: tasks.diagnostics ?? null,
      },
      "Assistant meeting tasks request completed",
    );

    return { tasks };
  });
}

function registerInternalMeetingTaskChunkRoutes(app: FastifyInstance): void {
  app.post(
    "/internal/meetings/:meetingId/tasks/chunk",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;

      const bodyParsed = meetingTaskChunkRequestSchema
        .omit({ /** @external zod omit field key */ meetingId: true })
        .safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
      }
      const parsed = meetingTaskChunkRequestSchema.safeParse({
        ...bodyParsed.data,
        // The route param is authoritative; body fields must never override it.
        meetingId,
      });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      request.log.info(
        {
          meetingId,
          chunkIndex: parsed.data.chunkIndex,
          totalChunks: parsed.data.totalChunks,
          taskHintScore: parsed.data.taskHintScore,
          extractionMode: parsed.data.extractionMode,
        },
        "Assistant meeting task chunk request started",
      );
      const startedAt = Date.now();
      const tasks = await generateMeetingTaskChunk(parsed.data);
      request.log.info(
        {
          meetingId,
          chunkIndex: parsed.data.chunkIndex,
          taskCount: tasks.items.length,
          taskModel: tasks.taskModel,
          durationMs: Date.now() - startedAt,
          taskDiagnostics: tasks.diagnostics ?? null,
        },
        "Assistant meeting task chunk request completed",
      );

      return { tasks };
    },
  );

  app.post(
    "/internal/meetings/:meetingId/tasks/reconcile",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;

      const bodyParsed = meetingTaskReconciliationRequestSchema
        .omit({ /** @external zod omit field key */ meetingId: true })
        .safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
      }
      const parsed = meetingTaskReconciliationRequestSchema.safeParse({
        ...bodyParsed.data,
        // The route param is authoritative; body fields must never override it.
        meetingId,
      });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      request.log.info({ meetingId }, "Assistant meeting task reconciliation request started");
      const startedAt = Date.now();
      const tasks = await reconcileMeetingTasks(parsed.data);
      request.log.info(
        {
          meetingId,
          taskCount: tasks.items.length,
          taskModel: tasks.taskModel,
          durationMs: Date.now() - startedAt,
          taskDiagnostics: tasks.diagnostics ?? null,
        },
        "Assistant meeting task reconciliation request completed",
      );

      return { tasks };
    },
  );
}

function registerInternalLinearTaskReviewRoutes(app: FastifyInstance): void {
  app.post(
    "/internal/meetings/:meetingId/linear-task-review",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;
      const bodyParsed = linearTaskReviewClassificationRequestSchema
        .omit({ /** @external zod omit field key */ meetingId: true })
        .safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
      }
      const parsed = linearTaskReviewClassificationRequestSchema.safeParse({
        ...bodyParsed.data,
        // The route param is authoritative; body fields must never override it.
        meetingId,
      });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      return classifyLinearTasksWithModel(parsed.data);
    },
  );

  app.post(
    "/internal/linear-task-reviews/:runId/revise",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = runIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { runId } = routeParams.data;
      const bodyParsed = linearTaskReviewRevisionRequestSchema
        .omit({ /** @external zod omit field key */ runId: true })
        .safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
      }
      const parsed = linearTaskReviewRevisionRequestSchema.safeParse({
        runId,
        ...bodyParsed.data,
      });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      return reviseLinearTaskReviewWithModel(parsed.data);
    },
  );
}

function registerInternalMeetingExtractionRoutes(app: FastifyInstance): void {
  app.post("/internal/meetings/:meetingId/extract", { preHandler: requireInternalSecret }, async (request, reply) => {
    const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
    if (!routeParams.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
    }
    const { meetingId } = routeParams.data;

    const parsed = summarizeMeetingRequestSchema.safeParse({ meetingId });
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    request.log.info({ meetingId }, "Assistant content extraction request started");
    const extraction = await generateMeetingExtraction(meetingId);
    request.log.info(
      {
        meetingId,
        extractionId: extraction.id,
        contentStatus: extraction.contentStatus,
        signalsStatus: extraction.signalsStatus,
        actionItemCount: extraction.actionItems.length,
        decisionCount: extraction.decisions.length,
        failedToolCallCount: extraction.failedToolCalls.length,
      },
      "Assistant content extraction request completed",
    );

    return { extraction };
  });

  app.post(
    "/internal/meetings/:meetingId/extract-signals",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;

      const parsed = summarizeMeetingRequestSchema.safeParse({ meetingId });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      request.log.info({ meetingId }, "Assistant signal extraction request started");
      const extraction = await generateMeetingSignals(meetingId);
      request.log.info(
        {
          meetingId,
          extractionId: extraction.id,
          contentStatus: extraction.contentStatus,
          signalsStatus: extraction.signalsStatus,
          signalCount: extraction.signals.length,
          failedToolCallCount: extraction.failedToolCalls.length,
        },
        "Assistant signal extraction request completed",
      );

      return { extraction };
    },
  );
}

function registerInternalCapabilitySelectionRoutes(app: FastifyInstance): void {
  app.post(
    "/internal/extractions/:extractionId/select-capabilities",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = extractionIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { extractionId } = routeParams.data;

      const bodyParsed = selectCapabilitiesRequestSchema
        .omit({ /** @external zod omit field key */ extractionId: true })
        .safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: bodyParsed.error.message });
      }
      const parsed = selectCapabilitiesRequestSchema.safeParse({
        extractionId,
        ...bodyParsed.data,
      });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      request.log.info({ extractionId }, "Assistant capability selection request started");
      const selection = await generateCapabilitySelection(parsed.data);
      request.log.info(
        {
          extractionId,
          recommendationCount: selection.recommendations.length,
          consideredCount: selection.considered.length,
        },
        "Assistant capability selection request completed",
      );

      return selection;
    },
  );
}

function registerInternalCapabilityWorkflowRoutes(app: FastifyInstance): void {
  app.post(
    "/internal/capability-workflows/bug-report/plan-issues",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const parsed = bugReportIssuePlanningRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      request.log.info(
        { evidenceCount: parsed.data.evidenceBank.length },
        "Assistant bug report issue planning request started",
      );
      const plan = await planBugReportIssuesWithModel(parsed.data);
      request.log.info(
        {
          candidateCount: plan.candidates.length,
          skippedCandidateCount: plan.skippedCandidates.length,
        },
        "Assistant bug report issue planning request completed",
      );

      return plan;
    },
  );

  app.post(
    "/internal/capability-workflows/bug-report/revise-draft",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const parsed = bugReportDraftRevisionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      request.log.info(
        { issueCount: parsed.data.draft.issues.length, instructionLength: parsed.data.instruction.length },
        "Assistant bug report draft revision request started",
      );
      const revision = await reviseBugReportDraftWithModel(parsed.data);
      request.log.info(
        { issueCount: revision.draft.issues.length, operation: revision.operation },
        "Assistant bug report draft revision request completed",
      );

      return revision;
    },
  );

  app.post(
    "/internal/capability-workflows/meeting-coaching/generate-feedback",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const parsed = meetingCoachingGenerationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      request.log.info(
        {
          hasFocus: Boolean(parsed.data.focus?.trim()),
          hasPreviousFeedback: Boolean(parsed.data.previousFeedback),
        },
        "Assistant meeting coaching feedback request started",
      );
      const feedback = await generateMeetingCoachingFeedbackWithModel(parsed.data);
      request.log.info(
        {
          whatWorkedCount: feedback.feedback.whatWorked.length,
          improvementCount: feedback.feedback.whatToImprove.length,
          nextTimeCount: feedback.feedback.tryNextTime.length,
          followUpPromptCount: feedback.feedback.followUpPrompts.length,
        },
        "Assistant meeting coaching feedback request completed",
      );

      return feedback;
    },
  );
}

function registerInternalLiveKitRoutes(app: FastifyInstance): void {
  app.post("/internal/livekit-realtime/events", { preHandler: requireInternalSecret }, async (request, reply) => {
    const bodyParsed = fastifyRequestBodySchema.safeParse(request.body);
    const payloadParsed = liveKitRealtimeEventSchema.safeParse(request.body);
    try {
      if (!payloadParsed.success) {
        throw new Error(INTERNAL_ROUTE_MESSAGES.invalidLiveKitRealtimeEvent);
      }
      const result = await processLiveKitRealtimeEvent({ payload: payloadParsed.data });

      return {
        ...result,
        receivedAt: new Date().toISOString(),
      };
    } catch (error) {
      request.log.error(
        { error, body: bodyParsed.success ? bodyParsed.data : null },
        "Failed to process LiveKit realtime event",
      );

      return reply.code(HTTP_BAD_REQUEST).send({
        message: error instanceof Error ? error.message : INTERNAL_ROUTE_MESSAGES.invalidLiveKitRealtimeEvent,
      });
    }
  });
}

function registerInternalLiveMeetingRoutes(app: FastifyInstance): void {
  app.post(
    "/internal/meetings/:meetingId/live-transcription/start",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;
      const parsed = summarizeMeetingRequestSchema.safeParse({ meetingId });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      const result = await liveKitTranscriptionManager.startMeeting(meetingId);

      return {
        // @external ok
        ok: true,
        // @external started
        started: result.started,
      };
    },
  );

  app.post(
    "/internal/meetings/:meetingId/live-transcription/stop",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;
      const parsed = summarizeMeetingRequestSchema.safeParse({ meetingId });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      const result = await liveKitTranscriptionManager.stopMeeting({ meetingId });

      return {
        // @external ok
        ok: true,
        // @external stopped
        stopped: result.stopped,
        // @external finalized
        finalized: result.finalized,
      };
    },
  );

  app.post(
    "/internal/meetings/:meetingId/room-assistant/start",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;
      const parsed = summarizeMeetingRequestSchema.safeParse({ meetingId });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      const result = await liveKitRoomAssistantDispatchManager.startMeeting(meetingId);

      return {
        // @external ok
        ok: true,
        // @external started
        started: result.started,
      };
    },
  );

  app.post(
    "/internal/meetings/:meetingId/room-assistant/stop",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;
      const parsed = summarizeMeetingRequestSchema.safeParse({ meetingId });
      if (!parsed.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
      }

      const result = await liveKitRoomAssistantDispatchManager.stopMeeting(meetingId);

      return {
        // @external ok
        ok: true,
        // @external stopped
        stopped: result.stopped,
        // @external drained
        drained: result.drained,
      };
    },
  );
}

function registerInternalActionItemRoutes(app: FastifyInstance): void {
  app.get(
    "/internal/meetings/:meetingId/action-items",
    { preHandler: requireInternalSecret },
    async (request, reply) => {
      const routeParams = meetingIdRouteParamsSchema.safeParse(request.params);
      if (!routeParams.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: routeParams.error.message });
      }
      const { meetingId } = routeParams.data;
      const actionItems = await repositories().listActionItemsForMeeting(meetingId);

      return {
        actionItems: actionItems.map((item) => ({
          id: item.id,
          text: item.text,
          assignee: item.assignee,
          status: item.status,
        })),
      };
    },
  );
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof InsufficientAiCreditsError) {
      return reply.code(HTTP_PAYMENT_REQUIRED).send({ code: INSUFFICIENT_CREDITS_CODE, message: error.message });
    }
    throw error;
  });
  registerInternalMemoryRoute(app);
  registerInternalMeetingSummaryRoutes(app);
  registerInternalMeetingTitleRoute(app);
  registerInternalMeetingTaskRoutes(app);
  registerInternalMeetingTaskChunkRoutes(app);
  registerInternalLinearTaskReviewRoutes(app);
  registerInternalMeetingExtractionRoutes(app);
  registerInternalCapabilitySelectionRoutes(app);
  registerInternalCapabilityWorkflowRoutes(app);
  registerInternalLiveKitRoutes(app);
  registerInternalLiveMeetingRoutes(app);
  registerInternalActionItemRoutes(app);
}
