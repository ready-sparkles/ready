import "../../../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import assert from "node:assert/strict";
import { registerHooks, type ResolveHookSync } from "node:module";
import { after, test } from "node:test";

const EXPECTED_BOARD_BUTTON_MESSAGE = "Expected a Board button";
const WAIT_FOR_HEADING_TIMEOUT_MS = 6000;

const resolveCss: ResolveHookSync = (specifier, context, nextResolve) => {
  if (specifier.endsWith(".css")) {
    return { shortCircuit: true, url: "data:text/javascript,export default {}" };
  }

  return nextResolve(specifier, context);
};
const css = registerHooks({ resolve: resolveCss });
const { DemoSpaces } = await import("../../../../presentation/components/demo-spaces/demo-spaces");
css.deregister();
after(() => GlobalRegistrator.unregister());

void test("board demo supports rooms, minutes, tasks, settings, and mock generation without network or storage", async (t) => {
  const requests = { count: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    requests.count += 1;
    throw Error("Account requests must never run");
  });
  const beforeLocal = JSON.stringify(Object.entries(window.localStorage));
  const beforeSession = JSON.stringify(Object.entries(window.sessionStorage));
  const view = render(<DemoSpaces />);
  t.after(cleanup);
  assert.notEqual(view.getByRole("heading", { name: "Meridian", level: 1 }), null);
  fireEvent.click(view.getByRole("button", { name: /Ocean & Co\. United States/ }));
  assert.notEqual(view.getByRole("heading", { name: "Ocean & Co.", level: 1 }), null);
  fireEvent.click(view.getByRole("button", { name: /September board meeting/ }));
  assert.notEqual(view.getByRole("heading", { name: "4. Resolutions" }), null);
  fireEvent.click(view.getByRole("button", { name: "Approve draft" }));
  const approvedButton = view.getByRole("button", { name: "Approved" });
  assert.equal(approvedButton.hasAttribute("disabled"), true);
  fireEvent.click(view.getByRole("button", { name: /^Settings$/ }));
  fireEvent.click(view.getByRole("button", { name: /^Sales$/ }));
  fireEvent.click(view.getByRole("button", { name: "Request access" }));
  assert.notEqual(view.getByRole("heading", { name: "You're on the waitlist" }), null);
  const boardButtons = view.getAllByRole("button", { name: /^Board$/ });
  const lastBoardButton = boardButtons.at(-1);
  if (!lastBoardButton) {
    throw new Error(EXPECTED_BOARD_BUTTON_MESSAGE);
  }
  fireEvent.click(lastBoardButton);
  fireEvent.click(view.getByRole("button", { name: /Meridian Finland/ }));
  const company = view.getByLabelText("Company name");
  fireEvent.change(company, { target: { value: "Meridian Demo" } });
  fireEvent.click(view.getByRole("button", { name: "Save and open board room" }));
  assert.notEqual(view.getByRole("heading", { name: "Meridian Demo" }), null);
  fireEvent.click(view.getByRole("button", { name: "Change next board meeting" }));
  fireEvent.click(view.getByRole("button", { name: /Strategy and budget review/ }));
  fireEvent.click(view.getByRole("button", { name: "Preview minutes generation" }));
  await waitFor(
    () => assert.notEqual(view.getByRole("heading", { name: "Strategy and budget review", level: 1 }), null),
    {
      timeout: WAIT_FOR_HEADING_TIMEOUT_MS,
    },
  );
  assert.notEqual(view.getByRole("heading", { name: "Meeting minutes" }), null);
  fireEvent.click(view.getByRole("button", { name: "Reset demo" }));
  assert.notEqual(view.getByRole("heading", { name: "Meridian", level: 1 }), null);
  assert.equal(requests.count, 0);
  assert.equal(JSON.stringify(Object.entries(window.localStorage)), beforeLocal);
  assert.equal(JSON.stringify(Object.entries(window.sessionStorage)), beforeSession);
});
