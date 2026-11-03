"use client";

import type { AshbyReview, AshbyReviewAction, AshbyReviewItem } from "@readymeet/shared";
import { useEffect, useRef, useState } from "react";

import { getAshbyReview, updateAshbyReview } from "../../composition/api";
import { createTimerGroup } from "../lib/timer-group";

import { AgentThinkingBlock } from "./agent-thinking";
import { AshbyLogo } from "./ashby-connector";
import { IntegrationActionMenu } from "./integration-action-menu";

const ASHBY_REVIEW_POLL_INTERVAL_MS = 5_000;
const ASHBY_REVIEW_UPDATE_ERROR_MESSAGE = "Could not update the Ashby review.";
const ASHBY_REVIEW_COMPLETED_HEADING = "Updated Ashby";

const ASHBY_BUSY_STATUSES = ["queued", "reviewing", "revising", "syncing"];

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

function isResolved(item: AshbyReviewItem) {
  return (
    isNonEmptyString(item.candidateId) &&
    isNonEmptyString(item.applicationId) &&
    isNonEmptyString(item.stageId) &&
    isNonEmptyString(item.currentStageId)
  );
}

function hasClarification(review: AshbyReview): boolean {
  return isNonEmptyString(review.clarification);
}

function shouldHideAshbyPanel(params: { review: AshbyReview; includedItemCount: number }): boolean {
  const { review, includedItemCount } = params;
  if (review.status === "dismissed") {
    return true;
  }
  if (hasClarification(review)) {
    return false;
  }
  if (review.status === "no_matches") {
    return true;
  }

  return includedItemCount === 0 && review.status === "awaiting_user";
}

function buildAshbyItemDescription(params: { review: AshbyReview; item: AshbyReviewItem }): string {
  const { review, item } = params;
  const applicationName = item.applications.find((application) => application.id === item.applicationId)?.name;
  const stageName = item.stages.find((stage) => stage.id === item.stageId)?.name ?? item.proposal.stageName;
  const candidateLabel = item.candidateName ?? item.proposal.candidateName;
  const currentStageLabel = item.currentStageName ?? "their current stage";
  const verb = review.status === "completed" ? "Moved" : "Move";
  const applicationSuffix = isNonEmptyString(applicationName) ? ` for ${applicationName}` : "";

  return `${verb} ${candidateLabel} from ${currentStageLabel} to ${stageName}${applicationSuffix}.`;
}

function buildAshbyReviewDescription(params: { review: AshbyReview; items: AshbyReviewItem[] }): string {
  return params.items.map((item) => buildAshbyItemDescription({ review: params.review, item })).join(" ");
}

function getAshbyChoiceLabel(params: { shouldRetry: boolean; items: AshbyReviewItem[] }): string {
  if (params.shouldRetry) {
    return "Run review again";
  }
  if (params.items.some((item) => item.status === "unknown")) {
    return "Check result";
  }

  return "Yes, update stage";
}

function AshbyReviewCompletedView(params: { description: string }) {
  return (
    <section className="debug-workspace-linear-confirmation is-revealed workspace-linear-review-complete">
      <div className="debug-workspace-linear-menu-copy">
        <div className="debug-workspace-linear-confirmation-title">
          <AshbyLogo className="debug-workspace-linear-confirmation-logo" />
          <h5>{ASHBY_REVIEW_COMPLETED_HEADING}</h5>
        </div>
        <p>{params.description}</p>
      </div>
    </section>
  );
}

