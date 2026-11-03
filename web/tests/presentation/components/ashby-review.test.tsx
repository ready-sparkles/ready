import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type AshbyReview, ashbyReviewActionSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";

import { setApiTransport } from "../../../composition/api";
import { AshbyReviewPanel } from "../../../presentation/components/ashby-review";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const REVISION_SEED = 3;
const REVISION_BUMPED = 4;

const ASHBY_REVIEW_TEST_COPY = {
  expectedRequestBodyText: "Expected request body text",
  movePriyaStageSummary: "Move Personqj Personqm from Recruiter Screen to Portfolio Review for Designer.",
  yesUpdateStage: "Yes, update stage",
};

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  setApiTransport(null);
});

function requestBodyText(body: BodyInit | null | undefined): string {
  if (body === null || body === undefined) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }

  throw new Error(ASHBY_REVIEW_TEST_COPY.expectedRequestBodyText);
}

function parseAshbyReviewActionFromTransport(input: { options: RequestInit }) {
  return ashbyReviewActionSchema.parse(JSON.parse(requestBodyText(input.options.body)));
}

function appendAshbyReviewAction(input: {
  calls: ReturnType<typeof ashbyReviewActionSchema.parse>[];
  transport: { options: RequestInit };
}) {
  return [...input.calls, parseAshbyReviewActionFromTransport(input.transport)];
}

function requiredHtmlButtonElement(input: { element: Element; label: string }): HTMLButtonElement {
  if (!(input.element instanceof HTMLButtonElement)) {
    throw new Error(input.label);
  }

  return input.element;
}

function assertTextPresent(input: { screen: Pick<ReturnType<typeof render>, "queryByText">; text: string }) {
  assert.notEqual(input.screen.queryByText(input.text), null);
}

function assertLabelPresent(input: { screen: Pick<ReturnType<typeof render>, "queryByLabelText">; label: string }) {
  assert.notEqual(input.screen.queryByLabelText(input.label), null);
}

