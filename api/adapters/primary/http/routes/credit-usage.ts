import {
  getPrivateBetaWaitlistResponseSchema,
  joinPrivateBetaWaitlistResponseSchema,
  meetingAccessResponseSchema,
  userCreditUsageResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance } from "fastify";

import { grantCurrentMonthCredits, isStripeConfigured } from "../../../../ports/gate-stripe-billing";
import { repositories } from "../../../../ports/repository-runtime";
import { requireAuth } from "../plugins/auth";
import { getMeetingHostingAccessForUser } from "../support/meeting-access";

const HTTP_UNAUTHORIZED_STATUS = 401;
const CREDIT_USAGE_UNAUTHORIZED_MESSAGE = "Unauthorized.";

function formatWaitlistEntry(entry: { id: string; userId: string; requestedAt: Date; updatedAt: Date }) {
  return {
    id: entry.id,
    userId: entry.userId,
    requestedAt: entry.requestedAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export async function creditUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me/credit-usage", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED_STATUS).send({ message: CREDIT_USAGE_UNAUTHORIZED_MESSAGE });
    }

    if (isStripeConfigured()) {
      const subscriptions = await repositories().getRunningBillingSubscriptions();
      const subscription = subscriptions.find((item) => item.userId === user.id);
      if (subscription !== undefined) {
        await grantCurrentMonthCredits({
          userId: user.id,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          planInterval: subscription.planInterval === "year" ? "year" : "month",
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
        });
      }
    }

    const usage = await repositories().getUserCreditUsageData({
      userId: user.id,
    });

    return userCreditUsageResponseSchema.parse({ usage });
  });

  app.get("/me/meeting-access", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED_STATUS).send({ message: CREDIT_USAGE_UNAUTHORIZED_MESSAGE });
    }

    const meetingAccess = await getMeetingHostingAccessForUser(user.id);

    return meetingAccessResponseSchema.parse({ meetingAccess });
  });

  app.get("/me/waitlist", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED_STATUS).send({ message: CREDIT_USAGE_UNAUTHORIZED_MESSAGE });
    }

    const entry = await repositories().getPrivateBetaWaitlistEntryForUser(user.id);

    return getPrivateBetaWaitlistResponseSchema.parse({
      waitlistEntry: entry !== null ? formatWaitlistEntry(entry) : null,
    });
  });

  app.post("/me/waitlist", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED_STATUS).send({ message: CREDIT_USAGE_UNAUTHORIZED_MESSAGE });
    }

    const entry = await repositories().upsertPrivateBetaWaitlistEntry({
      userId: user.id,
      metadata: {
        source: "meet_plan_gate",
      },
    });

    return joinPrivateBetaWaitlistResponseSchema.parse({
      waitlistEntry: formatWaitlistEntry(entry),
    });
  });
}
