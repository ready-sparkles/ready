import { InsufficientAiCreditsError } from "@readymeet/db/domain/persistence-errors";
import {
  calculatePlanCredits,
  type CreditPlan,
  FREE_PLAN_INCLUDED_NOTES_MEETINGS,
  hasPrivateBetaUnlimitedCredits,
  maximumOpenAITextInputTokens,
  MIN_CREDIT_FITTED_OUTPUT_TOKENS,
  spendableAiCredits,
} from "@readymeet/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { assistantEnv } from "../ports/assistant-env";
import {
  type OpenAIClient,
  type OpenAIMeteringContext,
  type OpenAIModelResponse,
  type OpenAIProviderBounds,
  OpenAIUsageSettlementError,
} from "../ports/openai-client";
import { repositories } from "../ports/repository-runtime";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_TOO_LARGE = 413;
const HTTP_RATE_LIMIT = 429;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const DEFINITIVE_REJECTION_STATUSES = new Set([
  HTTP_BAD_REQUEST,
  HTTP_UNAUTHORIZED,
  HTTP_PAYMENT_REQUIRED,
  HTTP_TOO_LARGE,
  HTTP_RATE_LIMIT,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_UNPROCESSABLE_ENTITY,
]);
const providerRejectionSchema = z.object({
  name: z.literal("OpenAIResponsesRequestFailed"),
  status: z.number(),
  hasProviderUsage: z.literal(false),
});

const noDispatchSchema = z.object({ isProviderRequestDispatched: z.literal(false) });
const providerBoundsSchema = z.object({
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().safe(),
  maxOutputTokens: z.number().int().positive().safe(),
});

const modelPriceSchema = z.object({
  inputPerMillion: z.number().finite().nonnegative().optional(),
  cacheWritePerMillion: z.number().finite().nonnegative().optional(),
  cachedInputPerMillion: z.number().finite().nonnegative().optional(),
  outputPerMillion: z.number().finite().nonnegative().optional(),
  totalPerMillion: z.number().finite().nonnegative().optional(),
  // Verified provider context ceiling, not an estimate from serialized prompt bytes.
  maxContextTokens: z.number().int().positive().safe(),
  longContext: z
    .object({
      thresholdTokens: z.number().int().positive().safe(),
      inputMultiplier: z.number().finite().min(1),
      outputMultiplier: z.number().finite().min(1),
    })
    .optional(),
});

type OpenAIUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
};

export type ModelPrice = z.infer<typeof modelPriceSchema>;

function parseOpenAIModelPrice(model: string): ModelPrice | undefined {
  try {
    const prices = z.record(z.unknown()).parse(JSON.parse(assistantEnv().OPENAI_MODEL_PRICES_JSON));
    const parsed = modelPriceSchema.safeParse(prices[model]);

    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return undefined;
    }
    throw error;
  }
}

function calculateCostMicroUsd(params: { price: ModelPrice; usage: OpenAIUsage }): number {
  const { price, usage } = params;
  if (price.totalPerMillion !== undefined) {
    return Math.ceil(usage.totalTokens * price.totalPerMillion);
  }
  const tier = price.longContext;
  const isLongContext = tier !== undefined && usage.inputTokens > tier.thresholdTokens;
  const inputMultiplier = isLongContext ? tier.inputMultiplier : 1;
  const outputMultiplier = isLongContext ? tier.outputMultiplier : 1;
  const freshInputTokens = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
  // USD per million tokens is numerically micro-USD per token.
  const inputCost =
    freshInputTokens * (price.inputPerMillion ?? 0) +
    usage.cachedInputTokens * (price.cachedInputPerMillion ?? price.inputPerMillion ?? 0) +
    usage.cacheWriteInputTokens * (price.cacheWritePerMillion ?? 0);

  return Math.ceil(inputCost * inputMultiplier + usage.outputTokens * (price.outputPerMillion ?? 0) * outputMultiplier);
}

const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const ACTION_TYPES: Record<string, string> = {
  meeting_snapshot: "meeting_snapshot",
  meeting_tasks: "meeting_action_items",
  meeting_title: "meeting_summary",
  meeting_extraction: "meeting_summary",
  meeting_summary: "meeting_summary",
  capability_selection: "agent_workflow",
  relationship_memory: "agent_workflow",
  linear_task_review: "linear_issue_drafting",
};

