import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { z } from "zod";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { render, waitFor, fireEvent, cleanup } = await import("@testing-library/react");
const { SlackConnectorSettingsModal } = await import("../../../presentation/components/slack-connector-settings-modal");

const slackSettingsPutBodySchema = z.object({
  config: z.object({
    routes: z.object({
      sales: z
        .object({
          channelId: z.string(),
          channelName: z.string(),
        })
        .optional(),
    }),
  }),
});

void test("settings has one discovered sales channel and saves no category mappings", async (t) => {
  t.after(cleanup);
  const bodiesState = { bodies: [] as unknown[] };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT" && typeof init.body === "string") {
      bodiesState.bodies = [...bodiesState.bodies, slackSettingsPutBodySchema.parse(JSON.parse(init.body))];
    }
    if (url.endsWith("/sales-channel")) {
      return Response.json({ channel: { id: "C1", name: "sales-meetings", isPrivate: false } });
    }
    if (url.endsWith("/channels")) {
      return Response.json({
        channels: [
          { id: "C1", name: "sales-meetings", isPrivate: false },
          { id: "C2", name: "sales-updates", isPrivate: false },
        ],
      });
    }

    return Response.json({
      slack: {
        /** @external existing wire contract */
        connected: true,
        teamName: "Example",
        /** @external existing wire contract */
        requiresReconnect: true,
        config: { routes: {} },
      },
    });
  });
  const reconnectState = { count: 0 };
  const view = render(
    <SlackConnectorSettingsModal
      token="fixture"
      teamName="Example"
      onClose={() => {}}
      onDisconnect={() => {}}
      onSaved={() => {}}
      onReconnect={() => {
        reconnectState.count += 1;
      }}
    />,
  );
  const channelButton = await view.findByRole("button", { name: "Sales updates channel: #sales-meetings" });
  assert.equal(view.getAllByRole("button", { name: /^Sales updates channel:/ }).length, 1);
  fireEvent.click(channelButton);
  assert.notEqual(view.queryByRole("listbox", { name: "Sales updates channel" }), null);
  fireEvent.click(view.getByRole("option", { name: "#sales-updates" }));
  assert.equal(
    view.getByRole("button", { name: "Sales updates channel: #sales-updates" }).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(view.queryByRole("listbox", { name: "Sales updates channel" }), null);
  assert.equal(view.queryByText("Hiring & interviews") !== null, false);
  fireEvent.click(view.getByRole("button", { name: "Reconnect Slack" }));
  assert.equal(reconnectState.count, 1);
  fireEvent.click(view.getByRole("button", { name: "Save settings" }));
  await waitFor(() => assert.equal(bodiesState.bodies.length, 1));
  assert.deepEqual(bodiesState.bodies[0], {
    config: { routes: { sales: { channelId: "C2", channelName: "sales-updates" } } },
  });
});
