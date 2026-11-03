import {
  adminAiUsageEventsResponseSchema,
  adminAiUsageSummaryResponseSchema,
  adminOverviewResponseSchema,
  updateAdminUserPlanRequestSchema,
  updateAdminUserPlanResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { apiEnv } from "../../../../composition/env";
import { repositories } from "../../../../ports/repository-runtime";
import { listLiveKitRoomNames } from "../../../secondary/livekit/livekit";
import { requireAdmin } from "../plugins/auth";

const MICRO_USD_PER_USD = 1_000_000;
const ADMIN_AI_USAGE_MAX_LIMIT = 250;

const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_NOT_FOUND = 404;

const ADMIN_ROUTE_MESSAGES = {
  liveKitRoomStatusUnavailable: "LiveKit room status could not be checked.",
  fixedInfraCostMissing: "Fixed infra monthly cost is not configured.",
  transcriptionCostMissing: "Transcription per-minute cost is not configured.",
  liveKitOverageCostMissing: "LiveKit participant-minute overage cost is not configured.",
  liveKitQuotaMissing: "LiveKit included participant-minute quota is not configured.",
  unconfiguredPricingEvents: "Some usage events were recorded without configured pricing.",
  unauthorized: "Unauthorized",
  userNotFound: "User not found",
  invalidAiUsageQuery: "Invalid AI usage filters. Dates must be ISO 8601 timestamps.",
} as const;

function usdToMicroUsd(value: number): number {
  return Math.max(0, Math.round(value * MICRO_USD_PER_USD));
}

const adminAiUsageQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  actionType: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(ADMIN_AI_USAGE_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(["date", "cost", "credits", "revenue", "profit", "margin"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});

const adminUserParamsSchema = z.object({
  userId: z.string().uuid(),
});

const adminOverviewOpenRoomSchema = z
  .object({
    roomName: z.string(),
  })
  .passthrough();

const adminOverviewOpenRoomsSchema = z.array(adminOverviewOpenRoomSchema);

function parseAdminOverviewOpenRooms(value: unknown): z.infer<typeof adminOverviewOpenRoomSchema>[] {
  return adminOverviewOpenRoomsSchema.parse(value);
}

type AdminAiUsageQuery = {
  startDate: Date | null;
  endDate: Date | null;
  actionType?: string;
  model?: string;
  limit?: number;
  offset?: number;
  sort?: "date" | "cost" | "credits" | "revenue" | "profit" | "margin";
  direction?: "asc" | "desc";
};

/** Null when a filter is malformed (for example a date that is not ISO 8601); the caller answers 400. */
function parseAdminAiUsageQuery(query: unknown): AdminAiUsageQuery | null {
  const result = adminAiUsageQuerySchema.safeParse(query ?? {});
  if (!result.success) {
    return null;
  }
  const parsed = result.data;

  return {
    ...parsed,
    startDate: parsed.startDate !== undefined ? new Date(parsed.startDate) : null,
    endDate: parsed.endDate !== undefined ? new Date(parsed.endDate) : null,
  };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/overview", { preHandler: requireAdmin }, async (request) => {
    const overview = await repositories().getAdminOverviewData({
      fixedInfraMonthlyCostMicroUsd: usdToMicroUsd(apiEnv.ADMIN_FIXED_INFRA_MONTHLY_USD),
      liveKitIncludedParticipantMinutes: apiEnv.ADMIN_LIVEKIT_INCLUDED_PARTICIPANT_MINUTES,
      liveKitParticipantMinuteCostMicroUsd: usdToMicroUsd(apiEnv.ADMIN_LIVEKIT_PARTICIPANT_MINUTE_USD),
    });

    const liveKitRoomNames = await (async (): Promise<Set<string> | null> => {
      try {
        return await listLiveKitRoomNames();
      } catch (error: unknown) {
        request.log.warn({ error }, "Unable to list LiveKit rooms for admin overview");

        return null;
      }
    })();
    const warnings = [
      ...(liveKitRoomNames === null ? [ADMIN_ROUTE_MESSAGES.liveKitRoomStatusUnavailable] : []),
      ...(apiEnv.ADMIN_FIXED_INFRA_MONTHLY_USD === 0 ? [ADMIN_ROUTE_MESSAGES.fixedInfraCostMissing] : []),
      ...(apiEnv.ADMIN_TRANSCRIPTION_AUDIO_MINUTE_USD === 0 ? [ADMIN_ROUTE_MESSAGES.transcriptionCostMissing] : []),
      ...(apiEnv.ADMIN_LIVEKIT_PARTICIPANT_MINUTE_USD === 0 ? [ADMIN_ROUTE_MESSAGES.liveKitOverageCostMissing] : []),
      ...(apiEnv.ADMIN_LIVEKIT_INCLUDED_PARTICIPANT_MINUTES === 0 ? [ADMIN_ROUTE_MESSAGES.liveKitQuotaMissing] : []),
      ...(overview.costCategories.some((category) => category.unconfiguredEventCount > 0)
        ? [ADMIN_ROUTE_MESSAGES.unconfiguredPricingEvents]
        : []),
    ];

    const openRooms = parseAdminOverviewOpenRooms(overview.openRooms);

    return adminOverviewResponseSchema.parse({
      overview: {
        ...overview,
        openRooms: openRooms.map((room) => ({
          ...room,
          livekitStatus: liveKitRoomNames ? (liveKitRoomNames.has(room.roomName) ? "open" : "closed") : "unknown",
        })),
        warnings,
      },
    });
  });

  app.get("/admin/ai-usage/summary", { preHandler: requireAdmin }, async (request, reply) => {
    const query = parseAdminAiUsageQuery(request.query);
    if (query === null) {
      return reply.code(HTTP_STATUS_BAD_REQUEST).send({ message: ADMIN_ROUTE_MESSAGES.invalidAiUsageQuery });
    }
    const summary = await repositories().getAdminAiUsageSummaryData(query);

    return adminAiUsageSummaryResponseSchema.parse({ summary });
  });

  app.get("/admin/ai-usage/events", { preHandler: requireAdmin }, async (request, reply) => {
    const query = parseAdminAiUsageQuery(request.query);
    if (query === null) {
      return reply.code(HTTP_STATUS_BAD_REQUEST).send({ message: ADMIN_ROUTE_MESSAGES.invalidAiUsageQuery });
    }
    const data = await repositories().getAdminAiUsageEventsData(query);

    return adminAiUsageEventsResponseSchema.parse(data);
  });

  app.patch("/admin/users/:userId/plan", { preHandler: requireAdmin }, async (request, reply) => {
    const params = adminUserParamsSchema.safeParse(request.params);
    const body = updateAdminUserPlanRequestSchema.safeParse(request.body);
    if (!params.success) {
      return reply.code(HTTP_STATUS_BAD_REQUEST).send({ message: params.error.message });
    }
    if (!body.success) {
      return reply.code(HTTP_STATUS_BAD_REQUEST).send({ message: body.error.message });
    }
    const actorUserId = request.user?.id;
    if (actorUserId === undefined) {
      return reply.code(HTTP_STATUS_UNAUTHORIZED).send({ message: ADMIN_ROUTE_MESSAGES.unauthorized });
    }

    const user = await repositories().updateUserPlanByAdmin({
      actorUserId,
      targetUserId: params.data.userId,
      plan: body.data.plan,
    });
    if (user === null) {
      return reply.code(HTTP_STATUS_NOT_FOUND).send({ message: ADMIN_ROUTE_MESSAGES.userNotFound });
    }

    return updateAdminUserPlanResponseSchema.parse({ user });
  });
}
