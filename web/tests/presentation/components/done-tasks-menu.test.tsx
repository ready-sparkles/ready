import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import { registerHooks, type ResolveHookSync } from "node:module";
import test from "node:test";
import React from "react";

import { ThemeProvider } from "../../../presentation/components/theme-provider";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The menu behavior is real; only the WebGL decoration is replaced in this DOM test.
const resolveMetalFx: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier !== "metal-fx") {
    return nextResolve(specifier, context);
  }

  return {
    shortCircuit: true,
    url: `data:text/javascript,${encodeURIComponent(
      "export const PRESETS = { silver: { modes: { dark: {}, light: {} } } }; export const setSharedPreset = () => {}; export const MetalFx = props => props.children;",
    )}`,
  };
};
const shaderMock = registerHooks({ resolve: resolveMetalFx });
const { DoneTasksMenu } = await import("../../../presentation/components/done-tasks-menu");
shaderMock.deregister();

const DAYS_OLDER_THAN_WEEK_THRESHOLD = 10;
const MILLISECONDS_PER_DAY = 86400000;
const CLEAR_ONLY_MENU_ITEM_COUNT = 5;

void test("Done menu disables empty ranges, supports keyboard navigation, and clears the chosen range", () => {
  const completedAt = new Date(Date.now() - DAYS_OLDER_THAN_WEEK_THRESHOLD * MILLISECONDS_PER_DAY).toISOString();
  const selected: { values: string[] } = { values: [] };
  const view = render(
    <DoneTasksMenu
      tasks={[{ status: "completed", completedAt, updatedAt: completedAt }]}
      isBusy={false}
      onClear={(range) => {
        selected.values = [...selected.values, range];
      }}
    />,
    { wrapper: ThemeProvider },
  );
  try {
    const trigger = view.getByRole("button", { name: "Clear completed tasks" });
    fireEvent.click(trigger);
    const all = view.getByRole("menuitem", { name: "Clear all done" });
    const week = view.getByRole("menuitem", { name: "Clear older than 1 week" });
    assert.equal(document.activeElement, all);
    ["Clear older than 1 month", "Clear older than 6 months", "Clear older than 1 year"].forEach((name) => {
      const menuItem = view.getByRole("menuitem", { name });
      assert.ok(menuItem instanceof HTMLButtonElement);
      assert.equal(menuItem.disabled, true);
    });
    fireEvent.keyDown(all, { key: "ArrowDown" });
    assert.equal(document.activeElement, week);
    fireEvent.click(week);
    assert.deepEqual(selected.values, ["week"]);
    assert.equal(view.queryByRole("menu"), null);
    assert.equal(document.activeElement, trigger);
    fireEvent.click(trigger);
    fireEvent.keyDown(view.getByRole("menu"), { key: "Escape" });
    assert.equal(view.queryByRole("menu"), null);
  } finally {
    view.unmount();
  }
});

void test("open tasks never enable clearing, and pending requests disable the trigger", () => {
  const old = "2020-01-01T00:00:00.000Z";
  const view = render(
    <DoneTasksMenu
      tasks={[{ status: "open", completedAt: null, updatedAt: old }]}
      isBusy={false}
      onClear={() => assert.fail()}
    />,
    { wrapper: ThemeProvider },
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "Clear completed tasks" }));
    assert.ok(view.getAllByRole("menuitem").every((item) => item instanceof HTMLButtonElement && item.disabled));
    view.rerender(<DoneTasksMenu tasks={[]} isBusy onClear={() => assert.fail()} />);
    const busyTrigger = view.getByRole("button", { name: "Clear completed tasks" });
    assert.ok(busyTrigger instanceof HTMLButtonElement);
    assert.equal(busyTrigger.disabled, true);
  } finally {
    view.unmount();
  }
});

