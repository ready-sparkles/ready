import { InsufficientAiCreditsError, PaidPlanRequiredForCreditsError } from "@readymeet/db/domain/persistence-errors";
import type { RepositoryPort } from "@readymeet/db/ports/repository";
import {
  FREE_PLAN_INCLUDED_NOTES_MEETINGS,
  hasPrivateBetaUnlimitedCredits,
  INSUFFICIENT_CREDITS_CODE,
  INSUFFICIENT_CREDITS_USER_MESSAGE,
  maximumOpenAITextInputTokens,
} from "@readymeet/shared";
import { z } from "zod";

import { apiEnv } from "../ports/api-env";
import { executeTypeSafeDecision, type MeetingDecisionRequest } from "../ports/llm-decisions";
import {
  countLlmResponseInput,
  createLlmResponse,
  isLlmRequestNotDispatched,
  type LlmResponsesRequest,
} from "../ports/llm-responses";
import { repositories } from "../ports/repository-runtime";

type ReservationIdentity = { reservationId: string; workspaceId: string; userId: string };

const MEETING_NOT_FOUND_FOR_PROVIDER_ACCOUNTING_MESSAGE = "Meeting not found for provider accounting.";
const PROVIDER_BILLING_MEMBER_IS_REQUIRED_MESSAGE = "Provider billing member is required.";
const PROVIDER_BILLING_MEMBER_IS_UNAVAILABLE_MESSAGE = "Provider billing member is unavailable.";
const MEETING_PARTICIPANT_REQUIRED_FOR_PROVIDER_ACCOUNTING_MESSAGE =
  "Meeting participant required for provider accounting.";
const ACTIVE_WORKSPACE_MEMBERSHIP_REQUIRED_MESSAGE = "Active workspace membership required.";
const TYPESAFE_MODEL_IS_NOT_PRICED_MESSAGE = "TypeSafe model is not priced.";
const LONG_CONTEXT_PRICING_REQUIRED_MESSAGE = "Long-context pricing required.";
const COMPLETE_MODEL_PRICES_AND_A_VERIFIED_MAXCONTEXTTOKENS_ARE_MESSAGE =
  "Complete model prices and a verified maxContextTokens are required.";
const CACHED_TOKENS_EXCEED_INPUT_TOKENS_MESSAGE = "Cached tokens exceed input tokens.";
const CACHE_WRITES_ARE_UNPRICED_MESSAGE = "Cache writes are unpriced.";
const PROVIDER_COST_EXCEEDS_LEDGER_RANGE_MESSAGE = "Provider cost exceeds ledger range.";
const PAID_LIVE_AI_SESSIONS_REQUIRE_AN_ENFORCEABLE_COST_MESSAGE =
  "Paid live AI sessions require an enforceable cost limit.";
const OUTPUT_CAP_EXCEEDS_MODEL_CONTEXT_MESSAGE = "Output cap exceeds model context.";
const PROVIDER_MAXIMUM_EXCEEDS_LEDGER_RANGE_MESSAGE = "Provider maximum exceeds ledger range.";
const PROVIDER_USAGE_EXCEEDS_AUTHORIZED_BOUNDS_MESSAGE = "Provider usage exceeds authorized bounds.";
const UNBOUNDED_AUTHORIZATIONS_CANNOT_SETTLE_UNVERIFIED_COSTS_MESSAGE =
  "Unbounded authorizations cannot settle unverified costs.";
const PROVIDER_USAGE_REQUIRES_SETTLEMENT_RECONCILIATION_MESSAGE = "Provider usage requires settlement reconciliation.";
const INVALID_AI_CREDIT_RESERVATION_MESSAGE = "Invalid AI credit reservation.";
const ONLY_BOUNDED_TEXT_PROVIDER_REQUESTS_CAN_BE_BILLED_MESSAGE = "Only bounded text provider requests can be billed.";

