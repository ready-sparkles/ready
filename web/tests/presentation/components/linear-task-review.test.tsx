import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type LinearTaskReviewRun,
  type MeetingTaskList,
  updateLinearTaskReviewTargetRequestSchema,
  updateMeetingTaskRequestSchema,
} from "@readymeet/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";

import {
  assignedTasksQueryKey,
  personalAssignedTasksQueryKey,
  workspaceAssignedTasksQueryKey,
} from "../../../domain/query-keys";
import { AgentThinkingBlock } from "../../../presentation/components/agent-thinking";
import { LinearTaskReviewPanel } from "../../../presentation/components/linear-task-review";
import { ToastProvider } from "../../../presentation/components/toast-provider";
import { WorkspaceTasksSection } from "../../../presentation/components/workspace-tasks-section";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const HTTP_OK = 200;
const LINEAR_REVIEW_MODEL_CONFIDENCE = 0.9;
const EXPECTED_WORKSPACE_TASK_ROWS = 2;
const DUPLICATE_CANDIDATE_COUNT = 3;
const LINEAR_ENG_IDENTIFIER_BASE = 120;
const EXPECTED_RETARGET_AND_SYNC_REQUESTS = 2;
const LINEAR_TASK_EXIT_ANIMATION_MS = 560;

const LINEAR_TASK_REVIEW_TEST_COPY = {
  missingValue: "Expected a value",
  assistantServiceError: "Assistant service error",
  partialFailureSummary: "1 Linear issue could not be finished",
};

