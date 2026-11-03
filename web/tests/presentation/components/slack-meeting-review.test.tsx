import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SlackMeetingReview } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { render, fireEvent, waitFor, cleanup } = await import("@testing-library/react");

const { ToastProvider } = await import("../../../presentation/components/toast-provider");
const { SlackMeetingReviewPanel } = await import("../../../presentation/components/slack-meeting-review");

const HTTP_BAD_REQUEST = 400;
const EXPECTED_PREPARE_AND_RETRY_CALLS = 2;

const SLACK_MEETING_REVIEW_TEST_COPY = {
  reconnectSlackInSettings: "Reconnect Slack in Settings.",
  checkSlackBeforeSharingAgain: "Check Slack before sharing again.",
  sendSummaryToAlex: "Send this summary to Personaa.",
  meetingSummarySentToSlack: "Meeting summary sent to Slack.",
  noMatchingSlackAccountPattern: /No other participants have a matching Slack account/,
  tellDifferentlyForSlack: "Tell differently for Slack",
  submitCorrection: "Submit correction",
  yesSendToSlack: "Yes, send to Slack",
  slackReviewLabel: "Slack review",
  refreshReview: "Refresh review",
  notNow: "Not now",
  expectedSubmitCorrectionButton: "Expected submit correction button",
  expectedTellDifferentlyForSlackInput: "Expected tell differently for Slack input",
  expectedYesSendToSlackButton: "Expected yes send to Slack button",
};

function appendCall(input: { calls: string[]; url: string }): string[] {
  return [...input.calls, input.url];
}

function requiredHtmlButtonElement(input: { element: Element; label: string }): HTMLButtonElement {
  if (!(input.element instanceof HTMLButtonElement)) {
    throw new Error(input.label);
  }

  return input.element;
}

function requiredHtmlInputElement(input: { element: Element; label: string }): HTMLInputElement {
  if (!(input.element instanceof HTMLInputElement)) {
    throw new Error(input.label);
  }

  return input.element;
}

function assertTextPresent(input: { screen: Pick<ReturnType<typeof render>, "queryByText">; text: string | RegExp }) {
  assert.notEqual(input.screen.queryByText(input.text), null);
}

function assertRolePresent(input: {
  screen: Pick<ReturnType<typeof render>, "queryByRole">;
  role: string;
  name: string | RegExp;
}) {
  assert.notEqual(input.screen.queryByRole(input.role, { name: input.name }), null);
}

function assertLabelPresent(input: { screen: Pick<ReturnType<typeof render>, "queryByLabelText">; label: string }) {
  assert.notEqual(input.screen.queryByLabelText(input.label), null);
}

const review: SlackMeetingReview = {
  id: "11111111-1111-4111-8111-111111111111",
  meetingId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  sender: { slackUserId: "USENDER", name: "Personbr" },
  version: 1,
  status: "awaiting_user",
  teamId: "T1",
  teamName: "Example",
  connectionKey: "key",
  sourceHash: "hash",
  /** @external slack meeting review contract */
  channelEligible: false,
  reason: "Only personal DMs are available.",
  mode: "dm",
  channel: null,
  recipients: [
    {
      userId: "1",
      slackUserId: "U1",
      name: "Personaa",
      email: "personaa@example.com",
      /** @external slack meeting review recipient contract */
      included: true,
    },
  ],
  unmatchedNames: ["Personbz"],
  title: "Planning",
  summary: "A summary",
  tasks: [],
  error: null,
};
void test("Slack prepares without sending and sends only on Yes", async (t) => {
  const callLog = { urls: [] as string[] };
  t.after(cleanup);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    callLog.urls = appendCall({ calls: callLog.urls, url });

    return Response.json({ review: url.endsWith("/confirm") ? { ...review, status: "completed" } : review });
  });
  const view = render(
    <ToastProvider>
      <SlackMeetingReviewPanel meetingId={review.meetingId} token="fixture" />
    </ToastProvider>,
  );
  await waitFor(() => assertTextPresent({ screen: view, text: SLACK_MEETING_REVIEW_TEST_COPY.sendSummaryToAlex }));
  assert.equal(Boolean(view.queryByText(/Personbz/)), false);
  assert.equal(callLog.urls.length, 1);
  const prepareCall = callLog.urls[0];
  assert.ok(prepareCall !== undefined && prepareCall.endsWith("/prepare"));
  fireEvent.click(view.getByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.yesSendToSlack }));
  await waitFor(() =>
    assertTextPresent({ screen: view, text: SLACK_MEETING_REVIEW_TEST_COPY.meetingSummarySentToSlack }),
  );
  assert.equal(callLog.urls.filter((url) => url.endsWith("/confirm")).length, 1);
});
void test("corrections return to review without sending and no dismiss option is shown", async (t) => {
  const callLog = { urls: [] as string[] };
  t.after(cleanup);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    callLog.urls = appendCall({ calls: callLog.urls, url });

    return Response.json({ review });
  });
  const view = render(
    <ToastProvider>
      <SlackMeetingReviewPanel meetingId={review.meetingId} token="fixture" />
    </ToastProvider>,
  );
  await waitFor(() =>
    assertRolePresent({ screen: view, role: "textbox", name: SLACK_MEETING_REVIEW_TEST_COPY.tellDifferentlyForSlack }),
  );
  fireEvent.change(view.getByRole("textbox", { name: SLACK_MEETING_REVIEW_TEST_COPY.tellDifferentlyForSlack }), {
    target: { value: "Exclude Personaa" },
  });
  assert.equal(
    requiredHtmlButtonElement({
      element: view.getByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.submitCorrection }),
      label: SLACK_MEETING_REVIEW_TEST_COPY.expectedSubmitCorrectionButton,
    }).disabled,
    false,
  );
  fireEvent.click(view.getByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.submitCorrection }));
  await waitFor(() => assert.ok(callLog.urls.some((url) => url.endsWith("/revise"))));
  await waitFor(() =>
    assert.equal(
      requiredHtmlInputElement({
        element: view.getByRole("textbox", { name: SLACK_MEETING_REVIEW_TEST_COPY.tellDifferentlyForSlack }),
        label: SLACK_MEETING_REVIEW_TEST_COPY.expectedTellDifferentlyForSlackInput,
      }).value,
      "",
    ),
  );
  assert.equal(
    callLog.urls.some((url) => url.endsWith("/confirm")),
    false,
  );
  assert.equal(Boolean(view.queryByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.notNow })), false);
  assertLabelPresent({ screen: view, label: SLACK_MEETING_REVIEW_TEST_COPY.slackReviewLabel });
});
void test("no matched recipients disables confirmation", async (t) => {
  t.after(cleanup);
  t.mock.method(globalThis, "fetch", async () => Response.json({ review: { ...review, recipients: [] } }));
  const view = render(
    <ToastProvider>
      <SlackMeetingReviewPanel meetingId={review.meetingId} token="fixture" />
    </ToastProvider>,
  );
  await waitFor(() =>
    assertTextPresent({ screen: view, text: SLACK_MEETING_REVIEW_TEST_COPY.noMatchingSlackAccountPattern }),
  );
  assert.equal(
    requiredHtmlButtonElement({
      element: view.getByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.yesSendToSlack }),
      label: SLACK_MEETING_REVIEW_TEST_COPY.expectedYesSendToSlackButton,
    }).disabled,
    true,
  );
});