const PROVIDER_OUTCOME_IS_UNKNOWN_RESERVATION_RETAINED_MESSAGE = "Provider outcome is unknown; reservation retained.";
const TYPESAFE_JSON_REQUEST_REQUIRED_MESSAGE = "TypeSafe JSON request required.";
const TYPESAFE_LONG_CONTEXT_IS_NOT_AUTHORIZED_MESSAGE = "TypeSafe long context is not authorized.";
const CACHE_WRITE_TARIFF_REQUIRED_MESSAGE = "Known cache-writing models require cacheWritePerMillion.";
const CACHE_WRITE_MAJOR_VERSION = 5;
const CACHE_WRITE_MINOR_VERSION = 6;
const PROVIDER_ADMISSION_FAILED_MESSAGE = "Provider admission failed.";
const PROVIDER_BOUNDS_MISMATCH_MESSAGE = "Provider request does not match authorized bounds.";
const PROVIDER_RESERVATION_REQUIRED_MESSAGE = "Provider transport did not obtain a reservation.";
const OPENAI_API_KEY_REQUIRED_MESSAGE = "OpenAI API key is required.";

const JEV_INPUT_MICRO_USD_PER_TOKEN = 0.042;
const JEV_CONTEXT_TOKENS = 64_000;
const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
const LEDGER_MAX_INTEGER = 2_147_483_647;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE = 422;
const HTTP_RATE_LIMIT = 429;
const REJECTED_BEFORE_USAGE_STATUSES = [
  HTTP_BAD_REQUEST,
  HTTP_UNAUTHORIZED,
  HTTP_PAYMENT_REQUIRED,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_TOO_LARGE,
  HTTP_UNPROCESSABLE,
  HTTP_RATE_LIMIT,
];

const tokenCount = z.number().int().nonnegative().safe();
const priceSchema = z.object({
  inputPerMillion: z.number().finite().nonnegative(),
  cacheWritePerMillion: z.number().finite().nonnegative().optional(),
  longContext: z
    .object({
      thresholdTokens: z.number().int().positive().safe(),
      inputMultiplier: z.number().finite().positive(),
      outputMultiplier: z.number().finite().positive(),
    })
    .optional(),
  cachedInputPerMillion: z.number().finite().nonnegative().optional(),
  outputPerMillion: z.number().finite().nonnegative(),
  maxContextTokens: z.number().int().positive().safe(),
});
const usageSchema = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cachedInputTokens: tokenCount.optional().default(0),
  cacheWriteInputTokens: tokenCount.optional().default(0),
});
const metadataSchema = z.object({
  provider: z.enum(["openai", "typesafe"]),
  model: z.string(),
  feature: z.string(),
  meetingId: z.string().optional(),
  actionType: z.string(),
  price: priceSchema.nullable(),
  maxInputTokens: tokenCount.nullable(),
  maxOutputTokens: tokenCount.nullable(),
  included: z.boolean(),
  originalPlan: z.string(),
});
type Usage = z.infer<typeof usageSchema>;
type Scope = { meetingId?: string; userId?: string; source: string; actionType: string };
export type MeetingProviderScope = Scope & { meetingId: string };
type Authorization = ReservationIdentity & { metadata: z.infer<typeof metadataSchema> };

export class ProviderAdmissionError extends Error {
  override name = "ProviderAdmissionError";
}
export class UnboundedProviderUsageError extends ProviderAdmissionError {
  override name = "UnboundedProviderUsageError";
}
/** Admission refused because the billed account cannot cover the reservation (HTTP 402). */
export class InsufficientProviderCreditsError extends ProviderAdmissionError {
  override name = "InsufficientProviderCreditsError";
  readonly code = INSUFFICIENT_CREDITS_CODE;
  readonly statusCode = 402;

  constructor(options?: { cause?: unknown }) {
    super(INSUFFICIENT_CREDITS_USER_MESSAGE, options);
  }
}
export class ProviderSettlementError extends Error {
  override name = "ProviderSettlementError";
}
/** True for every refusal that means "this account cannot pay for the AI work". */
export function isInsufficientCreditsError(error: unknown): boolean {
  return error instanceof InsufficientAiCreditsError || error instanceof InsufficientProviderCreditsError;
}
/** Insufficient credits, or a paid reservation for a workspace without a Pro or Max plan. */
export function isPlanCreditDenial(error: unknown): boolean {
  return isInsufficientCreditsError(error) || error instanceof PaidPlanRequiredForCreditsError;
}
/** Billing refusals and settlement failures callers must propagate instead of degrading or retrying. */
export function isProviderAccountingError(error: unknown): boolean {
  return (
    error instanceof ProviderAdmissionError || error instanceof ProviderSettlementError || isPlanCreditDenial(error)
  );
}