function jsonResponse(input: { payload: unknown; status?: number }) {
  const status = input.status ?? HTTP_OK;

  return new Response(JSON.stringify(input.payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const linearReviewFixtureItem: LinearTaskReviewRun["items"][number] = {
  id: "66666666-6666-4666-8666-666666666666",
  runId: "11111111-1111-4111-8111-111111111111",
  position: 0,
  sourceTaskIds: ["77777777-7777-4777-8777-777777777777"],
  decision: "linear",
  confidence: LINEAR_REVIEW_MODEL_CONFIDENCE,
  reasoning: "Product work",
  title: "Build export flow",
  description: null,
  issueDraft: null,
  teamId: "team-1",
  teamName: "Engineering",
  /** @external linear task review item contract */
  included: true,
  syncStatus: "pending",
  syncError: null,
  duplicateIssues: [],
  targetAction: "create",
  targetIssue: null,
  relationId: null,
  meetingContextSyncedAt: null,
  externalIssue: null,
  createdAt: "2026-08-05T12:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z",
};

function review(status: LinearTaskReviewRun["status"]): LinearTaskReviewRun {
  const item: LinearTaskReviewRun["items"][number] = {
    ...linearReviewFixtureItem,
    syncStatus: status === "completed" ? "created" : "pending",
    externalIssue:
      status === "completed"
        ? {
            id: "issue-1",
            identifier: "ENG-123",
            title: "Build export flow",
            url: "https://linear.app/ready/issue/ENG-123",
          }
        : null,
  };

  return {
    id: "11111111-1111-4111-8111-111111111111",
    meetingId: "22222222-2222-4222-8222-222222222222",
    taskListId: "33333333-3333-4333-8333-333333333333",
    userId: "44444444-4444-4444-8444-444444444444",
    connectorId: "55555555-5555-4555-8555-555555555555",
    status,
    phase: status,
    inputHash: "hash",
    model: "test-model",
    promptVersion: "linear-task-review-v2",
    error: null,
    startedAt: "2026-08-05T12:00:00.000Z",
    completedAt: status === "completed" ? "2026-08-05T12:01:00.000Z" : null,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
    items: [item],
  };
}

function renderLinearReviewPanel(input: { inputReview: LinearTaskReviewRun; token?: string }) {
  const token = input.token ?? "token";

  return render(
    <ToastProvider>
      <LinearTaskReviewPanel review={input.inputReview} token={token} />
    </ToastProvider>,
  );
}

function requiredValue<T>(value: T | null | undefined) {
  if (value === null || value === undefined) {
    throw new Error(LINEAR_TASK_REVIEW_TEST_COPY.missingValue);
  }

  return value;
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }

  return "";
}

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

  throw new Error(LINEAR_TASK_REVIEW_TEST_COPY.missingValue);
}

function withFirstReviewItem(input: {
  run: LinearTaskReviewRun;
  patch: Partial<LinearTaskReviewRun["items"][number]>;
}): LinearTaskReviewRun {
  const firstItem = requiredValue(input.run.items[0]);

  return {
    ...input.run,
    items: [{ ...firstItem, ...input.patch }, ...input.run.items.slice(1)],
  };
}

function withReviewItems(input: {
  run: LinearTaskReviewRun;
  items: LinearTaskReviewRun["items"];
}): LinearTaskReviewRun {
  return { ...input.run, items: input.items };
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

function taskList(items: MeetingTaskList["items"]): MeetingTaskList {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    meetingId: "22222222-2222-4222-8222-222222222222",
    status: "completed",
    phase: "complete",
    error: null,
    model: "test-model",
    promptVersion: "linear-task-review-v2",
    transcriptHash: "hash",
    taskListVersion: 1,
    items,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
    completedAt: "2026-08-05T12:00:00.000Z",
  };
}

const linearSourceTask: MeetingTaskList["items"][number] = {
  id: "77777777-7777-4777-8777-777777777777",
  meetingId: "22222222-2222-4222-8222-222222222222",
  taskListId: "33333333-3333-4333-8333-333333333333",
  position: 0,
  title: "Build export flow",
  description: null,
  type: "task",
  workKind: "implementation",
  owner: { userId: null, name: null, email: null, confidence: null },
  assignee: { userId: null, name: null, email: null, confidence: null },
  dueDate: { value: null, confidence: null },
  confidence: "high",
  assetIds: [],
  sourceQuotes: [],
  sourceReason: "Product work",
  status: "open",
  revision: 1,
  createdFrom: "meeting_transcript",
  origin: "final",
  statusSource: "model",
  statusActorUserId: null,
  statusChangedAt: null,
  actionConfirmableAt: null,
  detectedAt: null,
  firstRenderedAt: null,
  externalLinks: [],
  createdAt: "2026-08-05T12:00:00.000Z",
  updatedAt: "2026-08-05T12:00:00.000Z",
  completedAt: null,
};

const readySourceTask: MeetingTaskList["items"][number] = {
  ...linearSourceTask,
  id: "88888888-8888-4888-8888-888888888888",
  position: 1,
  title: "Prepare beta rollout",
};

void test("reassigning a meeting task invalidates only the current viewer personal feed", async (t) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const participant = {
    userId: "44444444-4444-4444-8444-444444444444",
    displayName: "Attendee",
    email: "attendee@example.test",
    avatarUrl: null,
  };
  const currentUserId = "99999999-9999-4999-8999-999999999999";
  const queryKey = personalAssignedTasksQueryKey(currentUserId);
  const unrelatedKeys = [
    personalAssignedTasksQueryKey(participant.userId),
    assignedTasksQueryKey(currentUserId),
    workspaceAssignedTasksQueryKey("source-workspace", currentUserId),
    workspaceAssignedTasksQueryKey("other-workspace", currentUserId),
    [...queryKey, "other-query"],
  ];
  queryClient.setQueryData(queryKey, []);
  unrelatedKeys.forEach((key) => {
    queryClient.setQueryData(key, []);
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const updates = { isApplied: false };
  const fetchMock: typeof fetch = async (url, init) => {
    assert.match(
      resolveFetchUrl(url),
      new RegExp(`/meetings/${readySourceTask.meetingId}/tasks/${readySourceTask.id}$`),
    );
    assert.notEqual(init, undefined);
    assert.ok(init);
    assert.equal(init.method, "PATCH");
    assert.deepEqual(updateMeetingTaskRequestSchema.parse(JSON.parse(requestBodyText(init.body))), {
      assigneeUserId: participant.userId,
    });

    return jsonResponse({
      payload: {
        task: {
          ...readySourceTask,
          sourceQuotes: [{ quote: "I will prepare the rollout.", speaker: "Attendee", timestamp: null }],
          assignee: {
            userId: participant.userId,
            name: participant.displayName,
            email: participant.email,
            confidence: "high",
          },
        },
      },
    });
  };
  globalThis.fetch = fetchMock;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WorkspaceTasksSection
          taskList={taskList([readySourceTask])}
          phase="complete"
          token="token"
          meetingId={readySourceTask.meetingId}
          participants={[participant]}
          currentUserId={currentUserId}
          onUpdated={() => {
            updates.isApplied = true;
          }}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "Assign task: Unassigned" }));
    fireEvent.click(view.getByRole("option", { name: /Attendee/ }));
    await waitFor(() => {
      assert.equal(updates.isApplied, true);
      assert.equal(queryClient.getQueryState(queryKey)?.isInvalidated, true);
      unrelatedKeys.forEach((key) => {
        assert.equal(
          queryClient.getQueryState(key)?.isInvalidated,
          false,
          `Unrelated query invalidated: ${JSON.stringify(key)}`,
        );
      });
    });
  } finally {
    view.unmount();
    queryClient.clear();
  }
});