const METERING_MESSAGES = {
  activeMemberRequired: "Active workspace member required for AI usage.",
  invalidCachedUsage: "Invalid cached token usage.",
  cacheWriteRateRequired: "Missing cache write tariff.",
  unsupportedModality: "Unbounded or unsupported OpenAI request modality.",
  unsupportedInput: "Unsupported OpenAI input modality.",

  rateRequired: (model: string) => `OpenAI model rate is not configured: ${model}`,
  meetingRequired: "Meeting not found for AI usage admission.",
  workflowRequired: "Workflow not found for AI usage admission.",
  memoryRequired: "Valid memory authorization is required for AI usage admission.",
  unknownSource: (source: string) => `Unknown assistant AI usage source: ${source}`,
  invalidEstimate: "Invalid AI admission estimate.",
  invalidBounds: "Invalid counted OpenAI request bounds.",
  missingAdmission: "Counted OpenAI response did not complete admission.",
  usageExceedsBounds: "OpenAI usage exceeds reserved token bounds.",
};

type MeteringScope = {
  userId: string;
  workspaceId: string;
  meetingId: string;
  actionType: string;
  isIncluded: boolean;
  /** Billing plan and spendable balance used to fit a charged request into the credits on hand. */
  creditPlan: CreditPlan | null;
  availableCredits: number;
};

function memoryBillingOwner(input: OpenAIMeteringContext & { fallbackUserId: string }): string {
  if (input.source !== "relationship_memory") {
    return input.fallbackUserId;
  }
  const authorization = input.memoryAuthorization;
  if (
    authorization === undefined ||
    authorization.meetingId !== input.meetingId ||
    (input.jobId !== undefined && input.jobId !== null) ||
    (input.workflowRunId !== undefined && input.workflowRunId !== null)
  ) {
    throw new Error(METERING_MESSAGES.memoryRequired);
  }

  return authorization.ownerUserId;
}

function meteringActionType(input: OpenAIMeteringContext & { capabilityKey?: string }): string {
  const actionType =
    input.source === "capability_workflow"
      ? input.capabilityKey === "meeting_coaching" || input.operation === "meeting_coaching_feedback"
        ? "coaching_feedback"
        : "agent_workflow"
      : ACTION_TYPES[input.source];
  if (actionType === undefined) {
    throw new Error(METERING_MESSAGES.unknownSource(input.source));
  }

  return actionType;
}

async function resolveMeteringScope(input: OpenAIMeteringContext): Promise<MeteringScope> {
  const meetingId = z.string().min(1).parse(input.meetingId);
  const meeting = await repositories().getMeetingById(meetingId);
  if (meeting === null) {
    throw new Error(METERING_MESSAGES.meetingRequired);
  }
  const workflowRunId = input.workflowRunId ?? null;
  const workflow = workflowRunId === null ? null : await repositories().getCapabilityWorkflowRunById(workflowRunId);
  if (workflowRunId !== null && (workflow === null || workflow.meetingId !== meetingId)) {
    throw new Error(METERING_MESSAGES.workflowRequired);
  }
  const requester = z
    .object({ userId: z.string().min(1) })
    .optional()
    .parse(workflow?.context.requester);
  if (input.source === "capability_workflow" && (!workflow || !requester)) {
    throw new Error(METERING_MESSAGES.workflowRequired);
  }
  const userId = z
    .string()
    .min(1)
    .parse(memoryBillingOwner({ ...input, fallbackUserId: requester?.userId ?? meeting.createdByUserId }));
  const workspaceId = await repositories().getMeetingAttendeeWorkspace({
    meetingId,
    userId,
    hostWorkspaceId: meeting.workspaceId,
  });
  const actionType = meteringActionType({ ...input, capabilityKey: workflow?.capabilityKey });
  const policy = await resolveBillingPolicy({ userId, workspaceId, meeting });

  return { userId, workspaceId, meetingId, actionType, ...policy };
}