type BillingMember = NonNullable<Awaited<ReturnType<RepositoryPort["getUserById"]>>>;
function isBillingMember(user: BillingMember | null): user is BillingMember {
  return user !== null && user.deletedAt === null && user.source !== "guest";
}

async function billingOwner(scope: Scope) {
  const repository = repositories();
  const meeting = scope.meetingId !== undefined ? await repository.getMeetingById(scope.meetingId) : null;
  if (scope.meetingId !== undefined && meeting === null) {
    throw new ProviderAdmissionError(MEETING_NOT_FOUND_FOR_PROVIDER_ACCOUNTING_MESSAGE);
  }
  const userId = scope.userId ?? meeting?.createdByUserId;
  if (userId === undefined) {
    throw new ProviderAdmissionError(PROVIDER_BILLING_MEMBER_IS_REQUIRED_MESSAGE);
  }
  const user = await repository.getUserById(userId);
  if (!isBillingMember(user)) {
    throw new ProviderAdmissionError(PROVIDER_BILLING_MEMBER_IS_UNAVAILABLE_MESSAGE);
  }
  if (
    meeting &&
    meeting.createdByUserId !== userId &&
    !(await repository.isMeetingParticipant({ meetingId: meeting.id, userId }))
  ) {
    throw new ProviderAdmissionError(MEETING_PARTICIPANT_REQUIRED_FOR_PROVIDER_ACCOUNTING_MESSAGE);
  }
  const workspaceId = meeting
    ? await repository.getMeetingAttendeeWorkspace({
        meetingId: meeting.id,
        userId,
        hostWorkspaceId: meeting.workspaceId,
      })
    : user.workspaceId;
  const membership = await repository.getWorkspaceMembership({ workspaceId, userId });
  if (membership?.status !== "active") {
    throw new ProviderAdmissionError(ACTIVE_WORKSPACE_MEMBERSHIP_REQUIRED_MESSAGE);
  }

  return { userId, workspaceId, ...(await billingPolicy({ scope, userId, workspaceId })) };
}

async function billingPolicy(input: { scope: Scope; userId: string; workspaceId: string }) {
  const repository = repositories();
  const [plan, credits, hasBetaEntitlement] = await Promise.all([
    repository.getWorkspacePlan(input.workspaceId),
    repository.getWorkspaceMemberCreditAccess(input),
    repository.hasPrivateBetaProCreditEntitlement(input.userId),
  ]);
  // The entitlement already excludes free plans and personal subscriptions.
  const hasPlanInclusion = hasPrivateBetaUnlimitedCredits({
    hasPrivateBetaProEntitlement: hasBetaEntitlement,
    isWorkspaceSubscriptionActive: credits.subscriptionActive,
  });
  const isIncluded =
    hasPlanInclusion ||
    (await hasFreeMeetingInclusion({ ...input, plan, hasSubscription: credits.subscriptionActive }));
  if (!isIncluded && plan !== "pro" && plan !== "max") {
    throw new InsufficientProviderCreditsError();
  }

  return { isIncluded, originalPlan: plan ?? "free" };
}

async function hasFreeMeetingInclusion(input: {
  scope: Scope;
  userId: string;
  workspaceId: string;
  plan: string | null;
  hasSubscription: boolean;
}): Promise<boolean> {
  if (input.hasSubscription || (input.plan !== null && input.plan !== "free") || input.scope.meetingId === undefined) {
    return false;
  }
  const meeting = await repositories().getMeetingById(input.scope.meetingId);
  if (meeting === null) {
    return false;
  }

  // Preserve the notes gate's non-host/non-standard inclusion and the three hosted meetings.
  return (
    meeting.createdByUserId !== input.userId ||
    meeting.kind !== "standard" ||
    (await repositories().countOtherHostedTrialMeetings({
      userId: input.userId,
      meetingId: meeting.id,
      workspaceId: input.workspaceId,
    })) < FREE_PLAN_INCLUDED_NOTES_MEETINGS
  );
}