void test("task lists appear without reveal effects while the heading stays anchored", () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <WorkspaceTasksSection taskList={taskList([linearSourceTask, readySourceTask])} phase="complete" />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      ),
    },
  );

  const revealedRows = view.container.querySelectorAll<HTMLElement>(".workspace-task-row-reveal");
  assert.equal(revealedRows.length, 0);
  assert.equal(view.container.querySelectorAll(".workspace-task-row").length, EXPECTED_WORKSPACE_TASK_ROWS);
  assert.equal(view.getByText("Tasks").closest(".workspace-task-row-reveal"), null);
  view.unmount();
});

void test("initial Linear detection stays hidden until suggestions are ready", () => {
  (["queued", "reviewing"] as const).forEach((status) => {
    const view = renderLinearReviewPanel({ inputReview: review(status) });
    assert.equal(view.container.textContent, "");
    assert.equal(view.container.querySelector("canvas.workspace-thinking-signal"), null);
    view.unmount();
  });
});

void test("meeting prep can use the breathing orb without changing the Linear default", () => {
  const view = render(
    <AgentThinkingBlock
      title="Sizing up this meeting"
      detail="Checking what Ready can research before the call."
      orbState="breathing"
    />,
  );
  const breathingOrb = view.container.querySelector("canvas.workspace-thinking-signal");
  assert.notEqual(breathingOrb, null);
  assert.ok(breathingOrb);
  assert.equal(breathingOrb.getAttribute("aria-label"), "Thinking…");
  view.unmount();
});

void test("confirmation shows original bordered choices and an inline correction field", () => {
  const view = renderLinearReviewPanel({ inputReview: review("awaiting_user") });
  view.getByPlaceholderText("No, and tell Ready what to do differently");
  view.getByRole("button", { name: /Yes, create 1 issue/ });
  assert.equal(view.queryByRole("button", { name: "Send" }), null);
  assert.equal(view.queryByRole("button", { name: "Skip" }), null);
  assert.equal(
    requiredHtmlButtonElement({
      element: view.getByRole("button", { name: "Submit correction" }),
      label: "Submit correction",
    }).disabled,
    true,
  );
  view.unmount();
});

void test("a revised confirmation clears the previous correction text", async () => {
  const initialReview = review("awaiting_user");
  const view = renderLinearReviewPanel({ inputReview: initialReview });
  const correction = view.getByRole("textbox", { name: "Tell differently for Linear" });
  fireEvent.change(correction, { target: { value: "Merge to one" } });
  assert.equal(
    requiredHtmlInputElement({ element: correction, label: "Tell differently for Linear" }).value,
    "Merge to one",
  );

  view.rerender(
    <ToastProvider>
      <LinearTaskReviewPanel review={{ ...initialReview, status: "revising", phase: "revising" }} token="token" />
    </ToastProvider>,
  );

  const mergedReview = withFirstReviewItem({
    run: review("awaiting_user"),
    patch: {
      id: "88888888-8888-4888-8888-888888888888",
      title: "Merged export flow",
    },
  });
  view.rerender(
    <ToastProvider>
      <LinearTaskReviewPanel review={mergedReview} token="token" />
    </ToastProvider>,
  );

  await waitFor(() => {
    assert.equal(
      requiredHtmlInputElement({
        element: view.getByRole("textbox", { name: "Tell differently for Linear" }),
        label: "Tell differently for Linear",
      }).value,
      "",
    );
  });
  view.unmount();
});