async function resolveBillingPolicy(input: {
  userId: string;
  workspaceId: string;
  meeting: { id: string; kind: string; createdByUserId: string };
}): Promise<Pick<MeteringScope, "isIncluded" | "creditPlan" | "availableCredits">> {
  const { userId, workspaceId, meeting } = input;
  const meetingId = meeting.id;
  const [workspace, membership, user, hasPrivateBeta, access] = await Promise.all([
    repositories().getWorkspaceById(workspaceId),
    repositories().getWorkspaceMembership({ workspaceId, userId }),
    repositories().getUserById(userId),
    repositories().hasPrivateBetaProCreditEntitlement(userId),
    repositories().getWorkspaceMemberCreditAccess({ workspaceId, userId }),
  ]);
  if (!workspace || membership?.status !== "active" || !user || user.deletedAt !== null) {
    throw new Error(METERING_MESSAGES.activeMemberRequired);
  }
  const isFreeMeeting =
    workspace.plan === "free" &&
    !access.subscriptionActive &&
    (meeting.kind !== "standard" ||
      meeting.createdByUserId !== userId ||
      (await repositories().countOtherHostedTrialMeetings({ userId, meetingId, workspaceId })) <
        FREE_PLAN_INCLUDED_NOTES_MEETINGS);
  const isIncluded =
    hasPrivateBetaUnlimitedCredits({
      hasPrivateBetaProEntitlement: hasPrivateBeta,
      isWorkspaceSubscriptionActive: access.subscriptionActive,
    }) || isFreeMeeting;
  const creditPlan = workspace.plan === "pro" || workspace.plan === "max" ? workspace.plan : null;
  if (!isIncluded && creditPlan === null) {
    // The internal routes answer this with 402 insufficient_credits, which the API passes on.
    throw new InsufficientAiCreditsError();
  }

  return {
    isIncluded,
    creditPlan,
    availableCredits: spendableAiCredits({
      allowanceRemaining: access.allowanceRemaining,
      poolBalance: access.poolBalance,
    }),
  };
}

function normalizedUsage(input: { response: OpenAIModelResponse; price: ModelPrice | undefined }): OpenAIUsage {
  const { response, price } = input;
  const normalized = z
    .object({
      inputTokens: z.number().int().nonnegative().safe(),
      outputTokens: z.number().int().nonnegative().safe(),
      cachedInputTokens: z.number().int().nonnegative().safe().optional(),
      cacheWriteInputTokens: z.number().int().nonnegative().safe().optional(),
    })
    .parse(response.totalUsage);
  if ((normalized.cachedInputTokens ?? 0) + (normalized.cacheWriteInputTokens ?? 0) > normalized.inputTokens) {
    throw new Error(METERING_MESSAGES.invalidCachedUsage);
  }
  if (price !== undefined && (normalized.cacheWriteInputTokens ?? 0) > 0 && price.cacheWritePerMillion === undefined) {
    throw new Error(METERING_MESSAGES.cacheWriteRateRequired);
  }

  return {
    ...normalized,
    cacheWriteInputTokens: normalized.cacheWriteInputTokens ?? 0,
    cachedInputTokens: normalized.cachedInputTokens ?? 0,
    totalTokens: normalized.inputTokens + normalized.outputTokens,
  };
}

function validateUsageBounds(input: { usage: OpenAIUsage; bounds: OpenAIProviderBounds | undefined }): void {
  if (
    input.bounds !== undefined &&
    (input.usage.inputTokens > input.bounds.inputTokens || input.usage.outputTokens > input.bounds.maxOutputTokens)
  ) {
    throw new Error(METERING_MESSAGES.usageExceedsBounds);
  }
}

async function settleOpenAIResponse(
  input: OpenAIMeteringContext & {
    scope: MeteringScope;
    model: string;
    price: ModelPrice | undefined;
    response: OpenAIModelResponse;
    executionId: string;
    reservationId?: string;
    bounds?: OpenAIProviderBounds;
    /** False records the usage but releases the hold: Ready absorbs discarded output. */
    isCharged?: boolean;
  },
): Promise<void> {
  const { response, model, price, executionId } = input;
  const isCharged = input.isCharged ?? true;
  const { userId, meetingId } = input.scope;
  const usage = normalizedUsage({ response, price });
  validateUsageBounds({ usage, bounds: input.bounds });
  const responseId = response.id;
  const usageIdempotencyKey = `openai:${responseId ?? executionId}:${input.source}`;
  // Raw usage requires a numeric cost; unavailable pricing is not a priced zero.
  const cost = price === undefined ? 0 : calculateCostMicroUsd({ price, usage });
  const metadata = {
    ...(input.source === "relationship_memory" ? { memoryJobId: input.memoryAuthorization?.jobId } : {}),
    reservationId: input.reservationId ?? null,
    operation: input.operation ?? input.source,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    totalTokens: usage.totalTokens,
    // @external rateConfigured
    rateConfigured: price !== undefined,
    price: price ?? null,
    ...(isCharged ? {} : { isCharged: false }),
  };
  await repositories().recordUsageEvent({
    userId,
    meetingId,
    jobId: input.jobId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    provider: "openai",
    category: "llm",
    model,
    sku: model,
    unitCount: usage.totalTokens,
    unitType: "token",
    unitPriceMicroUsd: null,
    costMicroUsd: cost,
    source: input.source,
    idempotencyKey: usageIdempotencyKey,
    metadata,
  });
  await resolvePlanCreditHold({ ...input, usage, cost, isCharged });
}