function modelPrice(input: { provider: "openai" | "typesafe"; model: string }): z.infer<typeof priceSchema> {
  const { provider, model } = input;
  if (provider === "typesafe") {
    if (!["jev-1.13.0", "jev-1.14.0", "jev-latest"].includes(model)) {
      throw new ProviderAdmissionError(TYPESAFE_MODEL_IS_NOT_PRICED_MESSAGE);
    }

    // TypeSafe's standard text context is 64k, input $JEV_INPUT_MICRO_USD_PER_TOKEN/M, output free. No long-context header.
    return {
      inputPerMillion: JEV_INPUT_MICRO_USD_PER_TOKEN,
      outputPerMillion: 0,
      maxContextTokens: JEV_CONTEXT_TOKENS,
    };
  }
  try {
    const price = priceSchema.parse(z.record(z.unknown()).parse(JSON.parse(apiEnv().OPENAI_MODEL_PRICES_JSON))[model]);
    if (price.maxContextTokens > LONG_CONTEXT_THRESHOLD_TOKENS && !price.longContext) {
      throw new Error(LONG_CONTEXT_PRICING_REQUIRED_MESSAGE);
    }

    const generation = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model);
    if (
      generation !== null &&
      (Number(generation[1]) > CACHE_WRITE_MAJOR_VERSION ||
        (Number(generation[1]) === CACHE_WRITE_MAJOR_VERSION &&
          Number(generation[2] ?? 0) >= CACHE_WRITE_MINOR_VERSION)) &&
      price.cacheWritePerMillion === undefined
    ) {
      throw new Error(CACHE_WRITE_TARIFF_REQUIRED_MESSAGE);
    }

    return price;
  } catch (cause) {
    throw new ProviderAdmissionError(COMPLETE_MODEL_PRICES_AND_A_VERIFIED_MAXCONTEXTTOKENS_ARE_MESSAGE, { cause });
  }
}

function authorizedPrice(input: {
  provider: "openai" | "typesafe";
  model: string;
  isIncluded: boolean;
  isUnbounded: boolean;
}): z.infer<typeof priceSchema> | null {
  if (input.isUnbounded) {
    return null;
  }
  try {
    return modelPrice(input);
  } catch (cause) {
    if (!input.isIncluded) {
      throw cause;
    }

    return null;
  }
}

function costMicroUsd(input: { price: z.infer<typeof priceSchema>; usage: Usage }): number {
  const { price, usage } = input;
  if (usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens) {
    throw new Error(CACHED_TOKENS_EXCEED_INPUT_TOKENS_MESSAGE);
  }
  if (usage.cacheWriteInputTokens > 0 && price.cacheWritePerMillion === undefined) {
    throw new Error(CACHE_WRITES_ARE_UNPRICED_MESSAGE);
  }
  const tier = price.longContext && usage.inputTokens > price.longContext.thresholdTokens ? price.longContext : null;
  const cost = Math.ceil(
    ((usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens) * price.inputPerMillion +
      usage.cachedInputTokens * (price.cachedInputPerMillion ?? price.inputPerMillion) +
      usage.cacheWriteInputTokens * (price.cacheWritePerMillion ?? 0)) *
      (tier?.inputMultiplier ?? 1) +
      usage.outputTokens * price.outputPerMillion * (tier?.outputMultiplier ?? 1),
  );
  if (!Number.isSafeInteger(cost) || cost > LEDGER_MAX_INTEGER) {
    throw new Error(PROVIDER_COST_EXCEEDS_LEDGER_RANGE_MESSAGE);
  }

  return cost;
}

function authorizedOutputCap(input: {
  provider: string;
  isUnbounded?: boolean;
  maxOutputTokens?: number;
  price: z.infer<typeof priceSchema> | null;
}): number | null {
  if (input.isUnbounded === true && input.maxOutputTokens === undefined) {
    return null;
  }
  const cap = input.provider === "typesafe" ? 0 : z.number().int().positive().safe().parse(input.maxOutputTokens);
  if (input.price !== null && cap > input.price.maxContextTokens) {
    throw new ProviderAdmissionError(OUTPUT_CAP_EXCEEDS_MODEL_CONTEXT_MESSAGE);
  }

  return cap;
}
function maximumProviderCost(input: {
  price: z.infer<typeof priceSchema> | null;
  maxOutputTokens: number | null;
  maxInputTokens?: number;
}): number {
  const { price, maxOutputTokens } = input;
  if (price === null || maxOutputTokens === null) {
    return 0;
  }
  const maxInputTokens = input.maxInputTokens ?? price.maxContextTokens;
  const tier =
    input.maxInputTokens === undefined || (price.longContext && maxInputTokens > price.longContext.thresholdTokens)
      ? price.longContext
      : undefined;
  const cost = Math.ceil(
    maxInputTokens *
      Math.max(price.inputPerMillion, price.cachedInputPerMillion ?? 0, price.cacheWritePerMillion ?? 0) *
      Math.max(1, tier?.inputMultiplier ?? 1) +
      maxOutputTokens * price.outputPerMillion * Math.max(1, tier?.outputMultiplier ?? 1),
  );
  if (!Number.isSafeInteger(cost) || cost > LEDGER_MAX_INTEGER) {
    throw new Error(PROVIDER_MAXIMUM_EXCEEDS_LEDGER_RANGE_MESSAGE);
  }

  return cost;
}

