import {
  billingCheckoutConfirmationRequestSchema,
  billingCheckoutConfirmationResponseSchema,
  billingCheckoutRequestSchema,
  billingRedirectResponseSchema,
  billingSummaryResponseSchema,
  billingTopupRequestSchema,
  workspaceBillingSummaryResponseSchema,
  workspaceMemberBillingResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance } from "fastify";

import {
  confirmWorkspaceBillingCheckout,
  createBillingPortalSession,
  createTopupCheckoutSession,
  getBillingSummaryForUser,
  toBillingError,
} from "../../../secondary/stripe/stripe-billing";
import {
  createWorkspaceBillingPortalSession,
  createWorkspaceSubscriptionCheckoutSession,
  createWorkspaceTopupCheckoutSession,
  getWorkspaceBillingSummary,
  getWorkspaceMemberBillingView,
} from "../../../secondary/stripe/workspace-stripe-billing";
import { apiErrorResponse } from "../error-handler";
import { requireAuth } from "../plugins/auth";
import {
  getWorkspaceMembershipContext,
  requireActiveWorkspaceMember,
  requireWorkspaceOwner,
} from "../support/workspace-access";

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const WORKSPACE_CHECKOUT_REQUIRED_CODE = "workspace_checkout_required";
const MESSAGE_WORKSPACE_CHECKOUT_REQUIRED =
  "Choose Pro or Max from workspace billing so every active member receives the plan allowance.";

const MESSAGE_CHOOSE_MONTHLY_OR_YEARLY_PLAN = "Choose a monthly or yearly plan.";
const MESSAGE_ENTER_HOW_MANY_CREDITS_TO_BUY = "Enter how many credits to buy.";
const MESSAGE_A_VALID_CHECKOUT_SESSION_IS_REQUIRED = "A valid checkout session is required.";
const STRIPE_REQUEST_FAILED_LOG_MESSAGE = "Stripe request failed";

function requireBillingUserId(request: { user?: { id: string } }) {
  const user = request.user;
  if (!user) {
    throw new TypeError(String(user));
  }

  return user.id;
}

function registerMeBillingRoutes(app: FastifyInstance): void {
  app.get("/me/billing", { preHandler: requireAuth }, async (request) => {
    const billing = await getBillingSummaryForUser(requireBillingUserId(request));

    return billingSummaryResponseSchema.parse({ billing });
  });

  app.post("/me/billing/checkout", { preHandler: requireAuth }, async (request, reply) => {
    const body = billingCheckoutRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CHOOSE_MONTHLY_OR_YEARLY_PLAN });
    }

    return reply.code(HTTP_CONFLICT).send({
      code: WORKSPACE_CHECKOUT_REQUIRED_CODE,
      message: MESSAGE_WORKSPACE_CHECKOUT_REQUIRED,
    });
  });

  app.post("/me/billing/topup", { preHandler: requireAuth }, async (request, reply) => {
    const body = billingTopupRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_ENTER_HOW_MANY_CREDITS_TO_BUY });
    }

    const url = await createTopupCheckoutSession({
      userId: requireBillingUserId(request),
      credits: body.data.credits,
    });

    return billingRedirectResponseSchema.parse({ url });
  });

  app.post("/me/billing/portal", { preHandler: requireAuth }, async (request) => {
    const url = await createBillingPortalSession(requireBillingUserId(request));

    return billingRedirectResponseSchema.parse({ url });
  });
}

function registerWorkspaceBillingRoutes(app: FastifyInstance): void {
  app.get("/workspaces/:workspaceId/billing", { preHandler: requireWorkspaceOwner }, async (request) => {
    const membership = getWorkspaceMembershipContext(request);
    const billing = await getWorkspaceBillingSummary({
      workspaceId: membership.workspaceId,
      viewerUserId: requireBillingUserId(request),
    });

    return workspaceBillingSummaryResponseSchema.parse({ billing });
  });

  app.post(
    "/workspaces/:workspaceId/billing/checkout",
    { preHandler: requireWorkspaceOwner },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const body = billingCheckoutRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CHOOSE_MONTHLY_OR_YEARLY_PLAN });
      }

      const url = await createWorkspaceSubscriptionCheckoutSession({
        workspaceId: membership.workspaceId,
        actorUserId: requireBillingUserId(request),
        interval: body.data.interval,
        plan: body.data.plan,
      });

      return billingRedirectResponseSchema.parse({ url });
    },
  );

  app.post("/workspaces/:workspaceId/billing/topup", { preHandler: requireWorkspaceOwner }, async (request, reply) => {
    const membership = getWorkspaceMembershipContext(request);
    const body = billingTopupRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_ENTER_HOW_MANY_CREDITS_TO_BUY });
    }

    const url = await createWorkspaceTopupCheckoutSession({
      workspaceId: membership.workspaceId,
      actorUserId: requireBillingUserId(request),
      credits: body.data.credits,
    });

    return billingRedirectResponseSchema.parse({ url });
  });

  app.post("/workspaces/:workspaceId/billing/portal", { preHandler: requireWorkspaceOwner }, async (request) => {
    const membership = getWorkspaceMembershipContext(request);
    const url = await createWorkspaceBillingPortalSession(membership.workspaceId);

    return billingRedirectResponseSchema.parse({ url });
  });

  app.post(
    "/workspaces/:workspaceId/billing/checkout/confirm",
    { preHandler: requireWorkspaceOwner },
    async (request, reply) => {
      const membership = getWorkspaceMembershipContext(request);
      const body = billingCheckoutConfirmationRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_A_VALID_CHECKOUT_SESSION_IS_REQUIRED });
      }
      const result = await confirmWorkspaceBillingCheckout({
        workspaceId: membership.workspaceId,
        sessionId: body.data.sessionId,
        log: request.log,
      });

      return billingCheckoutConfirmationResponseSchema.parse(result);
    },
  );

  // Any active member may read their own allowance/pool view.
  app.get("/workspaces/:workspaceId/billing/me", { preHandler: requireActiveWorkspaceMember }, async (request) => {
    const membership = getWorkspaceMembershipContext(request);
    const billing = await getWorkspaceMemberBillingView({
      workspaceId: membership.workspaceId,
      userId: requireBillingUserId(request),
    });

    return workspaceMemberBillingResponseSchema.parse({ billing });
  });
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // One mapping for every billing route: Stripe SDK failures become a generic 502, BillingErrors keep their status.
  app.setErrorHandler((error, request, reply) => {
    const billingError = toBillingError(error);
    if (billingError !== undefined && billingError !== error) {
      request.log.error({ err: error }, STRIPE_REQUEST_FAILED_LOG_MESSAGE);
    }

    return apiErrorResponse({ error: billingError ?? error, request, reply });
  });
  registerMeBillingRoutes(app);
  // --- Workspace-subject billing (owner-managed) -----------------------------
  registerWorkspaceBillingRoutes(app);
}
