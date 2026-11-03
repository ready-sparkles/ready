import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { updateWorkspaceSettingsRequestSchema, userSchema } from "@readymeet/shared";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { afterEach, type TestContext } from "node:test";

import { StaticAuthProvider } from "../../../presentation/components/auth-provider";
import { MeetingIntelligenceSettingsPanel } from "../../../presentation/components/meeting-intelligence-settings-panel";

GlobalRegistrator.register();
afterEach(cleanup);
const session = {
  token: "token",
  user: userSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
    displayName: "Owner",
    avatarUrl: null,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    createdAt: new Date(0).toISOString(),
  }),
};
const EXPECTED_SERIALIZED_SETTINGS = "Expected serialized settings";
const HTTP_UNAVAILABLE = 503;
const saved = { isLiveSummaryEnabled: true, isAmbientContextEnabled: true, viewerRole: "owner" };
function prepare(t: TestContext) {
  Object.assign(saved, { isLiveSummaryEnabled: true, isAmbientContextEnabled: true, viewerRole: "owner" });
  t.mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      assert.equal(typeof init.body, "string");
      if (typeof init.body !== "string") {
        throw new Error(EXPECTED_SERIALIZED_SETTINGS);
      }
      Object.assign(saved, updateWorkspaceSettingsRequestSchema.parse(JSON.parse(init.body)));
    }

    return Response.json({
      workspace: {
        ...saved,
        id: session.user.workspaceId,
        name: "Workspace",
        logoUrl: null,
        createdAt: new Date(0).toISOString(),
      },
    });
  });
}
function panel() {
  return (
    <StaticAuthProvider session={session}>
      <MeetingIntelligenceSettingsPanel />
    </StaticAuthProvider>
  );
}
async function ready() {
  const view = render(panel());
  await waitFor(() => assert.equal(view.getByRole("switch", { name: "Live summary" }).hasAttribute("disabled"), false));

  return view;
}
void test("feature switches persist across remount and disable their model selectors independently", async (t) => {
  prepare(t);
  const view = await ready();
  fireEvent.click(view.getByRole("switch", { name: "Live summary" }));
  await waitFor(() => assert.equal(saved.isLiveSummaryEnabled, false));
  await waitFor(() =>
    assert.equal(view.getByRole("switch", { name: "Live summary", checked: false }).hasAttribute("disabled"), false),
  );
  assert.equal(view.getByRole("button", { name: "Live summary model: GPT-6 Luna" }).hasAttribute("disabled"), true);
  assert.equal(
    view.getByRole("button", { name: "Ambient context model: GPT-5.4 Nano" }).hasAttribute("disabled"),
    false,
  );
  view.unmount();
  const reloaded = await ready();
  reloaded.getByRole("switch", { name: "Live summary", checked: false });
  reloaded.getByRole("switch", { name: "Ambient context", checked: true });
});
void test("each model dropdown offers only its current default", async (t) => {
  prepare(t);
  const view = await ready();
  const models = [
    ["Live summary model", "GPT-6 Luna"],
    ["Ambient context model", "GPT-5.4 Nano"],
    ["Ambient research model", "GPT-5.4 Mini"],
  ] as const;
  models.forEach(([label, model]) => {
    fireEvent.click(view.getByRole("button", { name: `${label}: ${model}` }));
    assert.equal(view.getAllByRole("option").length, 1);
    fireEvent.click(view.getByRole("option", { name: model }));
    assert.equal(view.queryByRole("listbox"), null);
  });
});
void test("ordinary members cannot edit workspace intelligence settings", async (t) => {
  prepare(t);
  saved.viewerRole = "member";
  const view = render(panel());
  await waitFor(() => assert.equal(view.container.querySelector("section")?.getAttribute("aria-busy"), "false"));
  assert.equal(view.getByRole("switch", { name: "Live summary" }).hasAttribute("disabled"), true);
});
void test("failed save shows an error and keeps the persisted value", async (t) => {
  prepare(t);
  const view = await ready();
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: HTTP_UNAVAILABLE }));
  fireEvent.click(view.getByRole("switch", { name: "Live summary" }));
  await waitFor(() => assert.match(view.getByRole("alert").textContent, /Could not save/));
  view.getByRole("switch", { name: "Live summary", checked: true });
});