export async function reserveProviderUsage(
  input: Scope & {
    provider: "openai" | "typesafe";
    model: string;
    maxOutputTokens?: number;
    isUnbounded?: boolean;
    requestBody?: Record<string, unknown>;
  },
): Promise<Authorization> {
  try {
    const requestBody = input.requestBody === undefined ? undefined : structuredClone(input.requestBody);
    const owner = await billingOwner(input);
    if (input.isUnbounded === true && !owner.isIncluded) {
      throw new UnboundedProviderUsageError(PAID_LIVE_AI_SESSIONS_REQUIRE_AN_ENFORCEABLE_COST_MESSAGE);
    }
    const price = authorizedPrice({
      provider: input.provider,
      model: input.model,
      isIncluded: owner.isIncluded,
      isUnbounded: input.isUnbounded === true,
    });
    const maxOutputTokens = authorizedOutputCap({ ...input, price });
    const maxInputTokens = await (async () => {
      if (requestBody !== undefined && input.provider === "openai" && input.isUnbounded !== true) {
        const body = boundedResponseBody(requestBody);
        if (body.model !== input.model || body.max_output_tokens !== maxOutputTokens) {
          throw new ProviderAdmissionError(PROVIDER_BOUNDS_MISMATCH_MESSAGE);
        }
        if (!owner.isIncluded && apiEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING === "free") {
          requireOpenAiKey();

          return countLlmResponseInput({
            apiKey: apiEnv().OPENAI_API_KEY,
            body,
            inputTokenCountBilling: "free",
          });
        }
        if (!owner.isIncluded && !JSON.stringify(body).includes('"encrypted_content"')) {
          return maximumOpenAITextInputTokens(body);
        }
      }

      return undefined;
    })();

    return await reserveAuthorizedUsage({ input, owner, price, maxOutputTokens, maxInputTokens });
  } catch (cause) {
    if (cause instanceof ProviderAdmissionError) {
      throw cause;
    }
    if (cause instanceof InsufficientAiCreditsError) {
      throw new InsufficientProviderCreditsError({ cause });
    }
    if (cause instanceof PaidPlanRequiredForCreditsError) {
      throw cause;
    }
    throw new ProviderAdmissionError(cause instanceof Error ? cause.message : PROVIDER_ADMISSION_FAILED_MESSAGE, {
      cause,
    });
  }
}

async function reserveAuthorizedUsage(bounds: {
  input: Scope & { provider: "openai" | "typesafe"; model: string };
  owner: Awaited<ReturnType<typeof billingOwner>>;
  price: z.infer<typeof priceSchema> | null;
  maxOutputTokens: number | null;
  maxInputTokens?: number;
}): Promise<Authorization> {
  const { input, owner, price, maxOutputTokens } = bounds;
  const maxInputTokens =
    bounds.maxInputTokens === undefined ? (price?.maxContextTokens ?? null) : tokenCount.parse(bounds.maxInputTokens);
  if (
    bounds.maxInputTokens !== undefined &&
    (price === null || maxInputTokens === null || maxInputTokens + (maxOutputTokens ?? 0) > price.maxContextTokens)
  ) {
    throw new ProviderAdmissionError(PROVIDER_BOUNDS_MISMATCH_MESSAGE);
  }
  const metadata = metadataSchema.parse({
    provider: input.provider,
    model: input.model,
    feature: input.source,
    meetingId: input.meetingId,
    actionType: input.actionType,
    price,
    maxInputTokens,
    maxOutputTokens,
    /** @external reservation metadata */
    included: owner.isIncluded,
    originalPlan: owner.originalPlan,
  });
  const maximumCostMicroUsd = maximumProviderCost({ price, maxOutputTokens, maxInputTokens: bounds.maxInputTokens });
  const reservation = await repositories().reservePlanCredits({
    ...owner,
    isIncluded: owner.isIncluded,
    maximumCostMicroUsd,
    metadata,
  });

  return { reservationId: reservation.id, workspaceId: owner.workspaceId, userId: owner.userId, metadata };
}

