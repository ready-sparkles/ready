"use client";

import type { SlackMeetingReview } from "@readymeet/shared";
import type React from "react";
import { useEffect, useState } from "react";

import { actOnSlackReview, getApiErrorMessage } from "../../composition/api";

import { IntegrationActionMenu } from "./integration-action-menu";
import { SlackLogo } from "./slack-logo";
import { useToast } from "./toast-provider";

const SLACK_MEETING_REVIEW_COPY = {
  prepareFailedFallback: "Could not prepare Slack sharing.",
  deliveryUnconfirmed: "Slack delivery could not be confirmed. Check Slack before sharing again.",
  toastTitle: "Couldn't share on Slack",
  refreshReviewAction: "Refresh review",
  updateFailedFallback: "Could not update Slack sharing.",
  completedTitle: "Meeting summary sent to Slack.",
  sentToPrefix: "Sent to",
  sendingStatus: "Slack delivery has started. Check Slack before trying to share again.",
  shareTitle: "Share on Slack",
  sendSummaryPrefix: "Send this summary to",
  noMatchingSlackAccounts: "No other participants have a matching Slack account.",
  confirmSendLabel: "Yes, send to Slack",
  channelChangeHint: "To change this, enter “Use #channel-name”, “Use DMs”, or “Exclude name or email”.",
  sentToSentenceSuffix: ".",
} as const;

function formatSentToDestination(destination: string): string {
  return `${SLACK_MEETING_REVIEW_COPY.sentToPrefix} ${destination}${SLACK_MEETING_REVIEW_COPY.sentToSentenceSuffix}`;
}

function formatSendSummaryDescription(destination: string): string {
  return `${SLACK_MEETING_REVIEW_COPY.sendSummaryPrefix} ${destination}${SLACK_MEETING_REVIEW_COPY.sentToSentenceSuffix}`;
}

function slackReviewDestination(review: SlackMeetingReview): string {
  const recipients = review.recipients.filter((r) => r.included);
  const channelName = review.channel?.name ?? "";

  return review.mode === "channel"
    ? `#${channelName}`
    : new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" }).format(recipients.map((r) => r.name));
}

function useSlackMeetingReviewPanelState({ meetingId, token }: { meetingId: string; token: string }) {
  const { showToast, dismissToast } = useToast();
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [review, setReview] = useState<SlackMeetingReview | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setReview(null);
    setError(null);
    void (async () => {
      try {
        const value = await actOnSlackReview({
          token,
          meetingId,
          action: "prepare",
          body: { refresh: prepareAttempt > 0 },
        });
        if (!controller.signal.aborted) {
          setReview(value);
        }
      } catch (nextError) {
        if (!controller.signal.aborted) {
          setError(getApiErrorMessage({ error: nextError, fallback: SLACK_MEETING_REVIEW_COPY.prepareFailedFallback }));
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [meetingId, token, prepareAttempt]);
  useEffect(() => {
    const message =
      error ?? (review?.status === "failed" ? (review.error ?? SLACK_MEETING_REVIEW_COPY.deliveryUnconfirmed) : null);
    if (message === null || message === "") {
      return;
    }
    const id = `slack-review-${meetingId}-error`;
    showToast({
      id,
      title: SLACK_MEETING_REVIEW_COPY.toastTitle,
      message,
      tone: "warning",
      ...(review?.status === "failed"
        ? {}
        : {
            action: {
              label: SLACK_MEETING_REVIEW_COPY.refreshReviewAction,
              onClick: () => setPrepareAttempt((attempt) => attempt + 1),
            },
          }),
    });

    return () => dismissToast(id);
  }, [error, review, meetingId, showToast, dismissToast]);
  async function act(action: "confirm" | "revise" | "prepare") {
    if (isBusy) {
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      setReview(
        await actOnSlackReview({
          token,
          meetingId,
          action,
          body: {
            version: review?.version,
            instruction: correction,
            refresh: action === "prepare",
          },
        }),
      );
      setCorrection("");
    } catch (nextError) {
      setError(getApiErrorMessage({ error: nextError, fallback: SLACK_MEETING_REVIEW_COPY.updateFailedFallback }));
    } finally {
      setIsBusy(false);
    }
  }

  return { review, correction, setCorrection, isBusy, act };
}

function SlackMeetingReviewCompletedView({ destination }: { destination: string }): React.ReactElement {
  return (
    <section className="debug-workspace-linear-confirmation is-revealed workspace-linear-review-complete" role="status">
      <div className="debug-workspace-linear-menu-copy">
        <div className="debug-workspace-linear-confirmation-title">
          <span className="integration-menu-icon">
            <SlackLogo />
          </span>
          <h5>{SLACK_MEETING_REVIEW_COPY.completedTitle}</h5>
        </div>
        <p>{formatSentToDestination(destination)}</p>
      </div>
    </section>
  );
}

function SlackMeetingReviewShareMenu({
  review,
  destination,
  correction,
  setCorrection,
  isBusy,
  act,
}: {
  review: SlackMeetingReview;
  destination: string;
  correction: string;
  setCorrection: (value: string) => void;
  isBusy: boolean;
  act: (action: "confirm" | "revise" | "prepare") => Promise<void>;
}): React.ReactElement {
  const recipients = review.recipients.filter((r) => r.included);

  return (
    <IntegrationActionMenu
      provider="Slack"
      icon={<SlackLogo />}
      title={SLACK_MEETING_REVIEW_COPY.shareTitle}
      description={
        review.mode === "channel" || recipients.length !== 0
          ? formatSendSummaryDescription(destination)
          : SLACK_MEETING_REVIEW_COPY.noMatchingSlackAccounts
      }
      choices={[
        {
          label: SLACK_MEETING_REVIEW_COPY.confirmSendLabel,
          onSend: () => void act("confirm"),
          disabled: review.mode === "dm" && recipients.length === 0,
        },
      ]}
      correction={correction}
      onCorrection={setCorrection}
      onRevise={() => void act("revise")}
      busy={isBusy}
    >
      {review.channelEligible ? <p>{SLACK_MEETING_REVIEW_COPY.channelChangeHint}</p> : null}
    </IntegrationActionMenu>
  );
}

export function SlackMeetingReviewPanel({
  meetingId,
  token,
}: {
  meetingId: string;
  token: string;
}): React.ReactElement | null {
  const { review, correction, setCorrection, isBusy, act } = useSlackMeetingReviewPanelState({ meetingId, token });
  if (review === null) {
    return null;
  }
  if (review.status === "dismissed") {
    return null;
  }
  const destination = slackReviewDestination(review);
  if (review.status === "completed") {
    return <SlackMeetingReviewCompletedView destination={destination} />;
  }
  if (review.status === "failed") {
    return null;
  }
  if (review.status === "sending") {
    return <p role="status">{SLACK_MEETING_REVIEW_COPY.sendingStatus}</p>;
  }

  return (
    <SlackMeetingReviewShareMenu
      review={review}
      destination={destination}
      correction={correction}
      setCorrection={setCorrection}
      isBusy={isBusy}
      act={act}
    />
  );
}