function AshbyReviewTargetFieldSelect(params: {
  field: "candidateId" | "applicationId" | "stageId";
  label: string;
  item: AshbyReviewItem;
  review: AshbyReview;
  onAct: (action: AshbyReviewAction) => void;
}) {
  const { field, label, item, review, onAct } = params;
  const options =
    field === "candidateId" ? item.candidates : field === "applicationId" ? item.applications : item.stages;
  const selectedValue = item[field] ?? "";

  return (
    <label>
      {label}
      <select
        aria-label={`${label} for ${item.proposal.candidateName}`}
        value={selectedValue}
        disabled={options.length === 0}
        onChange={(event) => {
          const nextValue = event.target.value !== "" ? event.target.value : null;
          onAct({
            action: "target",
            revision: review.revision,
            itemId: item.id,
            candidateId: item.candidateId,
            applicationId: item.applicationId,
            stageId: item.stageId,
            [field]: nextValue,
          });
        }}
      >
        <option value="">Choose {label.toLowerCase()}</option>
        {options.map((option) => {
          const email = "email" in option && typeof option.email === "string" ? option.email : undefined;
          const emailSuffix = isNonEmptyString(email) ? ` (${email})` : "";

          return (
            <option key={option.id} value={option.id}>
              {option.name}
              {emailSuffix}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function AshbyReviewTargetFields(params: {
  items: AshbyReviewItem[];
  review: AshbyReview;
  isBusy: boolean;
  onAct: (action: AshbyReviewAction) => void;
}) {
  return params.items
    .filter((item) => !isResolved(item) && !["completed", "unknown"].includes(item.status))
    .map((item) => (
      <fieldset key={item.id} className="workspace-ashby-targets" disabled={params.isBusy}>
        <legend>{item.candidateName ?? item.proposal.candidateName}</legend>
        <AshbyReviewTargetFieldSelect
          field="candidateId"
          label="Candidate"
          item={item}
          review={params.review}
          onAct={params.onAct}
        />
        <AshbyReviewTargetFieldSelect
          field="applicationId"
          label="Application"
          item={item}
          review={params.review}
          onAct={params.onAct}
        />
        <AshbyReviewTargetFieldSelect
          field="stageId"
          label="Stage"
          item={item}
          review={params.review}
          onAct={params.onAct}
        />
      </fieldset>
    ));
}

function AshbyReviewStatusMessages(params: { review: AshbyReview; error: string | null; items: AshbyReviewItem[] }) {
  const { review, error, items } = params;
  const reviewError = review.error;
  const hasReviewError = isNonEmptyString(reviewError);
  const hasLocalError = isNonEmptyString(error);
  const alertMessage = hasLocalError ? error : reviewError;

  return (
    <>
      {hasReviewError || hasLocalError ? <p role="alert">{alertMessage}</p> : null}
      {items
        .filter((item) => isNonEmptyString(item.error))
        .map((item) => (
          <p key={item.id} role="status">
            {item.error}
          </p>
        ))}
      {hasClarification(review) ? <p role="status">{review.clarification}</p> : null}
    </>
  );
}

/** Local state intentionally avoids the persisted/shared meeting query cache. */
export function AshbyMeetingReview({ meetingId, token }: { meetingId: string; token: string }) {
  const [review, setReview] = useState<AshbyReview | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    const pollState = { isCancelled: false };
    const timers = createTimerGroup();
    setReview(null);
    const poll = async () => {
      if (!document.hidden) {
        try {
          const response = await getAshbyReview({ token, meetingId });
          const next = response.review;
          if (!pollState.isCancelled && generation.current === current) {
            setReview((previous) =>
              next && previous?.id === next.id && previous.revision > next.revision ? previous : next,
            );
          }
          if (!response.enabled) {
            return;
          }
        } catch (error) {
          const isPollFailure = error instanceof Error || error !== undefined;
          if (isPollFailure && !pollState.isCancelled && generation.current === current) {
            setReview(null);
          }
        }
      }
      if (!pollState.isCancelled) {
        timers.setTimeout({ run: () => void poll(), delayMs: ASHBY_REVIEW_POLL_INTERVAL_MS });
      }
    };
    void poll();

    return () => {
      pollState.isCancelled = true;
      timers.clear();
      generation.current++;
    };
  }, [meetingId, token]);
  if (!review) {
    return null;
  }

  return (
    <AshbyReviewPanel
      key={review.id}
      review={review}
      token={token}
      onChanged={(next) =>
        setReview((previous) =>
          next && previous?.id === next.id && previous.revision > next.revision ? previous : next,
        )
      }
    />
  );
}

export function AshbyReviewPanel({
  review,
  token,
  onChanged,
}: {
  review: AshbyReview;
  token: string;
  onChanged: (review: AshbyReview | null) => void;
}) {
  const [correction, setCorrection] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = review.items.filter((item) => item.included);
  const selected = items.filter((item) => item.status !== "completed").map((item) => item.id);
  const canConfirm = selected.length !== 0 && items.every(isResolved) && !hasClarification(review);
  const isBusy = isPending || ASHBY_BUSY_STATUSES.includes(review.status);

  async function act(action: AshbyReviewAction) {
    if (isBusy) {
      return;
    }
    setIsPending(true);
    setError(null);
    try {
      onChanged(await updateAshbyReview({ token, meetingId: review.meetingId, action }));
      if (action.action === "revise") {
        setCorrection("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ASHBY_REVIEW_UPDATE_ERROR_MESSAGE);
    } finally {
      setIsPending(false);
    }
  }

  if (shouldHideAshbyPanel({ review, includedItemCount: items.length })) {
    return null;
  }
  if (["queued", "reviewing"].includes(review.status)) {
    return null;
  }
  if (["revising", "syncing"].includes(review.status)) {
    return (
      <AgentThinkingBlock
        className="debug-workspace-task-aligned"
        title={review.status === "syncing" ? "Updating Ashby" : "Applying your change"}
        detail={
          review.status === "syncing"
            ? "Applying only the changes you confirmed."
            : "Checking agreed interview stage changes."
        }
      />
    );
  }

  const description = buildAshbyReviewDescription({ review, items });
  if (review.status === "completed") {
    return <AshbyReviewCompletedView description={description} />;
  }

  const shouldRetry = review.status === "failed" || review.status === "stale";
  const choiceLabel = getAshbyChoiceLabel({ shouldRetry, items });

  return (
    <IntegrationActionMenu
      key={`${review.id}:${review.revision}`}
      provider="Ashby"
      icon={<AshbyLogo />}
      title="Update candidate stage in Ashby?"
      description={description}
      choices={[
        {
          label: choiceLabel,
          disabled: isBusy || (!shouldRetry && !canConfirm),
          onSend: () =>
            void act(
              shouldRetry
                ? { action: "retry", revision: review.revision }
                : { action: "confirm", revision: review.revision, itemIds: selected },
            ),
        },
      ]}
      correction={correction}
      onCorrection={setCorrection}
      onRevise={() => void act({ action: "revise", revision: review.revision, instruction: correction.trim() })}
      busy={isBusy}
      correctionDisabled={items.some((item) => item.status === "unknown")}
    >
      <AshbyReviewTargetFields
        items={items}
        review={review}
        isBusy={isBusy}
        onAct={(action) => {
          void act(action);
        }}
      />
      <AshbyReviewStatusMessages review={review} error={error} items={items} />
    </IntegrationActionMenu>
  );
}