export async function settleProviderUsage(input: { authorization: Authorization; totalUsage: unknown }): Promise<void> {
  const { authorization, totalUsage } = input;
  try {
    const metadata = authorization.metadata;
    const usage = usageSchema.parse(totalUsage);
    if (
      (metadata.maxInputTokens !== null && usage.inputTokens > metadata.maxInputTokens) ||
      (metadata.provider !== "typesafe" &&
        metadata.maxOutputTokens !== null &&
        usage.outputTokens > metadata.maxOutputTokens)
    ) {
      throw new Error(PROVIDER_USAGE_EXCEEDS_AUTHORIZED_BOUNDS_MESSAGE);
    }
    if (metadata.price === null && (!metadata.included || metadata.maxOutputTokens === null)) {
      throw new Error(UNBOUNDED_AUTHORIZATIONS_CANNOT_SETTLE_UNVERIFIED_COSTS_MESSAGE);
    }
    const providerCostMicroUsd = metadata.price ? costMicroUsd({ price: metadata.price, usage }) : null;
    if (providerCostMicroUsd !== null) {
      await repositories().settlePlanCredits({
        reservationId: authorization.reservationId,
        workspaceId: authorization.workspaceId,
        userId: authorization.userId,
        providerCostMicroUsd,
        provider: metadata.provider,
        model: metadata.model,
        feature: metadata.feature,
        meetingId: metadata.meetingId,
        actionType: metadata.actionType,
        ...usage,
      });
    }
    await repositories().recordUsageEvent({
      userId: authorization.userId,
      meetingId: metadata.meetingId ?? null,
      provider: metadata.provider,
      category: "llm",
      model: metadata.model,
      sku: metadata.model,
      unitCount: usage.inputTokens + usage.outputTokens,
      unitType: "token",
      costMicroUsd: providerCostMicroUsd ?? 0,
      source: metadata.feature,
      idempotencyKey: `reservation:${authorization.reservationId}`,
      metadata: {
        ...usage,
        workspaceId: authorization.workspaceId,
        reservationId: authorization.reservationId,
        /** @external raw usage pricing evidence */
        rateConfigured: metadata.price !== null,
      },
    });
    if (providerCostMicroUsd === null) {
      await repositories().releasePlanCredits(authorization);
    }
  } catch (cause) {
    // Provider work already happened. Retain the hold; never retry the provider or release here.
    throw new ProviderSettlementError(PROVIDER_USAGE_REQUIRES_SETTLEMENT_RECONCILIATION_MESSAGE, { cause });
  }
}

export async function loadProviderAuthorization(identity: ReservationIdentity): Promise<Authorization> {
  const reservation = await repositories().getPlanCreditReservation(identity);
  if (reservation === null) {
    throw new ProviderAdmissionError(INVALID_AI_CREDIT_RESERVATION_MESSAGE);
  }

  return { ...identity, metadata: metadataSchema.parse(reservation.metadata) };
}

function isTextOnly(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.every(isTextOnly);
  }
  if (body === null || typeof body !== "object") {
    return true;
  }
  const record = z.record(z.unknown()).parse(body);
  if (
    typeof record.type === "string" &&
    /image|audio|video|file|computer|web_search|code_interpreter/.test(record.type)
  ) {
    return false;
  }

  return Object.values(record).every(isTextOnly);
}

export async function executeMemberResponse(
  input: Scope & { userId: string; request: LlmResponsesRequest },
): ReturnType<typeof createLlmResponse> {
  return executeScopedResponse(input);
}
export async function executeMeetingResponse(
  input: MeetingProviderScope & { request: LlmResponsesRequest },
): ReturnType<typeof createLlmResponse> {
  return executeScopedResponse(input);
}
function boundedResponseBody(requestBody: object) {
  const body = z
    .object({ model: z.string(), max_output_tokens: z.number().int().positive().safe() })
    .passthrough()
    .parse(requestBody);
  if (
    !isTextOnly(body) ||
    (body.tools !== undefined &&
      !z.array(z.object({ type: z.literal("function") }).passthrough()).safeParse(body.tools).success) ||
    (body.prompt_cache_options !== undefined &&
      !z.object({ mode: z.literal("explicit") }).safeParse(body.prompt_cache_options).success) ||
    body.previous_response_id !== undefined ||
    body.conversation !== undefined ||
    (body.service_tier !== undefined && body.service_tier !== "default")
  ) {
    throw new ProviderAdmissionError(ONLY_BOUNDED_TEXT_PROVIDER_REQUESTS_CAN_BE_BILLED_MESSAGE);
  }

  return body;
}

