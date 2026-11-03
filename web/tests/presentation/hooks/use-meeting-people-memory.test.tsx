import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { createAmbientContextItem } from "../../../domain/testing/ambient-context-fixture";
import { useMeetingPeopleMemory } from "../../../presentation/hooks/use-meeting-people-memory";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const EXPECTED_MEMORY_RESPONSE_ERROR = "Expected a memory response";
const EXPECTED_MEMORY_CARD_ERROR = "Expected a memory card";
const ACCESS_REVOKED_ERROR = "Access revoked";
const INITIAL_RESULT_COUNT = 1;
const ZERO_RESULT_COUNT = 0;
const FIRST_LOAD_INDEX = 0;
const SECOND_LOAD_INDEX = 1;
const THIRD_LOAD_INDEX = 2;
const FIRST_REFRESH_CALL_COUNT = 1;
const SECOND_REFRESH_CALL_COUNT = 2;
const MEETING_B_ID = "meeting-b";
const VIEWER_B_TOKEN = "viewer-b";
const ARRIVALS_WAITING_KEY = "waiting-person";

const item = {
  ...createAmbientContextItem({ entityKind: "person", status: "ready" }),
  privateImageUrl: null,
  privateDetails: {
    memory: { personId: "private-person", name: "Known person", summary: ["Private"], standing: [], lastContact: null },
    ashby: null,
  },
};
const input = {
  token: "viewer-a",
  meetingId: "meeting-a",
  /** @external meeting people memory hook contract */
  enabled: true,
  arrivalsKey: "",
};

void test("viewer and meeting changes hide old cards and discard late responses", async () => {
  const resolverState = { list: [] as ((items: (typeof item)[]) => void)[] };
  const load = () =>
    new Promise<(typeof item)[]>((resolve) => {
      resolverState.list = [...resolverState.list, resolve];
    });
  const resolveAt = (index: number) => {
    const resolve = resolverState.list[index];
    if (resolve === undefined) {
      throw new Error(EXPECTED_MEMORY_RESPONSE_ERROR);
    }

    return resolve;
  };
  const view = renderHook((props) => useMeetingPeopleMemory({ ...props, load }), { initialProps: input });
  await act(async () => {
    resolveAt(FIRST_LOAD_INDEX)([item]);
  });
  assert.equal(view.result.current.length, INITIAL_RESULT_COUNT);
  view.rerender({ ...input, meetingId: MEETING_B_ID });
  assert.equal(view.result.current.length, ZERO_RESULT_COUNT);
  view.rerender({ ...input, token: VIEWER_B_TOKEN });
  await act(async () => {
    resolveAt(SECOND_LOAD_INDEX)([item]);
  });
  assert.equal(view.result.current.length, ZERO_RESULT_COUNT);
  await act(async () => {
    resolveAt(THIRD_LOAD_INDEX)([]);
  });
  assert.equal(view.result.current.length, ZERO_RESULT_COUNT);
  view.unmount();
});

void test("arrivals refresh private results; leaving hides them and stops requests", async () => {
  const calls = { count: 0 };
  const load = async () => {
    calls.count += 1;

    return [item];
  };
  const view = renderHook((props) => useMeetingPeopleMemory({ ...props, load }), { initialProps: input });
  await act(async () => {});
  assert.equal(view.result.current.length, INITIAL_RESULT_COUNT);
  const firstCard = view.result.current[0];
  if (firstCard === undefined) {
    throw new Error(EXPECTED_MEMORY_CARD_ERROR);
  }
  const firstShownAt = firstCard.researchCompletedAt;
  const firstCards = view.result.current;
  assert.ok(firstShownAt !== null);
  view.rerender({ ...input, arrivalsKey: ARRIVALS_WAITING_KEY });
  await act(async () => {});
  assert.equal(calls.count, SECOND_REFRESH_CALL_COUNT);
  const refreshedCard = view.result.current[0];
  if (refreshedCard === undefined) {
    throw new Error(EXPECTED_MEMORY_CARD_ERROR);
  }
  assert.equal(refreshedCard.researchCompletedAt, firstShownAt, "refreshing does not resurface an old arrival");
  assert.equal(view.result.current, firstCards, "unchanged memory does not rerender the meeting");
  view.rerender({ ...input, /** @external meeting people memory hook contract */ enabled: false });
  assert.equal(view.result.current.length, ZERO_RESULT_COUNT);
  await act(async () => {});
  assert.equal(calls.count, SECOND_REFRESH_CALL_COUNT);
  view.unmount();
});

void test("guests never request memory and lookup errors do not show an error pill", async () => {
  const calls = { count: 0 };
  const load = async () => {
    calls.count += 1;
    throw new Error(ACCESS_REVOKED_ERROR);
  };
  const view = renderHook((props) => useMeetingPeopleMemory({ ...props, load }), {
    initialProps: { ...input, token: undefined as string | undefined },
  });
  await act(async () => {});
  assert.equal(calls.count, 0);
  view.rerender(input);
  await act(async () => {});
  assert.equal(calls.count, FIRST_REFRESH_CALL_COUNT);
  assert.deepEqual(view.result.current, []);
  view.unmount();
});

void test("a late response from the old viewer cannot overwrite cards or resurrect its polling loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = { list: [] as ((items: (typeof item)[]) => void)[] };
  const load = () =>
    new Promise<(typeof item)[]>((resolve) => {
      pending.list = [...pending.list, resolve];
    });
  const view = renderHook((props) => useMeetingPeopleMemory({ ...props, load }), { initialProps: input });
  view.rerender({ ...input, token: VIEWER_B_TOKEN });
  const first = pending.list.at(FIRST_LOAD_INDEX);
  const second = pending.list.at(SECOND_LOAD_INDEX);
  assert.ok(first);
  assert.ok(second);
  await act(async () => second([item]));
  await act(async () => first([]));
  assert.equal(view.result.current.length, INITIAL_RESULT_COUNT);
  const refreshMs = 5000;
  await act(async () => t.mock.timers.tick(refreshMs));
  const expectedLoads = 3;
  assert.equal(pending.list.length, expectedLoads);
  view.unmount();
});