void test("returning to an already shared meeting never shows the send menu", async (t) => {
  const callLog = { urls: [] as string[] };
  t.after(cleanup);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    callLog.urls = appendCall({ calls: callLog.urls, url });

    return Response.json({ review: { ...review, status: "completed" } });
  });
  const view = render(
    <ToastProvider>
      <SlackMeetingReviewPanel meetingId={review.meetingId} token="fixture" />
    </ToastProvider>,
  );
  await waitFor(() =>
    assertTextPresent({ screen: view, text: SLACK_MEETING_REVIEW_TEST_COPY.meetingSummarySentToSlack }),
  );
  assert.equal(Boolean(view.queryByLabelText(SLACK_MEETING_REVIEW_TEST_COPY.slackReviewLabel)), false);
  assert.equal(Boolean(view.queryByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.yesSendToSlack })), false);
  assert.equal(callLog.urls.length, 1);
  const prepareCall = callLog.urls[0];
  assert.ok(prepareCall !== undefined && prepareCall.endsWith("/prepare"));
});

void test("preparation errors use a toast and refresh only prepares the review", async (t) => {
  t.after(cleanup);
  const callLog = { urls: [] as string[] };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    callLog.urls = appendCall({ calls: callLog.urls, url });

    return callLog.urls.length === 1
      ? Response.json(
          { message: SLACK_MEETING_REVIEW_TEST_COPY.reconnectSlackInSettings },
          { status: HTTP_BAD_REQUEST },
        )
      : Response.json({ review });
  });
  const view = render(
    <ToastProvider>
      <SlackMeetingReviewPanel meetingId={review.meetingId} token="fixture" />
    </ToastProvider>,
  );
  await waitFor(() =>
    assertTextPresent({ screen: view, text: SLACK_MEETING_REVIEW_TEST_COPY.reconnectSlackInSettings }),
  );
  assert.notEqual(
    view.getByText(SLACK_MEETING_REVIEW_TEST_COPY.reconnectSlackInSettings).closest(".workspace-toast"),
    null,
  );
  assert.equal(view.queryByRole("alert"), null);
  fireEvent.click(view.getByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.refreshReview }));
  await waitFor(() => assertLabelPresent({ screen: view, label: SLACK_MEETING_REVIEW_TEST_COPY.slackReviewLabel }));
  assert.equal(view.queryByText(SLACK_MEETING_REVIEW_TEST_COPY.reconnectSlackInSettings), null);
  assert.equal(callLog.urls.length, EXPECTED_PREPARE_AND_RETRY_CALLS);
  assert.ok(callLog.urls.every((url) => url.endsWith("/prepare")));
});

void test("failed deliveries show a toast without a resend action", async (t) => {
  t.after(cleanup);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      review: { ...review, status: "failed", error: SLACK_MEETING_REVIEW_TEST_COPY.checkSlackBeforeSharingAgain },
    }),
  );
  const view = render(
    <ToastProvider>
      <SlackMeetingReviewPanel meetingId={review.meetingId} token="fixture" />
    </ToastProvider>,
  );
  await waitFor(() =>
    assertTextPresent({ screen: view, text: SLACK_MEETING_REVIEW_TEST_COPY.checkSlackBeforeSharingAgain }),
  );
  assert.notEqual(
    view.getByText(SLACK_MEETING_REVIEW_TEST_COPY.checkSlackBeforeSharingAgain).closest(".workspace-toast"),
    null,
  );
  assert.equal(view.queryByLabelText(SLACK_MEETING_REVIEW_TEST_COPY.slackReviewLabel), null);
  assert.equal(view.queryByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.refreshReview }), null);
  assert.equal(view.queryByRole("button", { name: SLACK_MEETING_REVIEW_TEST_COPY.yesSendToSlack }), null);
});