function requireOpenAiKey(): void {
  if (apiEnv().OPENAI_API_KEY === "") {
    throw new ProviderAdmissionError(OPENAI_API_KEY_REQUIRED_MESSAGE);
  }
}

async function executeScopedResponse(input: Scope & { request: LlmResponsesRequest }) {
  input.request.signal?.throwIfAborted();
  const body = boundedResponseBody(structuredClone(input.request.body));
  const owner = await billingOwner(input);
  if (!owner.isIncluded && apiEnv().OPENAI_INPUT_TOKEN_COUNT_BILLING === "free") {
    return executeCountedResponse({ ...input, request: { ...input.request, body }, owner });
  }
  if (apiEnv().AI_GATEWAY_API_KEY === "") {
    requireOpenAiKey();
  }
  const authorization = await reserveProviderUsage({
    ...input,
    provider: "openai",
    model: body.model,
    maxOutputTokens: body.max_output_tokens,
    requestBody: body,
  });
  const result = await (async () => {
    try {
      input.request.signal?.throwIfAborted();
    } catch (error) {
      await repositories().releasePlanCredits(authorization);
      throw error;
    }
    try {
      return await createLlmResponse({
        ...input.request,
        body,
        apiKey: apiEnv().AI_GATEWAY_API_KEY === "" ? apiEnv().OPENAI_API_KEY : input.request.apiKey,
        beforeProviderCall: undefined,
        inputTokenCountBilling: undefined,
        billing: {
          userId: authorization.userId,
          workspaceId: authorization.workspaceId,
          feature: input.source,
          gatewayApiKey: apiEnv().AI_GATEWAY_API_KEY,
          maxInputTokens: owner.isIncluded ? undefined : (authorization.metadata.maxInputTokens ?? undefined),
        },
      });
    } catch (cause) {
      if (isLlmRequestNotDispatched(cause)) {
        await repositories().releasePlanCredits(authorization);
        throw cause.cause instanceof Error ? cause.cause : cause;
      }
      throw new ProviderSettlementError(PROVIDER_OUTCOME_IS_UNKNOWN_RESERVATION_RETAINED_MESSAGE, { cause });
    }
  })();
  if (result.totalUsage || hasUsageEvidence(result.payload)) {
    await settleProviderUsage({ authorization, totalUsage: result.totalUsage });
  } else if (!result.isOk && REJECTED_BEFORE_USAGE_STATUSES.includes(result.status)) {
    await repositories().releasePlanCredits(authorization);
  } else if (result.isOk) {
    await settleProviderUsage({ authorization, totalUsage: result.totalUsage });
  }

  return result;
}