/** Charges the response's hold, or releases it when the response is unpriced or not charged. */
async function resolvePlanCreditHold(
  input: OpenAIMeteringContext & {
    scope: MeteringScope;
    model: string;
    price: ModelPrice | undefined;
    reservationId?: string;
    usage: ReturnType<typeof normalizedUsage>;
    cost: number;
    isCharged: boolean;
  },
): Promise<void> {
  const { reservationId, scope, usage } = input;
  if (reservationId === undefined) {
    return;
  }
  if (input.price === undefined || !input.isCharged) {
    await repositories().releasePlanCredits({ reservationId, ...scope });

    return;
  }
  await repositories().settlePlanCredits({
    reservationId,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    provider: "openai",
    model: input.model,
    feature: input.operation ?? input.source,
    meetingId: scope.meetingId,
    actionType: scope.actionType,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    providerCostMicroUsd: input.cost,
  });
}

// Only local function tools and text/reasoning history have token-only pricing.
function validateTextRequest(body: Record<string, unknown>): void {
  if (body.service_tier !== undefined && body.service_tier !== "default") {
    throw new Error(METERING_MESSAGES.unsupportedModality);
  }
  const tools = body.tools;
  if (tools !== undefined) {
    z.array(z.object({ type: z.literal("function") })).parse(tools);
  }
  if (body.previous_response_id !== undefined || body.conversation !== undefined || body.audio !== undefined) {
    throw new Error(METERING_MESSAGES.unsupportedModality);
  }
  if (typeof body.input === "string") {
    return;
  }
  const items = z.array(z.record(z.unknown())).parse(body.input);
  items.forEach((item) => {
    if (item.type === "function_call") {
      z.string().parse(item.arguments);

      return;
    }
    if (item.type === "function_call_output") {
      z.string().parse(item.output);

      return;
    }
    if (item.type === "reasoning") {
      return;
    }
    if (item.type !== undefined && item.type !== "message") {
      throw new Error(METERING_MESSAGES.unsupportedInput);
    }
    if (typeof item.content !== "string") {
      z.array(z.object({ type: z.enum(["input_text", "output_text"]), text: z.string() })).parse(item.content);
    }
  });
}

function requestModelPrice(input: {
  model: string;
  requestBody: Record<string, unknown>;
  shouldRequirePricing: boolean;
}): ModelPrice | undefined {
  const { model, requestBody, shouldRequirePricing } = input;
  const price = parseOpenAIModelPrice(model);
  if (
    price === undefined ||
    (price.totalPerMillion === undefined &&
      (price.inputPerMillion === undefined || price.outputPerMillion === undefined)) ||
    (price.totalPerMillion !== undefined && price.longContext !== undefined) ||
    (price.maxContextTokens > LONG_CONTEXT_THRESHOLD_TOKENS && price.longContext === undefined)
  ) {
    if (shouldRequirePricing) {
      throw new Error(METERING_MESSAGES.rateRequired(model));
    }

    return undefined;
  }
  const hasCacheWritePricing = /^(?:openai\/)?gpt-(?:5\.[6-9](?:\D|$)|[6-9](?:\D|$))/.test(model);
  if (
    (requestBody.prompt_cache_options !== undefined || hasCacheWritePricing) &&
    price.cacheWritePerMillion === undefined
  ) {
    if (shouldRequirePricing) {
      throw new Error(METERING_MESSAGES.cacheWriteRateRequired);
    }

    return undefined;
  }

  return price;
}