void test("selection actions share the Done menu above a separator and retain clearing actions", () => {
  const date = "2020-01-01T00:00:00.000Z";
  const tasks = [{ status: "completed" as const, completedAt: date, updatedAt: date }];
  const selectionCounts = { removed: 0, reopened: 0 };
  const view = render(
    <DoneTasksMenu
      tasks={tasks}
      isBusy={false}
      onClear={() => assert.fail()}
      selection={{
        canReopen: true,
        canClear: true,
        onReopen: () => {
          selectionCounts.reopened += 1;
        },
        onClear: () => {
          selectionCounts.removed += 1;
        },
      }}
    />,
    { wrapper: ThemeProvider },
  );
  try {
    assert.equal(view.getAllByRole("button").length, 1, "only one dots trigger");
    fireEvent.click(view.getByRole("button", { name: "Clear completed tasks" }));
    assert.deepEqual(
      view.getAllByRole("menuitem").map((item) => item.textContent),
      [
        "Mark as uncompleted",
        "Clear selected",
        "Clear all done",
        "Clear older than 1 week",
        "Clear older than 1 month",
        "Clear older than 6 months",
        "Clear older than 1 year",
      ],
    );
    const separator = view.getByRole("separator");
    assert.equal(separator.previousElementSibling?.textContent, "Clear selected");
    assert.equal(separator.nextElementSibling?.textContent, "Clear all done");
    const reopen = view.getByRole("menuitem", { name: "Mark as uncompleted" });
    const remove = view.getByRole("menuitem", { name: /^Clear selected$/ });
    assert.ok(reopen instanceof HTMLButtonElement);
    assert.equal(reopen.disabled, false);
    assert.ok(remove instanceof HTMLButtonElement);
    assert.equal(remove.disabled, false);
    assert.equal(document.activeElement, reopen);
    fireEvent.keyDown(reopen, { key: "ArrowDown" });
    assert.equal(document.activeElement, remove);
    fireEvent.keyDown(remove, { key: "ArrowDown" });
    assert.equal(document.activeElement, view.getByRole("menuitem", { name: "Clear all done" }));
    fireEvent.click(remove);
    assert.equal(selectionCounts.removed, 1);
    fireEvent.click(view.getByRole("button", { name: "Clear completed tasks" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Mark as uncompleted" }));
    assert.equal(selectionCounts.reopened, 1);
    view.rerender(<DoneTasksMenu tasks={tasks} isBusy={false} onClear={() => {}} />);
    fireEvent.click(view.getByRole("button", { name: "Clear completed tasks" }));
    assert.equal(view.queryByRole("separator"), null);
    assert.equal(view.getAllByRole("menuitem").length, CLEAR_ONLY_MENU_ITEM_COUNT);
  } finally {
    view.unmount();
  }
});

void test("ineligible selections disable actions and keyboard navigation skips them", () => {
  const date = "2020-01-01T00:00:00.000Z";
  const tasks = [{ status: "completed" as const, completedAt: date, updatedAt: date }];
  const clearedCount = { current: 0 };
  const selection = {
    canReopen: false,
    canClear: false,
    onReopen: () => assert.fail("Ineligible reopen"),
    onClear: () => {
      clearedCount.current += 1;
    },
  };
  const view = render(<DoneTasksMenu tasks={tasks} isBusy={false} onClear={() => {}} selection={selection} />, {
    wrapper: ThemeProvider,
  });
  try {
    const open = () => fireEvent.click(view.getByRole("button", { name: "Clear completed tasks" }));
    open();
    const reopenEl = view.getByRole("menuitem", { name: "Mark as uncompleted" });
    const clearEl = view.getByRole("menuitem", { name: /^Clear selected$/ });
    assert.ok(reopenEl instanceof HTMLButtonElement);
    assert.ok(clearEl instanceof HTMLButtonElement);
    const reopen = reopenEl;
    const clear = clearEl;
    assert.equal(reopen.disabled, true);
    assert.equal(clear.disabled, true);
    assert.equal(document.activeElement, view.getByRole("menuitem", { name: "Clear all done" }));
    fireEvent.click(reopen);
    fireEvent.click(clear);
    assert.equal(clearedCount.current, 0);
    fireEvent.keyDown(view.getByRole("menu"), { key: "Escape" });
    // A completed read-only task may be cleared privately but cannot be reopened.
    view.rerender(
      <DoneTasksMenu tasks={tasks} isBusy={false} onClear={() => {}} selection={{ ...selection, canClear: true }} />,
    );
    open();
    const reopenAfterRerender = view.getByRole("menuitem", { name: "Mark as uncompleted" });
    assert.ok(reopenAfterRerender instanceof HTMLButtonElement);
    assert.equal(reopenAfterRerender.disabled, true);
    const enabledClear = view.getByRole("menuitem", { name: /^Clear selected$/ });
    assert.equal(document.activeElement, enabledClear);
    fireEvent.click(enabledClear);
    assert.equal(clearedCount.current, 1);
  } finally {
    view.unmount();
  }
});
