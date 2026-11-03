import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { useWaitingRoomMenu } from "../../../presentation/hooks/use-waiting-room-menu";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const first = { id: "request-1", requestedAt: "2026-09-29T10:00:00Z" };

type WaitingRoomMenuInput = {
  scopeKey: string;
  /** @external useWaitingRoomMenu hook contract */
  enabled: boolean;
  requests: (typeof first)[];
  setOpen: (shouldOpen: boolean) => void;
};

void test("new requests open the admit menu, polling respects dismissal, and an empty queue closes it", () => {
  const openState = { isOpen: false };
  const input: WaitingRoomMenuInput = {
    scopeKey: "host:meeting",
    enabled: true,
    requests: [],
    setOpen: (shouldOpen: boolean) => {
      openState.isOpen = shouldOpen;
    },
  };
  const view = renderHook((props) => useWaitingRoomMenu(props), { initialProps: input });
  view.rerender({ ...input, requests: [first] });
  assert.equal(openState.isOpen, true);
  openState.isOpen = false;
  view.rerender({ ...input, requests: [{ ...first }] });
  assert.equal(openState.isOpen, false, "polling must not reopen a dismissed menu");
  view.rerender({ ...input, requests: [first, { ...first, id: "request-2" }] });
  assert.equal(openState.isOpen, true);
  view.rerender(input);
  assert.equal(openState.isOpen, false);
  view.rerender({ ...input, requests: [{ ...first, requestedAt: "2026-09-29T11:00:00Z" }] });
  assert.equal(openState.isOpen, true, "a renewed request can reopen the menu");
  view.unmount();
});

void test("requests wait for host controls to be visible and are scoped to the meeting", () => {
  const openState = { isOpen: false };
  const input: WaitingRoomMenuInput = {
    scopeKey: "host:meeting",
    enabled: false,
    requests: [first],
    setOpen: (shouldOpen: boolean) => {
      openState.isOpen = shouldOpen;
    },
  };
  const view = renderHook((props) => useWaitingRoomMenu(props), { initialProps: input });
  assert.equal(openState.isOpen, false);
  view.rerender({ ...input, enabled: true });
  assert.equal(openState.isOpen, true);
  view.rerender(input);
  assert.equal(openState.isOpen, false);
  view.rerender({ ...input, scopeKey: "host:other-meeting", enabled: true });
  assert.equal(openState.isOpen, true);
  view.unmount();
});
