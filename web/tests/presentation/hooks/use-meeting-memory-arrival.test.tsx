import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import type { AmbientContextViewItem } from "../../../domain/ambient-context-view";
import { createAmbientContextItem } from "../../../domain/testing/ambient-context-fixture";
import { useMeetingMemoryArrival } from "../../../presentation/hooks/use-meeting-memory-arrival";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const EXPECTED_SECOND_OPEN_COUNT = 2;

const arrival: AmbientContextViewItem = {
  ...createAmbientContextItem({ id: "memory-person", status: "ready" }),
  privateDetails: {
    memory: { personId: "person", name: "Personbr", summary: ["Known person"], standing: [], lastContact: null },
    ashby: null,
  },
};

void test("arrivals open after the meeting is visible, once per arrival, and resolve merged cards", () => {
  const openState = { keys: [] as string[] };
  const merged = { ...arrival, id: "shared-person", selectionAliases: [arrival.id] };
  const input = {
    scopeKey: "viewer:meeting",
    /** @external existing wire contract */
    enabled: false,
    arrivals: [arrival],
    items: [merged],
    onOpen: (key: string) => {
      openState.keys = [...openState.keys, key];
    },
  };
  const view = renderHook((props) => useMeetingMemoryArrival(props), { initialProps: input });
  assert.deepEqual(openState.keys, []);
  view.rerender({ ...input, enabled: true });
  assert.deepEqual(openState.keys, ["ambient:shared-person"]);
  view.rerender({ ...input, enabled: true, arrivals: [{ ...arrival }] });
  assert.equal(openState.keys.length, 1, "polling or closing the panel must not reopen it");
  view.rerender({ ...input, enabled: true, arrivals: [{ ...arrival, lastMentionedAt: "2026-09-29T18:00:00.000Z" }] });
  assert.equal(openState.keys.length, EXPECTED_SECOND_OPEN_COUNT, "a new arrival may reopen the panel");
  view.unmount();
});

void test("transcript discoveries never auto-open; each viewer/meeting gets its own first arrival", () => {
  const openState = { keys: [] as string[] };
  const input = {
    scopeKey: "viewer:meeting",
    /** @external existing wire contract */
    enabled: true,
    arrivals: [] as AmbientContextViewItem[],
    items: [arrival],
    onOpen: (key: string) => {
      openState.keys = [...openState.keys, key];
    },
  };
  const view = renderHook((props) => useMeetingMemoryArrival(props), { initialProps: input });
  assert.equal(openState.keys.length, 0);
  view.rerender({ ...input, arrivals: [arrival] });
  assert.equal(openState.keys.length, 1);
  view.rerender({ ...input, scopeKey: "other:meeting", arrivals: [arrival] });
  assert.equal(openState.keys.length, EXPECTED_SECOND_OPEN_COUNT);
  view.unmount();
});