async function executeCountedResponse(
  input: Scope & {
    request: LlmResponsesRequest & { body: ReturnType<typeof boundedResponseBody> };
    owner: Awaited<ReturnType<typeof billingOwner>>;
  },
) {
  const { owner } = input;
  const { body } = input.request;
  const model = body.model;
  const price = modelPrice({ provider: "openai", model });
  const maxOutputTokens = authorizedOutputCap({ provider: "openai", maxOutputTokens: body.max_output_tokens, price });
  requireOpenAiKey();
  const state: { authorization?: Authorization } = {};
  const callback = { isCalled: false };
  const result = await (async () => {
    try {
      return await createLlmResponse({
        ...input.request,
        apiKey: apiEnv().OPENAI_API_KEY,
        inputTokenCountBilling: "free",
        billing: {
          userId: owner.userId,
          workspaceId: owner.workspaceId,
          feature: input.source,
          gatewayApiKey: apiEnv().AI_GATEWAY_API_KEY,
        },
        beforeProviderCall: async (bounds) => {
          if (callback.isCalled || bounds.model !== model || bounds.maxOutputTokens !== maxOutputTokens) {
            throw new ProviderAdmissionError(PROVIDER_BOUNDS_MISMATCH_MESSAGE);
          }
          callback.isCalled = true;
          try {
            const authorization = await reserveAuthorizedUsage({
              input: { ...input, provider: "openai", model },
              owner,
              price,
              maxOutputTokens,
              maxInputTokens: tokenCount.parse(bounds.inputTokens),
            });
            state.authorization = authorization;
          } catch (cause) {
            if (cause instanceof ProviderAdmissionError || cause instanceof PaidPlanRequiredForCreditsError) {
              throw cause;
            }
            if (cause instanceof InsufficientAiCreditsError) {
              throw new InsufficientProviderCreditsError({ cause });
            }
            throw new ProviderAdmissionError(
              cause instanceof Error ? cause.message : PROVIDER_ADMISSION_FAILED_MESSAGE,
              { cause },
            );
          }
        },
      });
    } catch (cause) {
      if (isLlmRequestNotDispatched(cause)) {
        if (state.authorization !== undefined) {
          await repositories().releasePlanCredits(state.authorization);
        }
        throw cause.cause instanceof Error ? cause.cause : cause;
      }
      throw new ProviderSettlementError(PROVIDER_OUTCOME_IS_UNKNOWN_RESERVATION_RETAINED_MESSAGE, { cause });
    }
  })();
  const authorization = state.authorization;
  if (authorization === undefined) {
    throw new ProviderSettlementError(PROVIDER_RESERVATION_REQUIRED_MESSAGE);
  }
  if (result.totalUsage || result.isOk || hasUsageEvidence(result.payload)) {
    await settleProviderUsage({ authorization, totalUsage: result.totalUsage });
  } else if (REJECTED_BEFORE_USAGE_STATUSES.includes(result.status)) {
    await repositories().releasePlanCredits(authorization);
  }

  return result;
}

export async function executeMeetingDecision(
  input: MeetingProviderScope & { request: MeetingDecisionRequest },
): Promise<Response> {
  input.request.signal?.throwIfAborted();
  const model = z.string().parse(input.request.body.model);
  const authorization = await reserveProviderUsage({ ...input, provider: "typesafe", model });
  try {
    input.request.signal?.throwIfAborted();
  } catch (error) {
    await repositories().releasePlanCredits(authorization);
    throw error;
  }
  const result = await providerAttempt(() =>
    executeTypeSafeDecision({
      ...input.request,
      billing: {
        userId: authorization.userId,
        workspaceId: authorization.workspaceId,
        feature: input.source,
      },
    }),
  );
  if (result.totalUsage || hasUsageEvidence(result.payload)) {
    await settleProviderUsage({ authorization, totalUsage: result.totalUsage });
  } else if (!result.isOk && REJECTED_BEFORE_USAGE_STATUSES.includes(result.status)) {
    await repositories().releasePlanCredits(authorization);
  } else if (result.isOk) {
    await settleProviderUsage({ authorization, totalUsage: result.totalUsage });
  }

  return new Response(result.rawBody, { status: result.status, headers: result.headers });
}

function hasUsageEvidence(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && "usage" in payload;
}

async function providerAttempt<T>(execute: () => Promise<T>): Promise<T> {
  try {
    return await execute();
  } catch (cause) {
    throw new ProviderSettlementError(PROVIDER_OUTCOME_IS_UNKNOWN_RESERVATION_RETAINED_MESSAGE, { cause });
  }
}

/** Adapts existing injected HTTP decision callbacks without changing their prompts or retry boundaries. */
export function meetingDecisionFetcher(scope: MeetingProviderScope): typeof fetch {
  return async (_url, init) => {
    if (typeof init?.body !== "string") {
      throw new ProviderAdmissionError(TYPESAFE_JSON_REQUEST_REQUIRED_MESSAGE);
    }
    const headers = new Headers(init.headers);
    if (headers.has("TypeSafe-Danger-Zone-Long-Context")) {
      throw new ProviderAdmissionError(TYPESAFE_LONG_CONTEXT_IS_NOT_AUTHORIZED_MESSAGE);
    }

    return executeMeetingDecision({
      ...scope,
      request: {
        apiKey: headers.get("authorization")?.replace(/^Bearer /, "") ?? apiEnv().TYPESAFE_API_KEY,
        body: z.record(z.unknown()).parse(JSON.parse(init.body)),
        signal: init.signal ?? undefined,
      },
    });
  };
}