function boundedRequest(input: { requestBody: Record<string, unknown>; shouldRequirePricing: boolean }): {
  model: string;
  price: ModelPrice | undefined;
  body: Record<string, unknown>;
  maxOutputTokens: number;
} {
  const { requestBody } = input;
  const model = z.string().min(1).parse(requestBody.model);
  validateTextRequest(requestBody);
  const price = requestModelPrice({ ...input, model });
  const body = { ...requestBody, max_output_tokens: requestBody.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS };
  const maxOutputTokens = z
    .number()
    .int()
    .positive()
    .safe()
    .max(price?.maxContextTokens ?? Number.MAX_SAFE_INTEGER)
    .parse(body.max_output_tokens);

  return { model, price, body, maxOutputTokens };
}

function estimateRequest(input: {
  price: ModelPrice | undefined;
  inputTokens: number;
  maxOutputTokens: number;
}): number {
  const { price, inputTokens, maxOutputTokens } = input;
  if (price === undefined) {
    return 0;
  }
  const estimate = calculateCostMicroUsd({
    price: {
      ...price,
      inputPerMillion: Math.max(
        ...[price.inputPerMillion, price.cachedInputPerMillion, price.cacheWritePerMillion].map((rate) => rate ?? 0),
      ),
      cachedInputPerMillion: undefined,
    },
    usage: {
      inputTokens,
      outputTokens: maxOutputTokens,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: inputTokens + maxOutputTokens,
    },
  });
  if (!Number.isSafeInteger(estimate)) {
    throw new Error(METERING_MESSAGES.invalidEstimate);
  }

  return estimate;
}

const BINARY_SEARCH_HALVES = 2;

/**
 * Largest output budget whose worst-case hold fits the spendable credits, so a
 * small top-up still runs a request instead of being refused for a hold sized
 * to the model's full output ceiling. Returns the requested budget when it
 * already fits, or when even the floor does not (the reservation then refuses).
 */
export function creditFittedMaxOutputTokens(input: {
  price: ModelPrice;
  plan: CreditPlan;
  inputTokens: number;
  requestedMaxOutputTokens: number;
  availableCredits: number;
  /** Floor for this request; defaults to MIN_CREDIT_FITTED_OUTPUT_TOKENS. */
  minimumOutputTokens?: number;
}): number {
  const creditsFor = (maxOutputTokens: number) =>
    calculatePlanCredits({
      providerCostMicroUsd: estimateRequest({ price: input.price, inputTokens: input.inputTokens, maxOutputTokens }),
      plan: input.plan,
      isIncluded: false,
    });
  const requested = input.requestedMaxOutputTokens;
  if (creditsFor(requested) <= input.availableCredits) {
    return requested;
  }
  const floor = Math.min(requested, input.minimumOutputTokens ?? MIN_CREDIT_FITTED_OUTPUT_TOKENS);
  if (creditsFor(floor) > input.availableCredits) {
    return requested;
  }

  return largestFittingTokens({
    fits: floor,
    exceeds: requested,
    isAffordable: (maxOutputTokens) => creditsFor(maxOutputTokens) <= input.availableCredits,
  });
}

/** Binary search over a budget whose cost only grows with its size. */
function largestFittingTokens(input: {
  fits: number;
  exceeds: number;
  isAffordable: (maxOutputTokens: number) => boolean;
}): number {
  if (input.exceeds - input.fits <= 1) {
    return input.fits;
  }
  const middle = input.fits + Math.floor((input.exceeds - input.fits) / BINARY_SEARCH_HALVES);

  return input.isAffordable(middle)
    ? largestFittingTokens({ ...input, fits: middle })
    : largestFittingTokens({ ...input, exceeds: middle });
}

async function reserveOpenAIUsage(
  input: OpenAIMeteringContext & {
    scope: MeteringScope;
    estimate: number;
    model: string;
    price: ModelPrice | undefined;
    executionId: string;
    bounds?: OpenAIProviderBounds;
  },
): Promise<{ id: string } | null> {
  const { scope, estimate, model, price, executionId } = input;
  const feature = input.operation ?? input.source;

  return repositories().reservePlanCredits({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    maximumCostMicroUsd: estimate,
    isIncluded: scope.isIncluded,
    metadata: {
      provider: "openai",
      model,
      feature,
      meetingId: scope.meetingId,
      actionType: scope.actionType,
      jobId: input.jobId ?? null,
      workflowRunId: input.workflowRunId ?? null,
      memoryJobId: input.memoryAuthorization?.jobId ?? null,
      executionId,
      price,
      ...(input.bounds !== undefined
        ? { inputTokens: input.bounds.inputTokens, maxOutputTokens: input.bounds.maxOutputTokens }
        : {}),
    },
  });
}

