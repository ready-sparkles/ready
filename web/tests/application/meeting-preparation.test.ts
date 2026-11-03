import assert from "node:assert/strict";
import test from "node:test";

import {
  getModelMeetingPreparationDeck,
  resolveMeetingPreparationPreview,
  waitForModelMeetingPreparationDeck,
} from "../../application/meeting-preparation";

const PREPARATION_READY_ATTEMPT_COUNT = 3;
const PREPARATION_GATE_TIMEOUT_MS = 2_000;
const PREPARATION_GATE_POLL_MS = 100;
const PREPARATION_SHORT_TIMEOUT_MS = 250;
const PREPARATION_SINGLE_ATTEMPT = 1;

void test("only model decks qualify for the workspace handoff", () => {
  assert.equal(
    getModelMeetingPreparationDeck({
      status: "ready",
      lines: ["Reading the conversation as a whole."],
      source: "fallback",
    }),
    null,
  );
  assert.deepEqual(
    getModelMeetingPreparationDeck({
      status: "ready",
      lines: ["Pricing remains the central rollout constraint."],
      source: "model",
    }),
    {
      lines: ["Pricing remains the central rollout constraint."],
      source: "model",
    },
  );
});

void test("ready model and fallback previews are both terminal for workspace polling", () => {
  assert.deepEqual(
    resolveMeetingPreparationPreview({
      status: "pending",
      lines: [],
      source: null,
    }),
    {
      isTerminal: false,
      modelDeck: null,
    },
  );
  assert.deepEqual(
    resolveMeetingPreparationPreview({
      status: "ready",
      lines: ["Reading the conversation as a whole."],
      source: "fallback",
    }),
    {
      isTerminal: true,
      modelDeck: null,
    },
  );
  assert.deepEqual(
    resolveMeetingPreparationPreview({
      status: "ready",
      lines: ["Pricing remains the central rollout constraint."],
      source: "model",
    }),
    {
      isTerminal: true,
      modelDeck: {
        lines: ["Pricing remains the central rollout constraint."],
        source: "model",
      },
    },
  );
});

void test("preparation gate returns the first ready transcript-grounded deck", async () => {
  const attemptState = { count: 0 };
  const clockState = { value: 0 };
  const deck = await waitForModelMeetingPreparationDeck({
    load: async () => {
      attemptState.count += 1;

      return attemptState.count < PREPARATION_READY_ATTEMPT_COUNT
        ? { status: "pending", lines: [], source: null }
        : {
            status: "ready",
            lines: ["Tracing the renewal decision against customer timing."],
            source: "model",
          };
    },
    timeoutMs: PREPARATION_GATE_TIMEOUT_MS,
    pollMs: PREPARATION_GATE_POLL_MS,
    now: () => clockState.value,
    wait: async (ms) => {
      clockState.value += ms;
    },
  });

  assert.equal(attemptState.count, PREPARATION_READY_ATTEMPT_COUNT);
  assert.deepEqual(deck, {
    lines: ["Tracing the renewal decision against customer timing."],
    source: "model",
  });
});

void test("preparation gate returns no handoff when the model misses the overlay window", async () => {
  const clockState = { value: 0 };
  const deck = await waitForModelMeetingPreparationDeck({
    load: async () => ({ status: "pending", lines: [], source: null }),
    timeoutMs: PREPARATION_SHORT_TIMEOUT_MS,
    pollMs: PREPARATION_GATE_POLL_MS,
    now: () => clockState.value,
    wait: async (ms) => {
      clockState.value += ms;
    },
  });

  assert.equal(deck, null);
  assert.equal(clockState.value, PREPARATION_SHORT_TIMEOUT_MS);
});

void test("preparation gate stops when the server returns a terminal fallback deck", async () => {
  const attemptState = { count: 0 };
  const clockState = { value: 0 };
  const deck = await waitForModelMeetingPreparationDeck({
    load: async () => {
      attemptState.count += 1;

      return attemptState.count === PREPARATION_SINGLE_ATTEMPT
        ? {
            status: "ready",
            lines: ["Reading the conversation as a whole."],
            source: "fallback",
          }
        : {
            status: "ready",
            lines: ["Pricing remains the central rollout constraint."],
            source: "model",
          };
    },
    timeoutMs: PREPARATION_SHORT_TIMEOUT_MS,
    pollMs: PREPARATION_GATE_POLL_MS,
    now: () => clockState.value,
    wait: async (ms) => {
      clockState.value += ms;
    },
  });

  assert.equal(attemptState.count, PREPARATION_SINGLE_ATTEMPT);
  assert.equal(deck, null);
});