void test("legacy duplicate selections are presented as using the existing issue", () => {
  const duplicateIssue = {
    id: "issue-duplicate",
    identifier: "ENG-122",
    title: "Existing export flow",
    url: "https://linear.app/ready/issue/ENG-122",
    status: "Open",
    rationale: "Same export behavior.",
  };
  const duplicateReview = withFirstReviewItem({
    run: review("awaiting_user"),
    patch: {
      targetAction: "create_duplicate",
      targetIssue: duplicateIssue,
      duplicateIssues: [duplicateIssue],
    },
  });

  const view = renderLinearReviewPanel({ inputReview: duplicateReview });
  view.getByRole("heading", { name: "Already tracked in Linear" });
  view.getByRole("button", { name: "Update ENG-122" });
  view.getByRole("button", { name: "Create 1 new issue" });
  assert.equal(view.queryByRole("button", { name: /^Yes,/ }), null);
  assert.equal(view.queryByRole("button", { name: /^Create a duplicate issue/ }), null);
  view.unmount();
});

void test("a matched issue is synced with one click", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const matchedIssue = {
    id: "issue-existing",
    identifier: "ENG-122",
    title: "Existing export flow",
    url: "https://linear.app/ready/issue/ENG-122",
    status: "Open",
    rationale: "Same export behavior.",
  };
  const matchedReview = withFirstReviewItem({
    run: review("awaiting_user"),
    patch: {
      targetAction: "link_existing",
      targetIssue: matchedIssue,
      duplicateIssues: [matchedIssue],
    },
  });
  const matchedRequests = { entries: [] as { url: string; body: string | null }[] };
  const fetchMock: typeof fetch = async (input, init) => {
    matchedRequests.entries = [
      ...matchedRequests.entries,
      {
        url: resolveFetchUrl(input),
        body: typeof init?.body === "string" ? init.body : null,
      },
    ];

    return jsonResponse({ payload: { review: matchedReview } });
  };
  globalThis.fetch = fetchMock;

  const view = renderLinearReviewPanel({ inputReview: matchedReview });
  const useExisting = view.getByRole("button", { name: "Update ENG-122" });
  useExisting.focus();
  fireEvent.click(useExisting);

  await waitFor(() => assert.equal(matchedRequests.entries.length, 1));
  assert.match(requiredValue(matchedRequests.entries[0]).url, /\/sync$/);
  view.unmount();
});

void test("partial Linear sync failures use the item error in a toast instead of inline red copy", async () => {
  const matchedIssue = {
    id: "issue-existing",
    identifier: "ENG-122",
    title: "Existing export flow",
    url: "https://linear.app/ready/issue/ENG-122",
    status: "Open",
    rationale: "Same export behavior.",
  };
  const failedReview = withFirstReviewItem({
    run: {
      ...review("awaiting_user"),
      phase: "partial_failure",
      error: LINEAR_TASK_REVIEW_TEST_COPY.partialFailureSummary,
    },
    patch: {
      syncStatus: "failed",
      syncError: "Linear rejected the issue update.",
      targetAction: "link_existing",
      targetIssue: matchedIssue,
      duplicateIssues: [matchedIssue],
    },
  });

  const view = renderLinearReviewPanel({ inputReview: failedReview });
  const toast = await view.findByRole("status");

  assert.match(toast.textContent, /Couldn’t update ENG-122/);
  assert.match(toast.textContent, /Linear rejected the issue update/);
  assert.equal(view.queryByText(LINEAR_TASK_REVIEW_TEST_COPY.partialFailureSummary), null);
  assert.equal(view.container.querySelector(".workspace-linear-review-inline-error"), null);
  view.unmount();
});

