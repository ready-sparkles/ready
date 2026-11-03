"use client";

import type { LinearTaskReviewRun } from "@readymeet/shared";
import React, { useEffect, useRef, useState } from "react";

import {
  reviseLinearTaskReview,
  runLinearTaskReview,
  syncLinearTaskReview,
  updateLinearTaskReviewTarget,
} from "../../composition/api";

import { AgentThinkingBlock } from "./agent-thinking";
import { IntegrationActionMenu } from "./integration-action-menu";
import { useToast } from "./toast-provider";

const MAX_LINKED_ISSUES_IN_LABEL = 2;

const LINEAR_TASK_REVIEW_COPY = {
  completedTrackedInReady: "This work is now tracked in Linear and no longer appears in Ready.",
};

type ReviewItem = LinearTaskReviewRun["items"][number];
type PendingMode = "reviewing" | "revising" | "syncing" | null;

function LinearLogoMark({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 100 100" className={className} fill="currentColor">
      <path d="M1.225 61.523c-.222-.949.908-1.546 1.597-.857l36.512 36.512c.689.689.092 1.819-.857 1.597-18.425-4.323-32.93-18.827-37.252-37.252ZM.002 46.889a.99.99 0 0 0 .29.76L52.35 99.71a.99.99 0 0 0 .76.29c2.03-.132 4.023-.403 5.969-.805a.981.981 0 0 0 .466-1.655L2.462 40.454a.981.981 0 0 0-1.655.466 49.62 49.62 0 0 0-.805 5.969ZM4.21 29.705a.988.988 0 0 0 .185 1.145l64.755 64.755c.302.302.76.375 1.145.185a49.727 49.727 0 0 0 4.7-2.638.984.984 0 0 0 .16-1.528L8.376 24.845a.984.984 0 0 0-1.528.16 49.727 49.727 0 0 0-2.638 4.7ZM12.612 18.062a.99.99 0 0 1-.076-1.42C21.616 6.732 34.464.99 48.671.99 76.005.99 99.01 24.005 99.01 51.339c0 14.207-5.742 27.055-15.652 36.135a.99.99 0 0 1-1.42-.076L12.612 18.062Z" />
    </svg>
  );
}

function countWord(count: number) {
  return ["zero", "one", "two", "three", "four"][count] ?? String(count);
}

export function LinearTaskMark({ delayMs = 0 }: { delayMs?: number }) {
  return (
    <span
      className="debug-workspace-linear-task-mark"
      style={{ animationDelay: `${delayMs}ms` }}
      title="Suggested for Linear"
    >
      <LinearLogoMark />
    </span>
  );
}