const failedProviderResponseSchema = z.object({
  providerResponse: z
    .object({
      usage: z.unknown().optional(),
      totalUsage: z
        .object({
          inputTokens: z.number().optional(),
          outputTokens: z.number().optional(),
          cachedInputTokens: z.number().optional(),
          cacheWriteInputTokens: z.number().optional(),
        })
        .transform((usage) => ({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
        }))
        .optional(),
    })
    .passthrough(),
});

async function releaseDefinitiveRejection(
  input: OpenAIMeteringContext & {
    model: string;
    price: ModelPrice | undefined;
    executionId: string;
    bounds?: OpenAIProviderBounds;
    error: unknown;
    reservationId?: string;
    scope: MeteringScope;
  },
): Promise<void> {
  const failed = failedProviderResponseSchema.safeParse(input.error);
  if (
    failed.success &&
    (failed.data.providerResponse.totalUsage !== undefined || failed.data.providerResponse.usage !== undefined)
  ) {
    await settleOpenAIResponse({ ...input, response: failed.data.providerResponse });

    return;
  }
  const rejection = providerRejectionSchema.safeParse(input.error);
  if (
    input.reservationId !== undefined &&
    (noDispatchSchema.safeParse(input.error).success ||
      (rejection.success && DEFINITIVE_REJECTION_STATUSES.has(rejection.data.status)))
  ) {
    await repositories().releasePlanCredits({ reservationId: input.reservationId, ...input.scope });
  }
  // Unknown outcomes or any usage evidence retain their hold for reconciliation.
}

async function authorizeDispatch(input: OpenAIMeteringContext & { signal?: AbortSignal }): Promise<void> {
  input.signal?.throwIfAborted();
  if (input.source === "relationship_memory" && input.memoryAuthorization !== undefined) {
    await repositories().consumeMemoryGeneration(input.memoryAuthorization);
  }
  input.signal?.throwIfAborted();
}

async function authorizeUncountedDispatch(
  input: OpenAIMeteringContext & {
    scope: MeteringScope;
    signal?: AbortSignal;
    reservation: { id: string } | null;
  },
): Promise<void> {
  try {
    await authorizeDispatch(input);
  } catch (error) {
    try {
      if (input.reservation !== null) {
        await repositories().releasePlanCredits({ reservationId: input.reservation.id, ...input.scope });
      }
    } catch (releaseError) {
      throw new OpenAIUsageSettlementError(releaseError);
    }
    throw error;
  }
}

function usesCountedAdmission(input: { scope: MeteringScope; source: string }): boolean {
  // Memory privacy authorization must precede disclosure, including token counting.
  return (
    assistantEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING === "free" &&
    !input.scope.isIncluded &&
    input.source !== "relationship_memory"
  );
}

/** Each outer retry reserves separately; settlement failures never retry provider work. */
type MeteringState = {
  reservation?: { id: string } | null;
  bounds?: OpenAIProviderBounds;
  isAdmitted: boolean;
  isStarted: boolean;
};

type MeteredOpenAIRequest = OpenAIMeteringContext & {
  client: OpenAIClient;
  body: Record<string, unknown>;
  options?: Parameters<OpenAIClient["responses"]["create"]>[1];
  /** Credit fitting never shrinks this request's output budget below this. */
  minimumOutputTokens?: number;
  /**
   * False for a response the caller will discard (for example truncated output).
   * Its usage is still recorded, but the hold is released instead of charged.
   */
  isBillableResponse?: (response: OpenAIModelResponse) => boolean;
};

function isChargedResponse(input: {
  isBillableResponse?: (response: OpenAIModelResponse) => boolean;
  response: OpenAIModelResponse;
}): boolean {
  return input.isBillableResponse?.(input.response) ?? true;
}

/**
 * Shrinks the output budget (never the prompt) so the worst-case hold fits the
 * balance; provider bounds are later checked against this same fitted value.
 */
