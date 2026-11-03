import type { RepositoryPort, WorkspaceAshbyIntegration } from "@readymeet/db/ports/repository";
import {
  type AiWorkflowJobView,
  ASHBY_REVIEW_PROMPT_VERSION,
  ashbyExtractionSchema,
  type AshbyReview,
  type AshbyReviewAction,
  type AshbyReviewItem,
  ashbyReviewItemSchema,
} from "@readymeet/shared";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  type AshbyReviewUsage,
  type AshbyTranscriptSegment,
  extractAshbyProposals,
  screenAshbyTranscript,
} from "../../../domain/ashby-review-model";
import { apiEnv } from "../../../ports/api-env";
import type { AppLogger } from "../../../ports/app-logger";
import { resolveMeetingNotesAccess } from "../../../ports/gate-meeting-notes-access";
import {
  executeMeetingResponse,
  isProviderAccountingError,
  meetingDecisionFetcher,
} from "../../../ports/gate-metered-provider";
import { decryptJsonSecret } from "../../../ports/gate-secret-crypto";
import { repositories } from "../../../ports/repository-runtime";

import { AshbyApiError, type AshbyClient, createAshbyClient } from "./ashby-client";
import { ashbyReviewError, readyAshbyItem, resolveAshbyItem, validateAshbyWriteTarget } from "./ashby-review-targets";

const HASH_ALGORITHM_SHA256 = "sha256";
const ASHBY_STAGE_TARGET_PREFIX = "stage:";
const ASHBY_REVIEW_MODEL_USAGE_LOG_MESSAGE = "Ashby review model usage";

const MESSAGE_ASHBY_CONNECTION_CHANGED_RUN_REVIEW_AGAIN = "Your Ashby connection changed. Run the review again.";
const MESSAGE_ASHBY_TRANSCRIPT_CHANGED_RUN_REVIEW_AGAIN = "The transcript changed. Run the review again.";
const MESSAGE_CONNECT_ASHBY_TO_REVIEW_ACTIONS = "Connect Ashby in your workspace to review these actions.";
const MESSAGE_ASHBY_REVIEW_CHANGED_REFRESH = "This review changed. Refresh it before continuing.";
const MESSAGE_ASHBY_OPERATION_STILL_RUNNING = "The current Ashby operation is still running.";
const MESSAGE_ASHBY_TRANSCRIPT_CHANGED_BEFORE_CONFIRM =
  "The transcript changed. Run the review again before confirming.";
const MESSAGE_ASHBY_ACTION_CANNOT_BE_EDITED = "This action cannot be edited.";
const MESSAGE_RESOLVE_REVIEW_BEFORE_CONFIRM = "Resolve this review before confirming.";
const MESSAGE_RESOLVE_SELECTED_ACTIONS_BEFORE_CONFIRM = "Resolve every selected action before confirming.";
const MESSAGE_ONE_STAGE_CHANGE_PER_APPLICATION =
  "Choose one stage change per application, or tell Ready what to do differently.";
const MESSAGE_CHECK_PENDING_ASHBY_BEFORE_REVISE = "Check the pending Ashby result before revising this review.";
const MESSAGE_CHECK_PENDING_ASHBY_BEFORE_RETRY = "Check the pending Ashby result before running the review again.";
const MESSAGE_ASHBY_MEETING_REVIEW_FAILED = "Ashby meeting review failed; private drafts have been preserved.";
const MESSAGE_ASHBY_DISCONNECTED_OR_CHANGED = "Ashby was disconnected or changed.";
const MESSAGE_ASHBY_REVIEW_ITEM_MISSING_APPLICATION = "Ashby review item is missing an application.";
const MESSAGE_ASHBY_CONFLICTING_APPLICATION_ACTION =
  "Another action for this application was already submitted with a different or unverified target. This change was not sent. Check Ashby before revising.";
const MESSAGE_ASHBY_COMPLETED_ACTION_STAGE_MISMATCH =
  "The previously completed action no longer matches the current stage in Ashby. This change was not sent.";
const MESSAGE_ASHBY_REJECTED_PREVIOUS_ATTEMPT =
  "Ashby rejected the previous attempt. Ask an admin to check the connection before retrying.";
const MESSAGE_ASHBY_PREVIOUS_ATTEMPT_NOT_VERIFIED =
  "The previous attempt has not been verified. Check Ashby, then use Check result. Ready will not send it twice.";
const MESSAGE_ASHBY_RESPONSE_INTERRUPTED = "Ashby's response was interrupted. Check result before doing anything else.";

const ashbyKeySecretSchema = z.object({ apiKey: z.string() });

type AshbyReviewAccess = {
  userId: string;
  workspaceId: string;
  integration: WorkspaceAshbyIntegration;
  connectionVersion: string;
};
type AshbyReviewJobLogger = Pick<AppLogger, "info">;
type AshbyMeetingTranscript = {
  segments: AshbyTranscriptSegment[];
  hash: string;
};