void test("only the actionable existing target is shown in the two-outcome review", () => {
  const duplicateIssues = Array.from({ length: DUPLICATE_CANDIDATE_COUNT }, (_, index) => ({
    id: `issue-duplicate-${index + 1}`,
    identifier: `ENG-${LINEAR_ENG_IDENTIFIER_BASE + index}`,
    title: `Existing export flow ${index + 1}`,
    url: `https://linear.app/ready/issue/ENG-${LINEAR_ENG_IDENTIFIER_BASE + index}`,
    status: "Open",
    rationale: `Duplicate match ${index + 1}.`,
  }));
  const duplicateReview = withFirstReviewItem({
    run: review("awaiting_user"),
    patch: {
      duplicateIssues,
      targetAction: "link_existing",
      targetIssue: requiredValue(duplicateIssues[0]),
    },
  });

  const view = renderLinearReviewPanel({ inputReview: duplicateReview });
  view.getByRole("link", { name: /ENG-120/ });
  assert.equal(view.queryByRole("link", { name: /ENG-121/ }), null);
  assert.equal(view.queryByRole("link", { name: /ENG-122/ }), null);
  assert.equal(view.queryByText("Possible match in Linear"), null);
  assert.equal(view.queryByText(/Shares .* context with this task/), null);
  assert.equal(view.queryAllByRole("button", { name: /^Create a duplicate issue/ }).length, 0);
  view.getByRole("button", { name: "Update ENG-120" });
  view.getByRole("button", { name: "Create 1 new issue" });
  assert.equal(view.queryByRole("button", { name: /^Yes,/ }), null);
  view.unmount();
});

void test("low-confidence search candidates do not replace the simple Y confirmation", () => {
  const suggestedReview = withFirstReviewItem({
    run: review("awaiting_user"),
    patch: {
      duplicateIssues: [
        {
          id: "issue-low-confidence",
          identifier: "ENG-120",
          title: "Loosely related export work",
          url: "https://linear.app/ready/issue/ENG-120",
          status: "Open",
          rationale: "Weak match.",
        },
      ],
    },
  });

  const view = renderLinearReviewPanel({ inputReview: suggestedReview });
  view.getByRole("button", { name: /^Yes, create 1 issue/ });
  assert.equal(view.queryByRole("button", { name: "Create 1 new issue" }), null);
  assert.equal(view.queryByRole("link", { name: /ENG-120/ }), null);
  view.unmount();
});

void test("mixed confirmation treats legacy duplicate selections as existing issues", () => {
  const duplicateIssue = {
    id: "issue-duplicate",
    identifier: "ENG-122",
    title: "Existing export flow",
    url: "https://linear.app/ready/issue/ENG-122",
    status: "Open",
    rationale: "Same export behavior.",
  };
  const mixedReview = withReviewItems({
    run: review("awaiting_user"),
    items: [
      requiredValue(review("awaiting_user").items[0]),
      {
        ...requiredValue(review("awaiting_user").items[0]),
        id: "88888888-8888-4888-8888-888888888888",
        position: 1,
        sourceTaskIds: ["99999999-9999-4999-8999-999999999999"],
        title: "Add export progress",
        targetAction: "create_duplicate",
        targetIssue: duplicateIssue,
        duplicateIssues: [duplicateIssue],
      },
    ],
  });

  const view = renderLinearReviewPanel({ inputReview: mixedReview });
  view.getByRole("button", { name: "Create 1 new issue and update ENG-122" });
  view.getByRole("button", { name: "Create 2 new issues" });
  assert.equal(view.queryByRole("button", { name: /^Yes,/ }), null);
  view.unmount();
});

void test("the all-new outcome retargets matched work before syncing once", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const existingIssue = {
    id: "issue-existing",
    identifier: "ENG-122",
    title: "Existing export flow",
    url: "https://linear.app/ready/issue/ENG-122",
    status: "Open",
    rationale: "Same export behavior.",
  };
  const firstItem = withFirstReviewItem({
    run: review("awaiting_user"),
    patch: {
      targetAction: "link_existing",
      targetIssue: existingIssue,
      duplicateIssues: [existingIssue],
    },
  });
  const mixedReview = withReviewItems({
    run: firstItem,
    items: [
      requiredValue(firstItem.items[0]),
      {
        ...requiredValue(firstItem.items[0]),
        id: "88888888-8888-4888-8888-888888888888",
        position: 1,
        sourceTaskIds: ["99999999-9999-4999-8999-999999999999"],
        title: "Add export progress",
        targetAction: "create",
        targetIssue: null,
        duplicateIssues: [],
      },
    ],
  });
  const retargetRequests = { entries: [] as { url: string; body: string | null }[] };
  const fetchMock: typeof fetch = async (input, init) => {
    retargetRequests.entries = [
      ...retargetRequests.entries,
      {
        url: resolveFetchUrl(input),
        body: typeof init?.body === "string" ? init.body : null,
      },
    ];

    return jsonResponse({ payload: { review: mixedReview } });
  };
  globalThis.fetch = fetchMock;

  const view = renderLinearReviewPanel({ inputReview: mixedReview });
  fireEvent.click(view.getByRole("button", { name: "Create 2 new issues" }));

  await waitFor(() => assert.equal(retargetRequests.entries.length, EXPECTED_RETARGET_AND_SYNC_REQUESTS));
  assert.match(
    requiredValue(retargetRequests.entries[0]).url,
    /\/items\/66666666-6666-4666-8666-666666666666\/target$/,
  );
  assert.deepEqual(
    updateLinearTaskReviewTargetRequestSchema.parse(
      JSON.parse(requiredValue(retargetRequests.entries[0]).body ?? "{}"),
    ),
    { action: "create", issueId: null },
  );
  assert.match(requiredValue(retargetRequests.entries[1]).url, /\/sync$/);
  view.unmount();
});

