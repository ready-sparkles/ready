import "../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RegenerateMeetingNotesResponse } from "@readymeet/shared";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";

import {
  canRegenerateFallbackNotes,
  deferredSnapshotRunStep,
} from "../../presentation/components/post-meeting-workspace";
import { RegenerateNotesButton } from "../../presentation/components/regenerate-notes-button";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const FAST_POLL_MS = 5;
const FAST_TIMEOUT_MS = 20;
const TIMEOUT_WAIT_MS = 60;
const NETWORK_FAILURE = "network";
const DEFERRED_RETRY_LIMIT = 12;
const LONG_TIMEOUT_MS = 60_000;
const SINGLE_REQUEST = 1;

after(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(() => {
  cleanup();
});

function deferred<T>() {
  const state: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((resolve) => {
    state.resolve = resolve;
  });

  return { promise, resolve: (value: T) => state.resolve(value) };
}

async function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function detail(input: { model: string; status: "ended" | "active"; createdByUserId: string }) {
  return {
    meeting: { viewerRole: "participant" as const, status: input.status, createdByUserId: input.createdByUserId },
    summary: { model: input.model },
  };
}

void test("double-clicking Generate notes sends one request and stays busy while it runs", async () => {
  const pending = deferred<RegenerateMeetingNotesResponse>();
  const calls = { count: 0 };
  const view = render(
    <RegenerateNotesButton
      onRegenerate={() => {
        calls.count += 1;

        return pending.promise;
      }}
      refresh={async () => undefined}
    />,
  );
  const button = view.getByRole("button");
  await act(async () => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  assert.equal(calls.count, SINGLE_REQUEST);
  assert.equal(view.getByRole("button").textContent, "Generating notes…");
  assert.equal(view.getByRole("button").hasAttribute("disabled"), true);
  await act(async () => {
    pending.resolve({ status: "in_progress" });
  });
  assert.equal(view.getByRole("button").textContent, "Generating notes…");
});

void test("a run that recently failed lets the host try again", async () => {
  const view = render(
    <RegenerateNotesButton
      onRegenerate={async () => ({ status: "recently_failed" })}
      refresh={async () => undefined}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button"));
  });
  assert.match(view.getByRole("status").innerHTML, /couldn't be generated/);
  assert.equal(view.getByRole("button").hasAttribute("disabled"), false);
});

void test("generation that outlasts the poll window says to check back", async () => {
  const view = render(
    <RegenerateNotesButton
      onRegenerate={async () => ({ status: "started" })}
      refresh={async () => undefined}
      pollIntervalMs={FAST_POLL_MS}
      pollTimeoutMs={FAST_TIMEOUT_MS}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button"));
  });
  await act(async () => {
    await wait(TIMEOUT_WAIT_MS);
  });
  assert.match(view.getByRole("status").innerHTML, /longer than expected/);
  assert.equal(view.getByRole("button").hasAttribute("disabled"), false);
});

void test("a run that fails while polling shows the failure right away, not after the poll window", async () => {
  const progress: { status: "in_progress" | "failed" } = { status: "in_progress" };
  const view = render(
    <RegenerateNotesButton
      onRegenerate={async () => ({ status: "started" })}
      refresh={async () => undefined}
      checkProgress={async () => progress.status}
      pollIntervalMs={FAST_POLL_MS}
      pollTimeoutMs={LONG_TIMEOUT_MS}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button"));
  });
  await act(async () => {
    await wait(TIMEOUT_WAIT_MS);
  });
  assert.equal(view.getByRole("button").textContent, "Generating notes…");
  progress.status = "failed";
  await act(async () => {
    await wait(TIMEOUT_WAIT_MS);
  });
  assert.match(view.getByRole("status").innerHTML, /couldn't be generated/);
  assert.equal(view.getByRole("button").hasAttribute("disabled"), false);
});

void test("a failing progress check keeps waiting instead of reporting failure", async () => {
  const view = render(
    <RegenerateNotesButton
      onRegenerate={async () => ({ status: "started" })}
      refresh={async () => undefined}
      checkProgress={async () => {
        throw new Error(NETWORK_FAILURE);
      }}
      pollIntervalMs={FAST_POLL_MS}
      pollTimeoutMs={LONG_TIMEOUT_MS}
    />,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button"));
  });
  await act(async () => {
    await wait(TIMEOUT_WAIT_MS);
  });
  assert.equal(view.getByRole("button").textContent, "Generating notes…");
});

void test("only the host of an ended meeting with fallback notes is offered Generate notes", () => {
  const fallback = detail({ model: "fallback-summary-v1", status: "ended", createdByUserId: HOST_ID });
  assert.equal(canRegenerateFallbackNotes({ detail: fallback, canShowNotes: true, viewerUserId: HOST_ID }), true);
  assert.equal(canRegenerateFallbackNotes({ detail: fallback, canShowNotes: true, viewerUserId: OTHER_ID }), false);
  assert.equal(canRegenerateFallbackNotes({ detail: fallback, canShowNotes: false, viewerUserId: HOST_ID }), false);
  assert.equal(
    canRegenerateFallbackNotes({
      detail: detail({ model: "gpt-5", status: "ended", createdByUserId: HOST_ID }),
      canShowNotes: true,
      viewerUserId: HOST_ID,
    }),
    false,
  );
  assert.equal(
    canRegenerateFallbackNotes({
      detail: detail({ model: "fallback-summary-v1", status: "active", createdByUserId: HOST_ID }),
      canShowNotes: true,
      viewerUserId: HOST_ID,
    }),
    false,
  );
});

void test("notes deferred to a running finalization are asked for again, then reported instead of waiting forever", () => {
  assert.equal(deferredSnapshotRunStep({ snapshot: { id: "snapshot" }, deferredRetries: 0 }), "done");
  assert.equal(deferredSnapshotRunStep({ snapshot: undefined, deferredRetries: 0 }), "done");
  assert.equal(deferredSnapshotRunStep({ snapshot: null, deferredRetries: 0 }), "retry");
  assert.equal(deferredSnapshotRunStep({ snapshot: null, deferredRetries: DEFERRED_RETRY_LIMIT - 1 }), "retry");
  assert.equal(deferredSnapshotRunStep({ snapshot: null, deferredRetries: DEFERRED_RETRY_LIMIT }), "give_up");
});
