import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";

import { buildDebugWorkspaceTaskList } from "../../../domain/debug-workspace-video-sequence";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ToastProvider } = await import("../../../presentation/components/toast-provider");
const { WorkspaceTasksSection } = await import("../../../presentation/components/workspace-tasks-section");
afterEach(cleanup);

const slackReviewCopy = "Slack review";
const ashbyReviewCopy = "Ashby review";

const emptyTasks = buildDebugWorkspaceTaskList("tasks-preview", []);
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return function View({ isLoading }: { isLoading: boolean }) {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>
          <WorkspaceTasksSection
            phase={isLoading ? "loading" : "complete"}
            taskList={isLoading ? null : emptyTasks}
            postTaskReview={
              isLoading ? null : (
                <>
                  <div>{slackReviewCopy}</div>
                  <div>{ashbyReviewCopy}</div>
                </>
              )
            }
          />
        </ToastProvider>
      </QueryClientProvider>
    );
  };
}

void test("the Tasks heading stays mounted when preparation finishes without tasks", () => {
  const View = setup();
  const screen = render(<View isLoading />);
  const heading = screen.getByText("Tasks");
  assert.notEqual(screen.getByText("Preparing meeting tasks"), null);
  screen.rerender(<View isLoading={false} />);
  assert.equal(screen.getByText("Tasks"), heading);
  assert.equal(Boolean(screen.queryByText("Preparing meeting tasks")), false);
  assert.notEqual(screen.getByText(slackReviewCopy), null);
  assert.notEqual(screen.getByText(ashbyReviewCopy), null);
  assert.equal(screen.container.querySelector(".workspace-task-flow"), null);
});

void test("empty-state bullet uses the notes bullet style and is hidden only by rendered review content", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../../presentation/styles/globals.css", import.meta.url), "utf8");
  const style = document.createElement("style");
  style.textContent = css.slice(css.indexOf("/* Keep the heading and review subtree stable"));
  document.head.append(style);
  const client = new QueryClient();
  function EmptyReview() {
    return null;
  }
  function View({ hasMenu }: { hasMenu: boolean }) {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>
          <WorkspaceTasksSection
            phase="complete"
            taskList={emptyTasks}
            postTaskReview={hasMenu ? <div>{slackReviewCopy}</div> : <EmptyReview />}
          />
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  try {
    const screen = render(<View hasMenu={false} />);
    const bullet = screen.getByText("No tasks");
    assert.ok(bullet.classList.contains("workspace-flow-snapshot-note-line"));
    assert.ok(bullet.querySelector(".workspace-flow-summary-bullet"));
    assert.notEqual(getComputedStyle(bullet).display, "none");
    screen.rerender(<View hasMenu />);
    assert.equal(getComputedStyle(bullet).display, "none");
    screen.rerender(<View hasMenu={false} />);
    assert.notEqual(getComputedStyle(bullet).display, "none");
  } finally {
    style.remove();
  }
});

void test("review state stays mounted when the last task disappears", () => {
  const client = new QueryClient();
  const mountCount = { current: 0 };
  function Review() {
    React.useEffect(() => {
      mountCount.current += 1;
    }, []);

    return <div>{slackReviewCopy}</div>;
  }
  const populatedTasks = buildDebugWorkspaceTaskList("tasks-preview", [
    { title: "Follow up", description: "", owner: "Personaa Personbf", belongsInLinear: false },
  ]);
  function View({ isEmpty }: { isEmpty: boolean }) {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>
          <WorkspaceTasksSection
            phase="complete"
            taskList={isEmpty ? emptyTasks : populatedTasks}
            postTaskReview={<Review />}
          />
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  const screen = render(<View isEmpty={false} />);
  const heading = screen.getByText("Tasks");
  const menu = screen.getByText(slackReviewCopy);
  screen.rerender(<View isEmpty />);
  assert.equal(screen.getByText("Tasks"), heading);
  assert.equal(screen.getByText(slackReviewCopy), menu);
  assert.equal(mountCount.current, 1);
});