void test("the Y shortcut does not fire while another control is focused", () => {
  const view = renderLinearReviewPanel({ inputReview: review("awaiting_user") });
  const confirmButton = view.getByRole("button", { name: /Yes, create 1 issue/ });
  confirmButton.focus();

  assert.equal(fireEvent.keyDown(confirmButton, { key: "y" }), true);
  assert.equal(confirmButton.getAttribute("disabled"), null);
  view.unmount();
});

void test("failed reviews expose a retry control", () => {
  const failed = { ...review("failed"), error: LINEAR_TASK_REVIEW_TEST_COPY.assistantServiceError };
  const view = renderLinearReviewPanel({ inputReview: failed });
  view.getByRole("button", { name: "Try again" });
  view.unmount();
});

void test("completed reviews explain that the work is tracked only in Linear", () => {
  const view = renderLinearReviewPanel({ inputReview: review("completed") });
  assert.match(view.container.textContent, /This work is now tracked in Linear and no longer appears in Ready\./);
  view.getByRole("link", { name: /ENG-123/ });
  view.unmount();
});

void test("completed linked reviews fall back to the selected existing issue", () => {
  const linkedReview = withFirstReviewItem({
    run: review("completed"),
    patch: {
      targetAction: "link_existing",
      targetIssue: {
        id: "issue-existing",
        identifier: "ENG-120",
        title: "Existing export flow",
        url: "https://linear.app/ready/issue/ENG-120",
      },
      externalIssue: null,
    },
  });

  const view = renderLinearReviewPanel({ inputReview: linkedReview });
  view.getByRole("link", { name: /ENG-120 · Existing export flow/ });
  view.unmount();
});

void test("completed duplicate-only reviews use duplicate-specific copy", () => {
  const duplicateReview = withFirstReviewItem({
    run: review("completed"),
    patch: {
      targetAction: "create_duplicate",
    },
  });

  const view = renderLinearReviewPanel({ inputReview: duplicateReview });
  view.getByRole("heading", { name: "Created 1 duplicate issue in Linear" });
  assert.doesNotMatch(view.container.textContent, /Created 1 issue in Linear/);
  view.unmount();
});

void test("a confirmed Linear task survives an early refresh long enough to fade out", async () => {
  const refreshes = { count: 0 };
  const awaiting = review("awaiting_user");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <WorkspaceTasksSection
      taskList={taskList([linearSourceTask])}
      phase="complete"
      token="token"
      meetingId={awaiting.meetingId}
      linearTaskReview={awaiting}
      onUpdated={() => {
        refreshes.count += 1;
      }}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      ),
    },
  );

  view.rerender(
    <WorkspaceTasksSection
      taskList={taskList([])}
      phase="complete"
      token="token"
      meetingId={awaiting.meetingId}
      linearTaskReview={review("completed")}
      onUpdated={() => {
        refreshes.count += 1;
      }}
    />,
  );

  const exitingRow = view.getByText("Build export flow").closest(".debug-workspace-collapse-wrap");
  assert.ok(exitingRow?.classList.contains("is-linear-exiting") === true);

  await act(async () => {
    await new Promise((resolve) => {
      window.setTimeout(resolve, LINEAR_TASK_EXIT_ANIMATION_MS);
    });
  });

  assert.equal(view.queryByText("Build export flow"), null);
  assert.equal(refreshes.count, 1);
  assert.match(view.container.textContent, /This work is now tracked in Linear and no longer appears in Ready\./);
  view.getByRole("link", { name: /ENG-123/ });
  view.unmount();
});