function stageTargetKey(applicationId: string): string {
  return `${ASHBY_STAGE_TARGET_PREFIX}${applicationId}`;
}

function readAshbyApiKey(secretRef: string): string {
  return ashbyKeySecretSchema.parse(decryptJsonSecret(secretRef)).apiKey;
}

function readPayloadRunId(payload: Record<string, unknown>): string | null {
  const runId = payload.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    return null;
  }

  return runId;
}

function readPayloadStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((entry): entry is string => typeof entry === "string")) {
    return null;
  }

  return [...value];
}

function changedNamed(input: { review: AshbyReview; patch: Partial<AshbyReview> }): AshbyReview {
  return {
    ...input.review,
    ...input.patch,
    revision: input.review.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

function clientForNamed(input: { access: AshbyReviewAccess }): AshbyClient {
  return createAshbyClient(readAshbyApiKey(input.access.integration.secretRef));
}

async function transcriptNamed(input: { meetingId: string }): Promise<AshbyMeetingTranscript> {
  const source = await repositories().getTranscriptForMeeting(input.meetingId);
  const segments: AshbyTranscriptSegment[] = (source?.segments ?? [])
    .filter((s) => s.speakerRole === "human" && s.content.trim().length > 0)
    .map((s) => ({ id: s.id, content: s.content, speaker: s.speakerName }));
  const hash = createHash(HASH_ALGORITHM_SHA256)
    .update(
      JSON.stringify({
        segments,
        prompt: ASHBY_REVIEW_PROMPT_VERSION,
        model: apiEnv().ASHBY_REVIEW_MODEL,
        gate: apiEnv().ASHBY_REVIEW_JEV_MODEL,
      }),
    )
    .digest("hex");

  return { segments, hash };
}

function getAnalysisResult(value: unknown): ReturnType<typeof ashbyExtractionSchema.parse> | null {
  if (value === null || value === undefined) {
    return null;
  }

  return ashbyExtractionSchema.parse(value);
}

function reviewAwaitingUserStatusNamed(input: {
  items: AshbyReviewItem[];
  clarification: string | null;
}): AshbyReview["status"] {
  return input.items.length !== 0 || input.clarification !== null ? "awaiting_user" : "no_matches";
}

async function ashbyReviewAccessNamed(input: { meetingId: string; userId: string }): Promise<AshbyReviewAccess | null> {
  if (!apiEnv().ASHBY_POST_MEETING_REVIEW_ENABLED) {
    return null;
  }
  const viewer = (await repositories().listAshbyReviewViewers({ meetingId: input.meetingId })).find(
    (v) => v.userId === input.userId,
  );
  const meeting = await repositories().getMeetingById(input.meetingId);
  if (viewer === undefined || meeting === null) {
    return null;
  }
  if ((await resolveMeetingNotesAccess({ meeting, viewerRole: "participant", userId: input.userId })).locked) {
    return null;
  }
  const integration = await repositories().getWorkspaceAshbyIntegration(viewer.workspaceId);

  return integration === null
    ? null
    : {
        userId: viewer.userId,
        workspaceId: viewer.workspaceId,
        integration,
        connectionVersion: createHash(HASH_ALGORITHM_SHA256)
          .update(`${integration.updatedAt}:${integration.secretRef}`)
          .digest("hex"),
      };
}

export async function ashbyReviewAccess(
  ...args: [meetingId: string, userId: string]
): Promise<AshbyReviewAccess | null> {
  return ashbyReviewAccessNamed({ meetingId: args[0], userId: args[1] });
}

async function getPrivateAshbyReviewNamed(input: { meetingId: string; userId: string }): Promise<AshbyReview | null> {
  const access = await ashbyReviewAccessNamed(input);
  if (access === null) {
    return null;
  }
  const review = await repositories().getAshbyReview({
    meetingId: input.meetingId,
    userId: input.userId,
    workspaceId: access.workspaceId,
  });
  if (review === null) {
    return null;
  }
  if (review.connectionVersion !== access.connectionVersion) {
    return {
      ...review,
      status: "stale",
      items: [],
      error: MESSAGE_ASHBY_CONNECTION_CHANGED_RUN_REVIEW_AGAIN,
    };
  }
  const transcriptInput = await transcriptNamed({ meetingId: input.meetingId });
  if (
    !["queued", "reviewing", "revising", "syncing"].includes(review.status) &&
    review.inputHash !== transcriptInput.hash
  ) {
    return {
      ...review,
      status: "stale",
      error: MESSAGE_ASHBY_TRANSCRIPT_CHANGED_RUN_REVIEW_AGAIN,
    };
  }

  return review;
}

export async function getPrivateAshbyReview(...args: [meetingId: string, userId: string]): Promise<AshbyReview | null> {
  return getPrivateAshbyReviewNamed({ meetingId: args[0], userId: args[1] });
}

async function enqueueAshbyReviewNamed(input: { meetingId: string }): Promise<void> {
  if (!apiEnv().ASHBY_POST_MEETING_REVIEW_ENABLED) {
    return;
  }
  if ((await repositories().listAshbyReviewViewers({ meetingId: input.meetingId })).length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await processAshbyReviewJob({
    id: randomUUID(),
    meetingId: input.meetingId,
    extractionId: null,
    type: "review_ashby_actions",
    scopeKey: "detect",
    status: "running",
    phase: "detect",
    payload: { action: "detect" },
    result: {},
    error: null,
    attemptCount: 1,
    maxAttempts: 1,
    runAfter: now,
    lockedBy: "request",
    lockedAt: now,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function enqueueAshbyReview(...args: [meetingId: string]): Promise<void> {
  return enqueueAshbyReviewNamed({ meetingId: args[0] });
}

async function assertActOnAshbyReviewReadyNamed(input: {
  meetingId: string;
  userId: string;
  action: AshbyReviewAction;
}): Promise<{ access: AshbyReviewAccess; review: AshbyReview }> {
  const access = await ashbyReviewAccessNamed({ meetingId: input.meetingId, userId: input.userId });
  if (access === null) {
    throw new Error(MESSAGE_CONNECT_ASHBY_TO_REVIEW_ACTIONS);
  }
  const review = await repositories().getAshbyReview({
    meetingId: input.meetingId,
    userId: input.userId,
    workspaceId: access.workspaceId,
  });
  if (review === null || review.revision !== input.action.revision) {
    throw new Error(MESSAGE_ASHBY_REVIEW_CHANGED_REFRESH);
  }
  if (["reviewing", "queued", "revising", "syncing"].includes(review.status)) {
    throw new Error(MESSAGE_ASHBY_OPERATION_STILL_RUNNING);
  }
  if (review.connectionVersion !== access.connectionVersion && input.action.action !== "retry") {
    throw new Error(MESSAGE_ASHBY_CONNECTION_CHANGED_RUN_REVIEW_AGAIN);
  }
  const transcriptInput = await transcriptNamed({ meetingId: input.meetingId });
  if (input.action.action !== "retry" && review.inputHash !== transcriptInput.hash) {
    throw new Error(MESSAGE_ASHBY_TRANSCRIPT_CHANGED_BEFORE_CONFIRM);
  }

  return { access, review };
}

async function actOnAshbyReviewTargetNamed(input: {
  access: AshbyReviewAccess;
  review: AshbyReview;
  action: Extract<AshbyReviewAction, { action: "target" }>;
}): Promise<AshbyReview> {
  const item = input.review.items.find((candidate) => candidate.id === input.action.itemId);
  if (item === undefined || ["completed", "unknown"].includes(item.status)) {
    throw new Error(MESSAGE_ASHBY_ACTION_CANNOT_BE_EDITED);
  }
  const selection = {
    candidateId: input.action.candidateId,
    applicationId: input.action.applicationId,
    stageId: input.action.stageId,
  };
  if (item.candidateId !== selection.candidateId) {
    selection.applicationId = null;
    selection.stageId = null;
  } else if (item.applicationId !== selection.applicationId) {
    selection.stageId = null;
  }
  const updated = await resolveAshbyItem(clientForNamed({ access: input.access }), item.proposal, selection, item);
  /** @external ashby review item wire field */
  updated.userEdited = true;
  updated.proposal = {
    ...updated.proposal,
    candidateName: updated.candidateName ?? updated.proposal.candidateName,
    candidateEmail: updated.candidates.find((c) => c.id === updated.candidateId)?.email ?? null,
    jobTitle: updated.applications.find((a) => a.id === updated.applicationId)?.name ?? updated.proposal.jobTitle,
    stageName: updated.stages.find((s) => s.id === updated.stageId)?.name ?? updated.proposal.stageName,
  };

  return repositories().saveAshbyReview({
    review: changedNamed({
      review: input.review,
      patch: {
        status: "awaiting_user",
        error: null,
        items: input.review.items.map((candidate) => (candidate.id === item.id ? updated : candidate)),
      },
    }),
    expectedRevision: input.review.revision,
  });
}

async function actOnAshbyReviewConfirmNamed(input: {
  review: AshbyReview;
  action: Extract<AshbyReviewAction, { action: "confirm" }>;
}): Promise<AshbyReview> {
  if (input.review.status !== "awaiting_user" || input.review.clarification !== null) {
    throw new Error(MESSAGE_RESOLVE_REVIEW_BEFORE_CONFIRM);
  }
  const items = input.review.items.filter((candidate) => input.action.itemIds.includes(candidate.id));
  if (
    items.length !== new Set(input.action.itemIds).size ||
    items.some((candidate) => candidate.status === "completed" || !readyAshbyItem(candidate))
  ) {
    throw new Error(MESSAGE_RESOLVE_SELECTED_ACTIONS_BEFORE_CONFIRM);
  }
  const targets = items.map((candidate) => {
    const applicationId = candidate.applicationId;
    if (applicationId === null) {
      throw new Error(MESSAGE_RESOLVE_SELECTED_ACTIONS_BEFORE_CONFIRM);
    }

    return stageTargetKey(applicationId);
  });
  if (new Set(targets).size !== targets.length) {
    throw new Error(MESSAGE_ONE_STAGE_CHANGE_PER_APPLICATION);
  }

  return repositories().saveAshbyReview({
    review: changedNamed({
      review: input.review,
      patch: {
        status: "syncing",
        error: null,
        items: input.review.items.map((candidate) => ({
          ...candidate,
          /** @external ashby review item wire field */
          included: input.action.itemIds.includes(candidate.id),
        })),
      },
    }),
    expectedRevision: input.review.revision,
    command: { action: "sync", itemIds: input.action.itemIds },
  });
}

async function actOnAshbyReviewReviseNamed(input: {
  review: AshbyReview;
  action: Extract<AshbyReviewAction, { action: "revise" }>;
}): Promise<AshbyReview> {
  if (input.review.items.some((candidate) => candidate.status === "unknown")) {
    throw new Error(MESSAGE_CHECK_PENDING_ASHBY_BEFORE_REVISE);
  }

  return repositories().saveAshbyReview({
    review: changedNamed({
      review: input.review,
      patch: {
        status: "revising",
        error: null,
        corrections: [...(input.review.corrections ?? []), input.action.instruction],
      },
    }),
    expectedRevision: input.review.revision,
    command: { action: "revise", instruction: input.action.instruction },
  });
}

async function actOnAshbyReviewRetryNamed(input: {
  access: AshbyReviewAccess;
  review: AshbyReview;
}): Promise<AshbyReview> {
  if (input.review.items.some((candidate) => candidate.status === "unknown")) {
    throw new Error(MESSAGE_CHECK_PENDING_ASHBY_BEFORE_RETRY);
  }

  return repositories().saveAshbyReview({
    review: changedNamed({
      review: input.review,
      patch: {
        status: "queued",
        error: null,
        connectionVersion: input.access.connectionVersion,
        items: input.review.connectionVersion === input.access.connectionVersion ? input.review.items : [],
      },
    }),
    expectedRevision: input.review.revision,
    command: { action: "refresh" },
  });
}

async function actOnAshbyReviewDismissNamed(input: {
  meetingId: string;
  userId: string;
  action: Extract<AshbyReviewAction, { action: "dismiss" }>;
}): Promise<AshbyReview> {
  const access = await ashbyReviewAccessNamed({ meetingId: input.meetingId, userId: input.userId });
  if (access === null) {
    throw new Error(MESSAGE_CONNECT_ASHBY_TO_REVIEW_ACTIONS);
  }
  const review = await repositories().getAshbyReview({
    meetingId: input.meetingId,
    userId: input.userId,
    workspaceId: access.workspaceId,
  });
  if (review === null || review.revision !== input.action.revision) {
    throw new Error(MESSAGE_ASHBY_REVIEW_CHANGED_REFRESH);
  }
  if (["reviewing", "queued", "revising", "syncing"].includes(review.status)) {
    throw new Error(MESSAGE_ASHBY_OPERATION_STILL_RUNNING);
  }

  return repositories().saveAshbyReview({
    review: changedNamed({ review, patch: { status: "dismissed" } }),
    expectedRevision: review.revision,
  });
}

async function actOnAshbyReviewNamed(input: {
  meetingId: string;
  userId: string;
  action: AshbyReviewAction;
}): Promise<AshbyReview> {
  if (input.action.action === "dismiss") {
    return actOnAshbyReviewDismissNamed({
      meetingId: input.meetingId,
      userId: input.userId,
      action: input.action,
    });
  }
  const ready = await assertActOnAshbyReviewReadyNamed(input);
  if (input.action.action === "target") {
    return actOnAshbyReviewTargetNamed({ access: ready.access, review: ready.review, action: input.action });
  }
  if (input.action.action === "confirm") {
    return actOnAshbyReviewConfirmNamed({ review: ready.review, action: input.action });
  }
  if (input.action.action === "revise") {
    return actOnAshbyReviewReviseNamed({ review: ready.review, action: input.action });
  }

  return actOnAshbyReviewRetryNamed({ access: ready.access, review: ready.review });
}

export async function actOnAshbyReview(
  ...args: [meetingId: string, userId: string, action: AshbyReviewAction]
): Promise<AshbyReview> {
  return actOnAshbyReviewNamed({ meetingId: args[0], userId: args[1], action: args[2] });
}

async function resolveAshbyProposalsNamed(input: {
  access: AshbyReviewAccess;
  proposals: Awaited<ReturnType<typeof extractAshbyProposals>>["proposals"];
}): Promise<AshbyReviewItem[]> {
  return input.proposals.reduce<Promise<AshbyReviewItem[]>>(async (previous, proposal) => {
    const collected = await previous;

    return [...collected, await resolveAshbyItem(clientForNamed({ access: input.access }), proposal)];
  }, Promise.resolve([]));
}

async function listEligibleAshbyReviewAccessNamed(input: { meetingId: string }): Promise<AshbyReviewAccess[]> {
  const viewers = await repositories().listAshbyReviewViewers({ meetingId: input.meetingId });

  return viewers.reduce<Promise<AshbyReviewAccess[]>>(async (previous, viewer) => {
    const collected = await previous;
    const access = await ashbyReviewAccessNamed({ meetingId: input.meetingId, userId: viewer.userId });

    return access === null ? collected : [...collected, access];
  }, Promise.resolve([]));
}

async function listAshbyReviewsToAnalyzeNamed(input: {
  meetingId: string;
  eligible: AshbyReviewAccess[];
  inputHash: string;
}): Promise<AshbyReview[]> {
  return input.eligible.reduce<Promise<AshbyReview[]>>(async (previous, access) => {
    const collected = await previous;
    const review = await repositories().createAshbyReview({
      id: randomUUID(),
      meetingId: input.meetingId,
      userId: access.userId,
      workspaceId: access.workspaceId,
      inputHash: input.inputHash,
      connectionVersion: access.connectionVersion,
      revision: 0,
      status: "queued",
      items: [],
      error: null,
      clarification: null,
      updatedAt: new Date().toISOString(),
    });
    if (["syncing", "revising"].includes(review.status) || review.items.some((item) => item.status === "unknown")) {
      return collected;
    }
    if (
      review.inputHash === input.inputHash &&
      review.connectionVersion === access.connectionVersion &&
      !["queued", "failed"].includes(review.status)
    ) {
      return collected;
    }

    return [...collected, review];
  }, Promise.resolve([]));
}

async function loadAshbyMeetingAnalysisNamed(input: {
  meetingId: string;
  segments: AshbyTranscriptSegment[];
  inputHash: string;
  onUsage?: (usage: AshbyReviewUsage) => void;
}): Promise<Awaited<ReturnType<typeof extractAshbyProposals>>> {
  const cachedAnalysis = getAnalysisResult(
    await repositories().getAshbyAnalysis({ meetingId: input.meetingId, hash: input.inputHash }),
  );
  if (cachedAnalysis !== null) {
    return cachedAnalysis;
  }
  const isRelevant = await screenAshbyTranscript(input.segments, {
    apiKey: apiEnv().TYPESAFE_API_KEY,
    model: apiEnv().ASHBY_REVIEW_JEV_MODEL,
    decide: meetingDecisionFetcher({
      meetingId: input.meetingId,
      source: "ashby_screening",
      actionType: "agent_workflow",
    }),
    onUsage: input.onUsage,
    isAccountingError: isProviderAccountingError,
  });
  const extracted = isRelevant
    ? await extractAshbyProposals({
        segments: input.segments,
        apiKey: apiEnv().OPENAI_API_KEY,
        model: apiEnv().ASHBY_REVIEW_MODEL,
        complete: (request) =>
          executeMeetingResponse({
            meetingId: input.meetingId,
            source: "ashby_extraction",
            actionType: "agent_workflow",
            request,
          }),
        onUsage: input.onUsage,
      })
    : { proposals: [], clarification: null };
  await repositories().saveAshbyAnalysis({ meetingId: input.meetingId, hash: input.inputHash, result: extracted });

  return extracted;
}

async function applyAshbyAnalysisToReviewsNamed(input: {
  meetingId: string;
  reviews: AshbyReview[];
  analysis: Awaited<ReturnType<typeof extractAshbyProposals>>;
  inputHash: string;
}): Promise<void> {
  const resolvedByWorkspace = new Map<string, AshbyReviewItem[]>();
  await input.reviews.reduce(async (previous, review) => {
    await previous;
    const access = await ashbyReviewAccessNamed({ meetingId: input.meetingId, userId: review.userId });
    if (access === null) {
      return;
    }
    const resolutionKey = `${access.workspaceId}:${access.connectionVersion}`;
    const cachedItems = resolvedByWorkspace.get(resolutionKey);
    const items = cachedItems ?? (await resolveAshbyProposalsNamed({ access, proposals: input.analysis.proposals }));
    if (cachedItems === undefined) {
      resolvedByWorkspace.set(resolutionKey, items);
    }
    await repositories().saveAshbyReview({
      review: changedNamed({
        review,
        patch: {
          items,
          status: reviewAwaitingUserStatusNamed({ items, clarification: input.analysis.clarification }),
          inputHash: input.inputHash,
          connectionVersion: access.connectionVersion,
          error: null,
          clarification: input.analysis.clarification,
        },
      }),
      expectedRevision: review.revision,
    });
  }, Promise.resolve());
}

async function markAshbyReviewsFailedNamed(input: { reviews: AshbyReview[]; error: unknown }): Promise<void> {
  await input.reviews.reduce(async (previous, review) => {
    await previous;
    const current = await repositories().getAshbyReviewById({ id: review.id });
    if (current?.review.revision === review.revision) {
      await repositories().saveAshbyReview({
        review: changedNamed({ review, patch: { status: "failed", error: ashbyReviewError(input.error) } }),
        expectedRevision: review.revision,
      });
    }
  }, Promise.resolve());
}

async function detectMeetingNamed(input: {
  meetingId: string;
  onUsage?: (usage: AshbyReviewUsage) => void;
}): Promise<void> {
  const eligible = await listEligibleAshbyReviewAccessNamed({ meetingId: input.meetingId });
  if (eligible.length === 0) {
    return;
  }
  const transcriptInput = await transcriptNamed({ meetingId: input.meetingId });
  if (transcriptInput.segments.length === 0) {
    return;
  }
  const reviews = await listAshbyReviewsToAnalyzeNamed({
    meetingId: input.meetingId,
    eligible,
    inputHash: transcriptInput.hash,
  });
  if (reviews.length === 0) {
    return;
  }
  try {
    const analysis = await loadAshbyMeetingAnalysisNamed({
      meetingId: input.meetingId,
      segments: transcriptInput.segments,
      inputHash: transcriptInput.hash,
      onUsage: input.onUsage,
    });
    await applyAshbyAnalysisToReviewsNamed({
      meetingId: input.meetingId,
      reviews,
      analysis,
      inputHash: transcriptInput.hash,
    });
  } catch (error) {
    await markAshbyReviewsFailedNamed({ reviews, error });
    throw new Error(MESSAGE_ASHBY_MEETING_REVIEW_FAILED);
  }
}

/** Existing claims are reconciliation-only, including claims abandoned by a crashed worker. */
async function reconcileAshbyActionNamed(input: { client: AshbyClient; item: AshbyReviewItem }): Promise<boolean> {
  if (input.item.applicationId === null) {
    return false;
  }
  const application = await input.client.application(input.item.applicationId);

  return (
    application?.candidate?.id === input.item.candidateId &&
    application.currentInterviewStage?.id === input.item.stageId
  );
}

function claimMatchesReviewItemTargetNamed(input: {
  review: AshbyReview;
  item: AshbyReviewItem;
  claim: Awaited<ReturnType<RepositoryPort["claimAshbyAction"]>>;
  intended: ReturnType<typeof ashbyReviewItemSchema.safeParse>;
}): boolean {
  if (input.intended.success) {
    return (
      input.intended.data.candidateId === input.item.candidateId &&
      input.intended.data.applicationId === input.item.applicationId &&
      input.intended.data.stageId === input.item.stageId &&
      input.claim.result?.connectionVersion === input.review.connectionVersion
    );
  }

  return input.claim.status === "completed" && input.claim.result?.stageId === input.item.stageId;
}

async function syncItemWhenClaimCompletedNamed(input: {
  item: AshbyReviewItem;
  client: AshbyClient;
}): Promise<AshbyReviewItem> {
  if (await reconcileAshbyActionNamed({ client: input.client, item: input.item })) {
    return { ...input.item, status: "completed", error: null };
  }

  return {
    ...input.item,
    status: "failed",
    error: MESSAGE_ASHBY_COMPLETED_ACTION_STAGE_MISMATCH,
  };
}

async function syncItemWhenClaimReconcileNamed(input: {
  review: AshbyReview;
  item: AshbyReviewItem;
  claim: Awaited<ReturnType<RepositoryPort["claimAshbyAction"]>>;
  client: AshbyClient;
  intended: ReturnType<typeof ashbyReviewItemSchema.safeParse>;
}): Promise<AshbyReviewItem | null> {
  if (
    !input.intended.success ||
    input.claim.result?.connectionVersion !== input.review.connectionVersion ||
    !(await reconcileAshbyActionNamed({ client: input.client, item: input.intended.data }))
  ) {
    return null;
  }
  await repositories().finishAshbyAction({
    id: input.claim.id,
    status: "completed",
    result: {
      ...input.claim.result,
      stageId: input.item.stageId,
      /** @external ashby action result wire field */
      reconciled: true,
    },
  });

  return { ...input.item, status: "completed", error: null };
}

async function syncItemWhenClaimNotAcquiredNamed(input: {
  review: AshbyReview;
  item: AshbyReviewItem;
  claim: Awaited<ReturnType<RepositoryPort["claimAshbyAction"]>>;
  client: AshbyClient;
}): Promise<AshbyReviewItem> {
  const intended = ashbyReviewItemSchema.safeParse(input.claim.result?.item);
  const isSameTarget = claimMatchesReviewItemTargetNamed({
    review: input.review,
    item: input.item,
    claim: input.claim,
    intended,
  });
  if (input.claim.status !== "rejected" && !isSameTarget) {
    return {
      ...input.item,
      status: "failed",
      error: MESSAGE_ASHBY_CONFLICTING_APPLICATION_ACTION,
    };
  }
  if (input.claim.status === "completed") {
    return syncItemWhenClaimCompletedNamed({ item: input.item, client: input.client });
  }
  if (input.claim.status === "rejected") {
    return {
      ...input.item,
      status: "failed",
      error: MESSAGE_ASHBY_REJECTED_PREVIOUS_ATTEMPT,
    };
  }
  const reconciled = await syncItemWhenClaimReconcileNamed({
    review: input.review,
    item: input.item,
    claim: input.claim,
    client: input.client,
    intended,
  });
  if (reconciled !== null) {
    return reconciled;
  }

  return {
    ...input.item,
    status: "unknown",
    error: MESSAGE_ASHBY_PREVIOUS_ATTEMPT_NOT_VERIFIED,
  };
}

async function syncItemExecuteWriteNamed(input: {
  review: AshbyReview;
  item: AshbyReviewItem;
  claimId: string;
  client: AshbyClient;
}): Promise<AshbyReviewItem> {
  try {
    await input.client.write("application.changeStage", {
      applicationId: input.item.applicationId,
      interviewStageId: input.item.stageId,
    });
    await repositories().finishAshbyAction({
      id: input.claimId,
      status: "completed",
      result: {
        item: input.item,
        connectionVersion: input.review.connectionVersion,
        stageId: input.item.stageId,
      },
    });

    return { ...input.item, status: "completed", error: null };
  } catch (error) {
    if (
      error instanceof AshbyApiError &&
      ["invalid_key", "missing_permission", "request", "not_available", "rate_limited"].includes(error.kind)
    ) {
      await repositories().finishAshbyAction({ id: input.claimId, status: "rejected", result: { reason: error.kind } });

      return { ...input.item, status: "failed", error: ashbyReviewError(error) };
    }

    return {
      ...input.item,
      status: "unknown",
      error: MESSAGE_ASHBY_RESPONSE_INTERRUPTED,
    };
  }
}

async function syncItemNamed(input: { review: AshbyReview; item: AshbyReviewItem }): Promise<AshbyReviewItem> {
  const access = await ashbyReviewAccessNamed({ meetingId: input.review.meetingId, userId: input.review.userId });
  if (access === null || access.connectionVersion !== input.review.connectionVersion) {
    throw new Error(MESSAGE_ASHBY_DISCONNECTED_OR_CHANGED);
  }
  const client = clientForNamed({ access });
  const applicationId = input.item.applicationId;
  if (applicationId === null) {
    throw new Error(MESSAGE_ASHBY_REVIEW_ITEM_MISSING_APPLICATION);
  }
  const claim = await repositories().claimAshbyAction({
    workspaceId: input.review.workspaceId,
    meetingId: input.review.meetingId,
    kind: input.item.proposal.kind,
    targetId: applicationId,
    intent: { item: input.item, connectionVersion: input.review.connectionVersion },
  });
  if (!claim.acquired) {
    return syncItemWhenClaimNotAcquiredNamed({ review: input.review, item: input.item, claim, client });
  }
  try {
    await validateAshbyWriteTarget(client, input.item);
    const currentAccess = await ashbyReviewAccessNamed({
      meetingId: input.review.meetingId,
      userId: input.review.userId,
    });
    if (currentAccess === null || currentAccess.connectionVersion !== input.review.connectionVersion) {
      throw new Error(MESSAGE_ASHBY_DISCONNECTED_OR_CHANGED);
    }
    const transcriptInput = await transcriptNamed({ meetingId: input.review.meetingId });
    if (transcriptInput.hash !== input.review.inputHash) {
      throw new Error(MESSAGE_ASHBY_TRANSCRIPT_CHANGED_RUN_REVIEW_AGAIN);
    }
  } catch (error) {
    await repositories().finishAshbyAction({
      id: claim.id,
      status: "rejected",
      result: { reason: "target_validation" },
    });
    throw error;
  }

  return syncItemExecuteWriteNamed({ review: input.review, item: input.item, claimId: claim.id, client });
}

async function runAshbyReviewSyncCommandNamed(input: { review: AshbyReview; itemIds: string[] }): Promise<AshbyReview> {
  const items = await input.review.items.reduce<Promise<AshbyReviewItem[]>>(async (previous, item) => {
    const collected = await previous;
    if (!input.itemIds.includes(item.id) || item.status === "completed") {
      return [...collected, item];
    }
    try {
      return [...collected, await syncItemNamed({ review: input.review, item })];
    } catch (error) {
      return [...collected, { ...item, status: "failed", error: ashbyReviewError(error) }];
    }
  }, Promise.resolve([]));

  return changedNamed({
    review: input.review,
    patch: {
      items,
      status: items.every(
        (item) =>
          item.status !== "unknown" &&
          (item.status === "completed" || /** @external ashby review item wire field */ !item.included),
      )
        ? "completed"
        : "awaiting_user",
    },
  });
}

async function runAshbyReviewRefreshCommandNamed(input: {
  review: AshbyReview;
  access: AshbyReviewAccess;
  transcriptInput: AshbyMeetingTranscript;
  command: Record<string, unknown>;
  onUsage?: (usage: AshbyReviewUsage) => void;
}): Promise<AshbyReview> {
  const pending = input.review.items.filter((item) => item.status !== "completed");
  const analysis = await extractAshbyProposals({
    segments: input.transcriptInput.segments,
    apiKey: apiEnv().OPENAI_API_KEY,
    model: apiEnv().ASHBY_REVIEW_MODEL,
    complete: (request) =>
      executeMeetingResponse({
        meetingId: input.review.meetingId,
        userId: input.review.userId,
        source: "ashby_revision",
        actionType: "agent_workflow",
        request,
      }),
    onUsage: input.onUsage,
    ...(input.command.action === "revise"
      ? {
          instruction: String(input.command.instruction),
          existingProposals: pending.map((item) => item.proposal),
          availableTargets: pending.map((item) => ({
            candidateName: item.candidateName ?? item.proposal.candidateName,
            jobTitles: item.applications.map((application) => application.name),
            stageNames: item.stages.map((stage) => stage.name),
          })),
        }
      : {}),
  });
  const completedItems =
    analysis.clarification !== null
      ? input.review.items
      : input.review.items.filter((item) => item.status === "completed");
  const items =
    analysis.clarification !== null
      ? completedItems
      : await analysis.proposals.reduce(async (previous, proposal) => {
          const collected = await previous;

          return [
            ...collected,
            {
              ...(await resolveAshbyItem(clientForNamed({ access: input.access }), proposal)),
              /** @external ashby review item wire field */
              userEdited: input.command.action === "revise",
            },
          ];
        }, Promise.resolve(completedItems));

  return changedNamed({
    review: input.review,
    patch: {
      items,
      status: reviewAwaitingUserStatusNamed({ items, clarification: analysis.clarification }),
      inputHash: input.transcriptInput.hash,
      clarification: analysis.clarification,
      error: null,
    },
  });
}

async function applyAshbyReviewJobCommandNamed(input: {
  stored: NonNullable<Awaited<ReturnType<RepositoryPort["getAshbyReviewById"]>>>;
  onUsage?: (usage: AshbyReviewUsage) => void;
}): Promise<AshbyReview> {
  const current = input.stored.review;
  try {
    const access = await ashbyReviewAccessNamed({ meetingId: current.meetingId, userId: current.userId });
    if (access === null || access.connectionVersion !== current.connectionVersion) {
      throw new Error(MESSAGE_ASHBY_CONNECTION_CHANGED_RUN_REVIEW_AGAIN);
    }
    const transcriptInput = await transcriptNamed({ meetingId: current.meetingId });
    const command = input.stored.command;
    if (command === null) {
      throw new Error(MESSAGE_ASHBY_REVIEW_CHANGED_REFRESH);
    }
    if (command.action !== "refresh" && transcriptInput.hash !== current.inputHash) {
      throw new Error(MESSAGE_ASHBY_TRANSCRIPT_CHANGED_RUN_REVIEW_AGAIN);
    }
    if (command.action === "sync") {
      const itemIds = readPayloadStringArray(command.itemIds);
      if (itemIds === null) {
        throw new Error(MESSAGE_RESOLVE_SELECTED_ACTIONS_BEFORE_CONFIRM);
      }

      return await runAshbyReviewSyncCommandNamed({ review: current, itemIds });
    }

    return await runAshbyReviewRefreshCommandNamed({
      review: current,
      access,
      transcriptInput,
      command,
      onUsage: input.onUsage,
    });
  } catch (error) {
    return changedNamed({ review: current, patch: { status: "failed", error: ashbyReviewError(error) } });
  }
}

async function processAshbyReviewJobNamed(input: {
  job: AiWorkflowJobView;
  logger?: AshbyReviewJobLogger;
}): Promise<void> {
  const onUsage = (usage: AshbyReviewUsage) =>
    input.logger?.info({ ...usage, meetingId: input.job.meetingId }, ASHBY_REVIEW_MODEL_USAGE_LOG_MESSAGE);
  if (!apiEnv().ASHBY_POST_MEETING_REVIEW_ENABLED) {
    return;
  }
  const runId = readPayloadRunId(input.job.payload);
  if (runId === null) {
    await detectMeetingNamed({ meetingId: input.job.meetingId, onUsage });

    return;
  }
  const stored = await repositories().getAshbyReviewById({ id: runId });
  if (stored === null || stored.review.revision !== input.job.payload.revision || stored.command === null) {
    return;
  }
  const review = await applyAshbyReviewJobCommandNamed({ stored, onUsage });
  await repositories().saveAshbyReview({ review, expectedRevision: review.revision - 1 });
}

export async function processAshbyReviewJob(
  ...args: [job: AiWorkflowJobView, logger?: AshbyReviewJobLogger]
): Promise<void> {
  return processAshbyReviewJobNamed({ job: args[0], logger: args[1] });
}