function review(): AshbyReview {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    meetingId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "44444444-4444-4444-8444-444444444444",
    inputHash: "hash",
    connectionVersion: "v",
    revision: REVISION_SEED,
    status: "awaiting_user",
    error: null,
    clarification: null,
    updatedAt: new Date().toISOString(),
    items: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        proposal: {
          kind: "stage",
          candidateName: "Personqj Personqm",
          candidateEmail: null,
          jobTitle: null,

          stageName: "Portfolio Review",
          evidence: [
            {
              segmentId: "66666666-6666-4666-8666-666666666666",
              quote: "Personqj is available in June.",
            },
          ],
        },
        candidates: [{ id: "personqj", name: "Personqj Personqm", email: null }],
        candidateId: "personqj",
        candidateName: "Personqj Personqm",
        applications: [{ id: "app", name: "Designer" }],
        applicationId: "app",
        stages: [{ id: "portfolio", name: "Portfolio Review" }],
        stageId: "portfolio",
        currentStageId: "screen",
        currentStageName: "Recruiter Screen",
        /** @external ashby review item contract */
        included: true,
        status: "pending",
        error: null,
      },
    ],
  };
}
void test("standalone Ashby review does not require meeting tasks and confirms exact revision", async () => {
  const current = review();
  const captured: { body: ReturnType<typeof ashbyReviewActionSchema.parse> | null } = { body: null };
  setApiTransport(async (transportInput) => {
    captured.body = parseAshbyReviewActionFromTransport(transportInput);

    return { review: { ...current, revision: REVISION_BUMPED, status: "syncing" } };
  });
  const changedState: { review: AshbyReview | null } = { review: null };
  const view = render(
    <AshbyReviewPanel
      review={current}
      token="test"
      onChanged={(value) => {
        changedState.review = value;
      }}
    />,
  );
  assertTextPresent({
    screen: view,
    text: ASHBY_REVIEW_TEST_COPY.movePriyaStageSummary,
  });
  fireEvent.click(view.getByText("Yes, update stage"));
  await waitFor(() => assert.notEqual(captured.body, null));
  const item = current.items[0];
  assert.ok(item);
  assert.deepEqual(captured.body, { action: "confirm", revision: REVISION_SEED, itemIds: [item.id] });
  await waitFor(() => assert.equal(changedState.review?.status, "syncing"));
});
void test("Tell differently submits a revision, never a write, and ignores global confirmation keys", async () => {
  const current = review();
  const callLog: { calls: ReturnType<typeof ashbyReviewActionSchema.parse>[] } = { calls: [] };
  setApiTransport(async (transportInput) => {
    callLog.calls = appendAshbyReviewAction({ calls: callLog.calls, transport: transportInput });

    return { review: { ...current, revision: REVISION_BUMPED, status: "revising" } };
  });
  const view = render(<AshbyReviewPanel review={current} token="test" onChanged={() => {}} />);
  fireEvent.keyDown(document.body, { key: "y" });
  fireEvent.keyDown(document.body, { key: "1" });
  assert.equal(callLog.calls.length, 0);
  fireEvent.change(view.getByLabelText("Tell differently for Ashby"), {
    target: { value: "This is for Personqp Personqq." },
  });
  fireEvent.click(view.getByRole("button", { name: "Submit correction" }));
  await waitFor(() => assert.equal(callLog.calls.length, 1));
  assert.deepEqual(callLog.calls[0], {
    action: "revise",
    revision: REVISION_SEED,
    instruction: "This is for Personqp Personqq.",
  });
});
void test("unresolved and clarification drafts cannot be confirmed", () => {
  const current = review();
  const unresolvedItem = current.items[0];
  assert.ok(unresolvedItem);
  unresolvedItem.candidateId = null;
  const view = render(<AshbyReviewPanel review={current} token="test" onChanged={() => {}} />);
  assert.equal(
    requiredHtmlButtonElement({
      element: view.getByRole("button", { name: ASHBY_REVIEW_TEST_COPY.yesUpdateStage }),
      label: ASHBY_REVIEW_TEST_COPY.yesUpdateStage,
    }).disabled,
    true,
  );
  view.rerender(
    <AshbyReviewPanel review={{ ...review(), clarification: "Which candidate?" }} token="test" onChanged={() => {}} />,
  );
  assert.equal(
    requiredHtmlButtonElement({
      element: view.getByRole("button", { name: ASHBY_REVIEW_TEST_COPY.yesUpdateStage }),
      label: ASHBY_REVIEW_TEST_COPY.yesUpdateStage,
    }).disabled,
    true,
  );
});
void test("negative and dismissed reviews remain hidden", () => {
  (["no_matches", "dismissed"] as const).forEach((status) => {
    const view = render(<AshbyReviewPanel review={{ ...review(), status }} token="test" onChanged={() => {}} />);
    assert.equal(view.queryByLabelText("Ashby review"), null);
    view.unmount();
  });
});

void test("Ashby uses Linear’s task-list position, including with no generated tasks", async () => {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { WorkspaceTasksSection } = await import("../../../presentation/components/workspace-tasks-section");
  const { ToastProvider } = await import("../../../presentation/components/toast-provider");
  const { buildDebugWorkspaceTaskList } = await import("../../../domain/debug-workspace-video-sequence");
  const client = new QueryClient();
  [
    [],
    [
      {
        title: "Prepare interview",
        description: "",
        owner: "Personqo Personqv",
        /** @external debug workspace task seed contract */
        belongsInLinear: false,
      },
    ],
  ].forEach((seeds) => {
    const view = render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <WorkspaceTasksSection
            taskList={buildDebugWorkspaceTaskList("ashby-preview", seeds)}
            phase="complete"
            postTaskReview={<AshbyReviewPanel review={review()} token="test" onChanged={() => {}} />}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const panel = view.getByLabelText("Ashby review");
    assert.equal(panel.parentElement?.className, "workspace-linear-review");
    assert.ok(panel.closest(".workspace-task-list"));
    view.unmount();
  });
  client.clear();
});