function creditBoundedRequest(input: {
  request: { body: Record<string, unknown>; minimumOutputTokens?: number };
  scope: MeteringScope;
}) {
  const { scope } = input;
  const bounded = boundedRequest({ requestBody: input.request.body, shouldRequirePricing: !scope.isIncluded });
  if (scope.isIncluded || bounded.price === undefined || scope.creditPlan === null) {
    return bounded;
  }
  const maxOutputTokens = creditFittedMaxOutputTokens({
    price: bounded.price,
    plan: scope.creditPlan,
    inputTokens: maximumOpenAITextInputTokens(bounded.body),
    requestedMaxOutputTokens: bounded.maxOutputTokens,
    availableCredits: scope.availableCredits,
    minimumOutputTokens: input.request.minimumOutputTokens,
  });

  return { ...bounded, body: { ...bounded.body, max_output_tokens: maxOutputTokens }, maxOutputTokens };
}

export async function executeMeteredOpenAIResponse(request: MeteredOpenAIRequest): Promise<OpenAIModelResponse> {
  const input = {
    ...request,
    body: structuredClone(request.body),
    options: { ...request.options },
    memoryAuthorization: structuredClone(request.memoryAuthorization),
  };
  input.options.signal?.throwIfAborted();
  const scope = await resolveMeteringScope(input);
  const { model, price, body, maxOutputTokens } = creditBoundedRequest({ request: input, scope });
  const isCounted = usesCountedAdmission({ scope, source: input.source });
  const gatewayApiKey = isCounted ? "" : (assistantEnv().AI_GATEWAY_API_KEY ?? "");
  const maxInputTokens = !isCounted && !scope.isIncluded ? maximumOpenAITextInputTokens(body) : undefined;
  const executionId = randomUUID();
  const feature = input.operation ?? input.source;
  const state: MeteringState = { isAdmitted: false, isStarted: false };
  const beforeProviderCall = async (untrustedBounds: OpenAIProviderBounds) => {
    if (state.isStarted) {
      throw new Error(METERING_MESSAGES.invalidBounds);
    }
    state.isStarted = true;
    const bounds = providerBoundsSchema.parse(untrustedBounds);
    if (
      bounds.model !== model ||
      bounds.maxOutputTokens !== maxOutputTokens ||
      bounds.inputTokens > (price?.maxContextTokens ?? 0)
    ) {
      throw new Error(METERING_MESSAGES.invalidBounds);
    }
    state.bounds = bounds;
    const estimate = estimateRequest({ price, inputTokens: bounds.inputTokens, maxOutputTokens });
    const reservation = await reserveOpenAIUsage({ ...input, scope, estimate, model, price, executionId, bounds });
    Object.assign(state, { reservation });
    await authorizeDispatch({ ...input, signal: input.options.signal });
    Object.assign(state, { isAdmitted: true });
  };
  if (!isCounted) {
    const estimate = estimateRequest({ price, inputTokens: maxInputTokens ?? 0, maxOutputTokens });
    state.bounds = maxInputTokens === undefined ? undefined : { model, inputTokens: maxInputTokens, maxOutputTokens };
    const reservation = await reserveOpenAIUsage({
      ...input,
      scope,
      estimate,
      model,
      price,
      executionId,
      bounds: state.bounds,
    });
    Object.assign(state, { reservation });
    await authorizeUncountedDispatch({ ...input, scope, signal: input.options.signal, reservation });
  }
  const response = await (async () => {
    try {
      return await input.client.responses.create(body, {
        ...input.options,
        beforeProviderCall: isCounted ? beforeProviderCall : undefined,
        inputTokenCountBilling: isCounted ? "free" : undefined,
        billing: { userId: scope.userId, workspaceId: scope.workspaceId, feature, gatewayApiKey, maxInputTokens },
      });
    } catch (error) {
      try {
        await releaseDefinitiveRejection({
          ...input,
          error,
          reservationId: state.reservation?.id,
          scope,
          model,
          price,
          executionId,
          bounds: state.bounds,
        });
      } catch (releaseError) {
        // A ledger outage must not turn a rejected request into another provider purchase.
        throw new OpenAIUsageSettlementError(releaseError);
      }
      throw error;
    }
  })();
  try {
    if (isCounted && (!state.isAdmitted || !state.reservation)) {
      throw new Error(METERING_MESSAGES.missingAdmission);
    }
    await settleOpenAIResponse({
      ...input,
      scope,
      model,
      price,
      response,
      executionId,
      reservationId: state.reservation?.id,
      bounds: state.bounds,
      isCharged: isChargedResponse({ isBillableResponse: input.isBillableResponse, response }),
    });
  } catch (error) {
    throw new OpenAIUsageSettlementError(error);
  }

  return response;
}