function LinearDuplicateMark({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" fill="none" className={className}>
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="m8.25 3.75-4.5 4.5m6.5-2.5-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function hasAuthToken(token?: string): boolean {
  return token !== undefined && token !== "";
}

function isUnsyncedLegacyDuplicate({ review, item }: { review: LinearTaskReviewRun; item: ReviewItem }): boolean {
  return (
    review.status === "awaiting_user" &&
    item.targetAction === "create_duplicate" &&
    item.syncStatus === "pending" &&
    item.externalIssue === null &&
    item.relationId === null
  );
}

function getVisibleTargetAction({
  review,
  item,
}: {
  review: LinearTaskReviewRun;
  item: ReviewItem;
}): ReviewItem["targetAction"] {
  if (!isUnsyncedLegacyDuplicate({ review, item })) {
    return item.targetAction;
  }
  if (item.targetIssue !== null) {
    return "link_existing";
  }

  return "create";
}

function formatLinkedIdentifierLabel(linkedIdentifiers: string[]): string {
  if (linkedIdentifiers.length <= MAX_LINKED_ISSUES_IN_LABEL) {
    return linkedIdentifiers.join(" and ");
  }
  const lastIdentifier = linkedIdentifiers.at(-1);
  const prefix = linkedIdentifiers.slice(0, -1).join(", ");
  if (lastIdentifier === undefined) {
    return prefix;
  }

  return `${prefix}, and ${lastIdentifier}`;
}

function buildReviewTitle({
  createCount,
  linkCount,
  duplicateCount,
  matchCount,
  issueLabel,
  taskLabel,
}: {
  createCount: number;
  linkCount: number;
  duplicateCount: number;
  matchCount: number;
  issueLabel: string;
  taskLabel: string;
}): string {
  if (createCount === matchCount) {
    return `Create ${matchCount} ${issueLabel} in Linear`;
  }
  if (linkCount === matchCount) {
    return "Already tracked in Linear";
  }
  if (duplicateCount === matchCount) {
    return `Create ${duplicateCount} duplicate issue${duplicateCount === 1 ? "" : "s"} in Linear`;
  }

  return `Send ${matchCount} ${taskLabel} to Linear`;
}

function buildSuccessTitle({
  createCount,
  linkCount,
  duplicateCount,
  matchCount,
  issueLabel,
  taskLabel,
}: {
  createCount: number;
  linkCount: number;
  duplicateCount: number;
  matchCount: number;
  issueLabel: string;
  taskLabel: string;
}): string {
  if (createCount === matchCount) {
    return `Created ${matchCount} ${issueLabel} in Linear`;
  }
  if (linkCount === matchCount) {
    return `Updated ${linkCount} ${linkCount === 1 ? "issue" : "issues"} in Linear`;
  }
  if (duplicateCount === matchCount) {
    return `Created ${duplicateCount} duplicate issue${duplicateCount === 1 ? "" : "s"} in Linear`;
  }

  return `Sent ${matchCount} ${taskLabel} to Linear`;
}

function buildConfirmationLabel({
  createCount,
  linkCount,
  duplicateCount,
  linkedTarget,
  duplicateTarget,
}: {
  createCount: number;
  linkCount: number;
  duplicateCount: number;
  linkedTarget: ReviewItem["targetIssue"];
  duplicateTarget: ReviewItem["targetIssue"];
}): string {
  const createPart = createCount !== 0 ? `create ${createCount} issue${createCount === 1 ? "" : "s"}` : null;
  const linkPart =
    linkCount === 0
      ? null
      : linkedTarget !== null
        ? `add this meeting to ${linkedTarget.identifier}`
        : `update ${linkCount} existing issue${linkCount === 1 ? "" : "s"}`;
  const duplicatePart =
    duplicateCount === 0
      ? null
      : duplicateTarget !== null
        ? `create a duplicate of ${duplicateTarget.identifier}`
        : `create ${duplicateCount} duplicate issue${duplicateCount === 1 ? "" : "s"}`;

  return [createPart, linkPart, duplicatePart].filter((part): part is string => part !== null).join(", ");
}

function buildRecommendedChoiceLabel({
  createCount,
  linkCount,
  linkedIdentifierLabel,
}: {
  createCount: number;
  linkCount: number;
  linkedIdentifierLabel: string;
}): string {
  const linkPhrase =
    linkedIdentifierLabel.length > 0
      ? linkedIdentifierLabel
      : `${linkCount} existing issue${linkCount === 1 ? "" : "s"}`;
  const createPart = createCount !== 0 ? `Create ${createCount} new issue${createCount === 1 ? "" : "s"}` : null;
  const linkPart = linkCount !== 0 ? `update ${linkPhrase}` : null;
  const joined = [createPart, linkPart].filter((part): part is string => part !== null).join(" and ");
  if (joined.length === 0) {
    return joined;
  }

  return joined.replace(/^./, (character) => character.toUpperCase());
}

function countVisibleTargetActions({ review, items }: { review: LinearTaskReviewRun; items: ReviewItem[] }): {
  createCount: number;
  linkCount: number;
  duplicateCount: number;
} {
  const createCount = items.filter((item) => getVisibleTargetAction({ review, item }) === "create").length;
  const linkCount = items.filter((item) => getVisibleTargetAction({ review, item }) === "link_existing").length;
  const duplicateCount = items.filter((item) => getVisibleTargetAction({ review, item }) === "create_duplicate").length;

  return { createCount, linkCount, duplicateCount };
}

function deriveLinearReviewPresentation({
  review,
  pendingMode,
  token,
}: {
  review: LinearTaskReviewRun;
  pendingMode: PendingMode;
  token?: string;
}) {
  const reviewItemsKey = review.items.map((item) => `${item.id}:${item.updatedAt}`).join("|");
  const includedItems = review.items.filter((item) => item.included);
  const items =
    review.status === "completed" ? includedItems : includedItems.filter((item) => item.syncStatus !== "created");
  const matchCount = items.length;
  const issueLabel = matchCount === 1 ? "issue" : "issues";
  const taskLabel = matchCount === 1 ? "task" : "tasks";
  const effectiveStatus = pendingMode ?? review.status;
  const canConfirm = review.status === "awaiting_user" && matchCount > 0 && hasAuthToken(token) && pendingMode === null;
  const { createCount, linkCount, duplicateCount } = countVisibleTargetActions({ review, items });
  const linkedItems = items.filter(
    (item) => getVisibleTargetAction({ review, item }) === "link_existing" && item.targetIssue !== null,
  );
  const hasDirectChoice = linkedItems.length !== 0;
  const linkedIdentifiers = [
    ...new Set(linkedItems.flatMap((item) => (item.targetIssue !== null ? [item.targetIssue.identifier] : []))),
  ];
  const linkedIdentifierLabel = formatLinkedIdentifierLabel(linkedIdentifiers);
  const recommendedChoiceLabel = buildRecommendedChoiceLabel({ createCount, linkCount, linkedIdentifierLabel });
  const createAllChoiceLabel = `Create ${matchCount} new issue${matchCount === 1 ? "" : "s"}`;
  const linkedTarget =
    linkCount === 1
      ? items.find((item) => getVisibleTargetAction({ review, item }) === "link_existing")?.targetIssue
      : null;
  const duplicateTarget =
    duplicateCount === 1
      ? items.find((item) => getVisibleTargetAction({ review, item }) === "create_duplicate")?.targetIssue
      : null;
  const confirmationLabel = buildConfirmationLabel({
    createCount,
    linkCount,
    duplicateCount,
    linkedTarget: linkedTarget ?? null,
    duplicateTarget: duplicateTarget ?? null,
  });
  const reviewTitle = buildReviewTitle({
    createCount,
    linkCount,
    duplicateCount,
    matchCount,
    issueLabel,
    taskLabel,
  });
  const successTitle = buildSuccessTitle({
    createCount,
    linkCount,
    duplicateCount,
    matchCount,
    issueLabel,
    taskLabel,
  });

  return {
    reviewItemsKey,
    items,
    matchCount,
    taskLabel,
    effectiveStatus,
    canConfirm,
    linkedItems,
    hasDirectChoice,
    recommendedChoiceLabel,
    createAllChoiceLabel,
    confirmationLabel,
    reviewTitle,
    successTitle,
  };
}

function resolveLinearReviewSyncErrorToast({
  review,
}: {
  review: LinearTaskReviewRun;
}): { message: string; failedItemId: string; identifier?: string } | null {
  const failedItem = review.items.find((item) => item.syncStatus === "failed");
  const fromItem = failedItem?.syncError;
  const fromReview = review.phase === "sync_failed" ? review.error : null;
  const message = fromItem ?? fromReview;
  if (message === null || message === "") {
    return null;
  }

  const identifier = failedItem?.targetIssue?.identifier ?? failedItem?.externalIssue?.identifier;

  return {
    message,
    failedItemId: failedItem?.id ?? "review",
    identifier,
  };
}

function useLinearReviewSyncErrorToast({
  review,
  reviewItemsKey,
  showToast,
}: {
  review: LinearTaskReviewRun;
  reviewItemsKey: string;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  const lastReviewErrorToastRef = useRef<string | null>(null);

  useEffect(() => {
    if (review.status !== "awaiting_user") {
      lastReviewErrorToastRef.current = null;

      return;
    }
    const toastContent = resolveLinearReviewSyncErrorToast({ review });
    if (toastContent === null) {
      lastReviewErrorToastRef.current = null;

      return;
    }
    const toastKey = `${review.updatedAt}:${toastContent.failedItemId}:${toastContent.message}`;
    if (lastReviewErrorToastRef.current === toastKey) {
      return;
    }
    lastReviewErrorToastRef.current = toastKey;
    const title =
      toastContent.identifier !== undefined && toastContent.identifier !== ""
        ? `Couldn’t update ${toastContent.identifier}`
        : "Couldn’t update Linear";
    showToast({
      id: `linear-review-${review.id}-sync-error`,
      title,
      message: toastContent.message,
      tone: "warning",
    });
  }, [review.error, review.id, review.phase, review.status, review.updatedAt, reviewItemsKey, showToast]);
}

type LinearTaskReviewActionContext = {
  review: LinearTaskReviewRun;
  token?: string;
  correction: string;
  pendingMode: PendingMode;
  setPendingMode: React.Dispatch<React.SetStateAction<PendingMode>>;
  setCorrection: React.Dispatch<React.SetStateAction<string>>;
  onReviewChanged?: (review: LinearTaskReviewRun) => void;
  showToast: ReturnType<typeof useToast>["showToast"];
  canConfirm: boolean;
};

function showLinearReviewActionError({
  reviewId,
  showToast,
  error,
  fallback,
}: {
  reviewId: string;
  showToast: ReturnType<typeof useToast>["showToast"];
  error: unknown;
  fallback: string;
}) {
  showToast({
    id: `linear-review-${reviewId}-action-error`,
    title: "Couldn’t update Linear",
    message: error instanceof Error ? error.message : fallback,
    tone: "warning",
  });
}

async function runLinearReviewSubmitCorrection(context: LinearTaskReviewActionContext) {
  const trimmed = context.correction.trim();
  if (!hasAuthToken(context.token) || trimmed.length === 0 || context.pendingMode !== null) {
    return;
  }
  const token = context.token;
  if (token === undefined) {
    return;
  }
  context.setPendingMode("revising");
  try {
    const updated = await reviseLinearTaskReview({ token, runId: context.review.id, instruction: trimmed });
    if (updated !== null) {
      context.onReviewChanged?.(updated);
    }
    context.setCorrection("");
  } catch (error) {
    showLinearReviewActionError({
      reviewId: context.review.id,
      showToast: context.showToast,
      error,
      fallback: "Could not apply that change.",
    });
  } finally {
    context.setPendingMode(null);
  }
}

async function runLinearReviewConfirmSync(context: LinearTaskReviewActionContext) {
  if (!hasAuthToken(context.token) || !context.canConfirm) {
    return;
  }
  const token = context.token;
  if (token === undefined) {
    return;
  }
  const { review } = context;
  context.setPendingMode("syncing");
  try {
    await review.items.reduce(async (previous, item) => {
      await previous;
      if (!item.included || !isUnsyncedLegacyDuplicate({ review, item })) {
        return;
      }
      await updateLinearTaskReviewTarget({
        token,
        runId: review.id,
        itemId: item.id,
        input: {
          action: item.targetIssue !== null ? "link_existing" : "create",
          issueId: item.targetIssue?.id ?? null,
        },
      });
    }, Promise.resolve());
    const updated = await syncLinearTaskReview({ token, runId: review.id });
    if (updated !== null) {
      context.onReviewChanged?.(updated);
    }
  } catch (error) {
    showLinearReviewActionError({
      reviewId: review.id,
      showToast: context.showToast,
      error,
      fallback: "Could not finish the Linear changes.",
    });
  } finally {
    context.setPendingMode(null);
  }
}

async function runLinearReviewRetry(context: LinearTaskReviewActionContext) {
  if (!hasAuthToken(context.token) || context.pendingMode !== null) {
    return;
  }
  const token = context.token;
  if (token === undefined) {
    return;
  }
  context.setPendingMode("reviewing");
  try {
    const updated = await runLinearTaskReview({ token, meetingId: context.review.meetingId });
    if (updated !== null) {
      context.onReviewChanged?.(updated);
    }
  } catch (error) {
    showLinearReviewActionError({
      reviewId: context.review.id,
      showToast: context.showToast,
      error,
      fallback: "Could not retry the Linear review.",
    });
  } finally {
    context.setPendingMode(null);
  }
}

async function runLinearReviewConfirmCreateAll(context: LinearTaskReviewActionContext) {
  if (!hasAuthToken(context.token) || !context.canConfirm) {
    return;
  }
  const token = context.token;
  if (token === undefined) {
    return;
  }
  const { review } = context;
  context.setPendingMode("syncing");
  try {
    await review.items.reduce(async (previous, item) => {
      await previous;
      if (!item.included || item.syncStatus === "created" || getVisibleTargetAction({ review, item }) === "create") {
        return;
      }
      await updateLinearTaskReviewTarget({
        token,
        runId: review.id,
        itemId: item.id,
        input: {
          action: "create",
          issueId: null,
        },
      });
    }, Promise.resolve());
    const synced = await syncLinearTaskReview({ token, runId: review.id });
    if (synced !== null) {
      context.onReviewChanged?.(synced);
    }
  } catch (error) {
    showLinearReviewActionError({
      reviewId: review.id,
      showToast: context.showToast,
      error,
      fallback: "Could not finish the Linear changes.",
    });
  } finally {
    context.setPendingMode(null);
  }
}

function createLinearTaskReviewActions(context: LinearTaskReviewActionContext) {
  return {
    submitCorrection: () => runLinearReviewSubmitCorrection(context),
    confirmSync: () => runLinearReviewConfirmSync(context),
    retryReview: () => runLinearReviewRetry(context),
    confirmCreateAll: () => runLinearReviewConfirmCreateAll(context),
  };
}

function LinearTaskReviewRevisingView({ correction }: { correction: string }) {
  const detail = /\b(merge|combine|single issue|one issue|same issue)\b/i.test(correction)
    ? "Combining two tasks into a single issue."
    : "Updating the Linear issue suggestions.";

  return (
    <AgentThinkingBlock
      title="Applying your change"
      detail={detail}
      className="debug-workspace-task-aligned workspace-flow-reveal"
    />
  );
}

function LinearTaskReviewCompletedView({ successTitle, items }: { successTitle: string; items: ReviewItem[] }) {
  return (
    <section className="debug-workspace-linear-confirmation is-revealed workspace-linear-review-complete">
      <div className="debug-workspace-linear-menu-copy">
        <div className="debug-workspace-linear-confirmation-title">
          <LinearLogoMark className="debug-workspace-linear-confirmation-logo" />
          <h5>{successTitle}</h5>
        </div>
        <p>{LINEAR_TASK_REVIEW_COPY.completedTrackedInReady}</p>
      </div>
      <div className="workspace-linear-review-links">
        {items.flatMap((item) => {
          const completedIssue =
            item.externalIssue ?? (item.targetAction === "link_existing" ? item.targetIssue : null);

          if (completedIssue === null) {
            return [];
          }

          return [
            <a key={item.id} href={completedIssue.url} target="_blank" rel="noreferrer">
              {completedIssue.identifier} · {completedIssue.title}
            </a>,
          ];
        })}
      </div>
    </section>
  );
}

function LinearTaskReviewFailureView({
  review,
  token,
  pendingMode,
  onRetry,
}: {
  review: LinearTaskReviewRun;
  token?: string;
  pendingMode: PendingMode;
  onRetry: () => void;
}) {
  const isRetryDisabled = !hasAuthToken(token) || pendingMode !== null;

  return (
    <section className="debug-workspace-linear-confirmation is-revealed workspace-linear-review-error">
      <div className="debug-workspace-linear-menu-copy">
        <div className="debug-workspace-linear-confirmation-title">
          <LinearLogoMark className="debug-workspace-linear-confirmation-logo" />
          <h5>{review.status === "needs_connection" ? "Reconnect Linear" : "Linear review needs attention"}</h5>
        </div>
        <p>{review.error ?? "Ready could not finish reviewing these tasks."}</p>
      </div>
      {review.status === "needs_connection" ? (
        <a className="workspace-linear-review-settings-link" href="/workspace/settings?tab=connectors">
          Open connector settings
        </a>
      ) : (
        <button
          type="button"
          className="workspace-linear-review-settings-link workspace-linear-review-retry-button"
          disabled={isRetryDisabled}
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </section>
  );
}

function LinearTaskReviewAwaitingView({
  review,
  presentation,
  correction,
  setCorrection,
  pendingMode,
  onSubmitCorrection,
  onConfirmSync,
  onConfirmCreateAll,
}: {
  review: LinearTaskReviewRun;
  presentation: ReturnType<typeof deriveLinearReviewPresentation>;
  correction: string;
  setCorrection: React.Dispatch<React.SetStateAction<string>>;
  pendingMode: PendingMode;
  onSubmitCorrection: () => void;
  onConfirmSync: () => void;
  onConfirmCreateAll: () => void;
}) {
  const {
    reviewItemsKey,
    matchCount,
    taskLabel,
    canConfirm,
    linkedItems,
    hasDirectChoice,
    recommendedChoiceLabel,
    createAllChoiceLabel,
    confirmationLabel,
    reviewTitle,
  } = presentation;
  const confirmationChoiceLabel = confirmationLabel.length > 0 ? confirmationLabel : `create ${matchCount}`;

  return (
    <IntegrationActionMenu
      key={`${review.id}:${review.updatedAt}:${reviewItemsKey}`}
      provider="Linear"
      icon={<LinearLogoMark />}
      title={reviewTitle}
      description={
        hasDirectChoice
          ? `Ready found existing work in Linear for this meeting.`
          : `Ready found ${countWord(matchCount)} product ${taskLabel} from this meeting that ${matchCount === 1 ? "belongs" : "belong"} in Linear.`
      }
      choices={
        hasDirectChoice
          ? [
              { label: recommendedChoiceLabel, onSend: onConfirmSync, disabled: !canConfirm },
              { label: createAllChoiceLabel, onSend: onConfirmCreateAll, disabled: !canConfirm },
            ]
          : [
              {
                label: `Yes, ${confirmationChoiceLabel}`,
                onSend: onConfirmSync,
                disabled: !canConfirm,
              },
            ]
      }
      correction={correction}
      onCorrection={setCorrection}
      onRevise={onSubmitCorrection}
      busy={pendingMode !== null}
    >
      {linkedItems.length !== 0 ? (
        <div className="workspace-linear-existing-matches" aria-label="Existing Linear issues">
          {linkedItems.map((item) => {
            const issue = item.targetIssue;
            if (issue === null) {
              return null;
            }

            return (
              <a
                className="workspace-linear-duplicate-candidate"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                key={item.id}
              >
                <LinearDuplicateMark />
                <strong>{issue.identifier}</strong>
                <span>{issue.title}</span>
              </a>
            );
          })}
        </div>
      ) : null}
    </IntegrationActionMenu>
  );
}

function renderLinearTaskReviewPanelBody({
  review,
  correction,
  setCorrection,
  token,
  pendingMode,
  presentation,
  actions,
}: {
  review: LinearTaskReviewRun;
  correction: string;
  setCorrection: React.Dispatch<React.SetStateAction<string>>;
  token?: string;
  pendingMode: PendingMode;
  presentation: ReturnType<typeof deriveLinearReviewPresentation>;
  actions: ReturnType<typeof createLinearTaskReviewActions>;
}) {
  const { effectiveStatus, matchCount, items, successTitle } = presentation;

  if (effectiveStatus === "queued" || effectiveStatus === "reviewing") {
    return null;
  }

  if (effectiveStatus === "revising") {
    return <LinearTaskReviewRevisingView correction={correction} />;
  }

  if (effectiveStatus === "syncing") {
    return (
      <AgentThinkingBlock
        title="Updating Linear"
        detail="Sending the confirmed tasks to Linear."
        className="debug-workspace-task-aligned workspace-flow-reveal"
      />
    );
  }

  if (review.status === "completed") {
    return <LinearTaskReviewCompletedView successTitle={successTitle} items={items} />;
  }

  if (review.status === "needs_connection" || review.status === "failed") {
    return (
      <LinearTaskReviewFailureView
        review={review}
        token={token}
        pendingMode={pendingMode}
        onRetry={() => {
          void actions.retryReview();
        }}
      />
    );
  }

  if (review.status !== "awaiting_user" || matchCount === 0) {
    return null;
  }

  return (
    <LinearTaskReviewAwaitingView
      review={review}
      presentation={presentation}
      correction={correction}
      setCorrection={setCorrection}
      pendingMode={pendingMode}
      onSubmitCorrection={() => {
        void actions.submitCorrection();
      }}
      onConfirmSync={() => {
        void actions.confirmSync();
      }}
      onConfirmCreateAll={() => {
        void actions.confirmCreateAll();
      }}
    />
  );
}

export function LinearTaskReviewPanel({
  review,
  token,
  onReviewChanged,
}: {
  review: LinearTaskReviewRun;
  token?: string;
  onReviewChanged?: (review: LinearTaskReviewRun) => void;
}) {
  const [correction, setCorrection] = useState("");
  const [pendingMode, setPendingMode] = useState<PendingMode>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (review.status !== "awaiting_user") {
      setCorrection("");
    }
  }, [review.status]);

  const presentation = deriveLinearReviewPresentation({ review, pendingMode, token });
  useLinearReviewSyncErrorToast({ review, reviewItemsKey: presentation.reviewItemsKey, showToast });
  const actions = createLinearTaskReviewActions({
    review,
    token,
    correction,
    pendingMode,
    setPendingMode,
    setCorrection,
    onReviewChanged,
    showToast,
    canConfirm: presentation.canConfirm,
  });

  return renderLinearTaskReviewPanelBody({
    review,
    correction,
    setCorrection,
    token,
    pendingMode,
    presentation,
    actions,
  });
}