void test("initial Ashby detection stays hidden until suggestions are ready", () => {
  (["queued", "reviewing"] as const).forEach((status) => {
    const view = render(<AshbyReviewPanel review={{ ...review(), status }} token="test" onChanged={() => {}} />);
    assert.equal(view.container.textContent, "");
    assert.equal(view.container.querySelector("canvas.workspace-thinking-signal"), null);
    view.unmount();
  });
});

void test("Y is hidden and inactive while both integration menus are visible, and returns when Ashby closes", async () => {
  const { IntegrationActionMenu } = await import("../../../presentation/components/integration-action-menu");
  const approvals = { count: 0 };
  const linear = (
    <IntegrationActionMenu
      provider="Linear"
      icon={null}
      title="Linear"
      description=""
      choices={[{ label: "Yes", onSend: () => (approvals.count += 1) }]}
      correction=""
      onCorrection={() => {}}
      onRevise={() => {}}
    />
  );
  const ashby = <AshbyReviewPanel review={review()} token="test" onChanged={() => {}} />;
  const view = render(
    <>
      {linear}
      {ashby}
    </>,
  );
  assert.equal(view.queryByText("Y"), null);
  fireEvent.keyDown(window, { key: "y" });
  assert.equal(approvals.count, 0);
  view.rerender(<>{linear}</>);
  await waitFor(() => assert.notEqual(view.queryByText("Y"), null));
  fireEvent.keyDown(window, { key: "y" });
  assert.equal(approvals.count, 1);
});

void test("clarification without proposals stays visible and accepts a correction", async () => {
  const current = { ...review(), items: [], clarification: "Which applicant should move?" };
  const submittedState: { action: ReturnType<typeof ashbyReviewActionSchema.parse> | undefined } = {
    action: undefined,
  };
  setApiTransport(async (transportInput) => {
    submittedState.action = parseAshbyReviewActionFromTransport(transportInput);

    return { review: { ...current, status: "revising", revision: REVISION_BUMPED } };
  });
  const view = render(<AshbyReviewPanel review={current} token="test" onChanged={() => {}} />);
  assertTextPresent({ screen: view, text: current.clarification });
  assert.equal(
    requiredHtmlButtonElement({
      element: view.getByRole("button", { name: ASHBY_REVIEW_TEST_COPY.yesUpdateStage }),
      label: ASHBY_REVIEW_TEST_COPY.yesUpdateStage,
    }).disabled,
    true,
  );
  fireEvent.change(view.getByLabelText("Tell differently for Ashby"), {
    target: { value: "Personqj Personqm" },
  });
  fireEvent.click(view.getByLabelText("Submit correction"));
  await waitFor(() =>
    assert.deepEqual(submittedState.action, {
      action: "revise",
      revision: REVISION_SEED,
      instruction: "Personqj Personqm",
    }),
  );
});

void test("unresolved target selectors submit exact item and revision without confirming", async () => {
  const current = review();
  const targetItem = current.items[0];
  assert.ok(targetItem);
  targetItem.stageId = null;
  const submittedState: { action: ReturnType<typeof ashbyReviewActionSchema.parse> | undefined } = {
    action: undefined,
  };
  setApiTransport(async (transportInput) => {
    submittedState.action = parseAshbyReviewActionFromTransport(transportInput);

    return { review: { ...current, revision: REVISION_BUMPED } };
  });
  const view = render(<AshbyReviewPanel review={current} token="test" onChanged={() => {}} />);
  assertLabelPresent({ screen: view, label: "Candidate for Personqj Personqm" });
  assertLabelPresent({ screen: view, label: "Application for Personqj Personqm" });
  fireEvent.change(view.getByLabelText("Stage for Personqj Personqm"), { target: { value: "portfolio" } });
  await waitFor(() =>
    assert.deepEqual(submittedState.action, {
      action: "target",
      revision: REVISION_SEED,
      itemId: targetItem.id,
      candidateId: "personqj",
      applicationId: "app",
      stageId: "portfolio",
    }),
  );
});
