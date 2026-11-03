import assert from "node:assert/strict";
import test from "node:test";

import { type MeetingTrackerDependencies, runMeetingTracker } from "../../application/meeting-tracker";

const job = { id: "job", meetingId: "meeting" };
const MAX_EXPECTED_ATTEMPTS = 3;
const COLLECTION_MS = 3000;
const EARLY_FRAGMENT_MS = 2000;
const BEFORE_WINDOW_END_MS = 999;
const TWO_RUNS = 2;
const JEV_TIMING_MS = 15;
const OPENAI_TIMING_MS = 30;
const PRIVATE_SPEECH = "Private speech";
const PRIVATE_PROVIDER_ERROR = "Private transcript in provider error";

function createLogCapture(): {
  logger: { info: (entry: { fields: Record<string, unknown> }) => void };
  read: () => Record<string, unknown>;
} {
  const capture: { last: Record<string, unknown> } = { last: {} };

  return {
    logger: {
      info: ({ fields }) => {
        capture.last = fields;
      },
    },
    read: () => capture.last,
  };
}

type EventLog = { values: string[] };

function createCommitDependencies(input: { isCommitted: boolean }): {
  deps: MeetingTrackerDependencies;
  events: EventLog;
} {
  const events: EventLog = { values: [] };
  const recordEvent = (event: string): void => {
    events.values = [...events.values, event];
  };

  const deps: MeetingTrackerDependencies = {
    enabled: () => true,
    load: async () => ({
      state: { revision: 0, items: [], updatedAt: null, status: "idle" },
      processedIds: events.values.length !== 0 ? ["segment"] : [],
      segments: [{ id: "segment", speaker: "Personbr", content: PRIVATE_SPEECH, startedAt: new Date() }],
    }),
    analyze: async ({ options }) => {
      options.onTiming?.({ stage: "jevMs", ms: JEV_TIMING_MS });
      options.onTiming?.({ stage: "openaiMs", ms: OPENAI_TIMING_MS });

      return [];
    },
    finish: async () => {
      recordEvent("committed");

      return input.isCommitted;
    },
    fail: async () => {
      assert.fail("unexpected failure");
    },
  };

  return { deps, events };
}

async function assertCommitOutcome(isCommitted: boolean): Promise<void> {
  const { deps, events } = createCommitDependencies({ isCommitted });
  const capture = createLogCapture();
  await runMeetingTracker({
    job,
    logger: capture.logger,
    deps,
  });
  const logged = capture.read();
  assert.deepEqual(events.values, ["committed"]);
  assert.equal(logged.outcome, isCommitted ? "committed" : "stale");
  assert.equal(logged.jevMs, JEV_TIMING_MS);
  assert.equal(logged.openaiMs, OPENAI_TIMING_MS);
  assert.equal(typeof logged.processingMs, "number");
  assert.doesNotMatch(JSON.stringify(logged), /Private speech|Personbr/);
}

void test("publishes only after a successful commit and logs content-free stage timings", async () => {
  await assertCommitOutcome(true);
  await assertCommitOutcome(false);
});

void test("failed processing logs timing without provider error text and does not publish", async () => {
  const failures: EventLog = { values: [] };
  const capture = createLogCapture();
  await assert.rejects(
    runMeetingTracker({
      job,
      logger: capture.logger,
      deps: {
        enabled: () => true,
        load: async () => ({
          state: { revision: 0, items: [], updatedAt: null, status: "idle" },
          processedIds: [],
          segments: [{ id: "s", speaker: "Personbr", content: PRIVATE_SPEECH, startedAt: new Date() }],
        }),
        analyze: async () => {
          throw new Error(PRIVATE_PROVIDER_ERROR);
        },
        finish: async () => {
          assert.fail("must not commit");
        },
        fail: async ({ meetingId }) => {
          failures.values = [...failures.values, meetingId];
        },
      },
    }),
    /Private transcript/,
  );
  assert.deepEqual(failures.values, ["meeting"]);
  assert.equal(capture.read().outcome, "failed");
  assert.doesNotMatch(JSON.stringify(capture.read()), /Private transcript/);
});

void test("stale summary reloads and processes the final speech without another callback", async () => {
  const { deps } = createCommitDependencies({ isCommitted: true });
  const state = { loads: 0, revisions: [] as number[], processed: [] as string[] };
  const capture = createLogCapture();
  await runMeetingTracker({
    job,
    logger: capture.logger,
    deps: {
      ...deps,
      load: async () => {
        const revision = state.loads++;

        return {
          state: { revision, items: [], updatedAt: null, status: "idle" },
          processedIds: revision === 0 ? [] : ["first"],
          segments: ["first", "last"].map((id) => ({ id, speaker: "Personbr", content: id, startedAt: new Date() })),
        };
      },
      analyze: async ({ input }) => {
        state.processed = input.newSegmentIds;

        return [];
      },
      finish: async ({ revision }) => {
        state.revisions = [...state.revisions, revision];

        return revision > 0;
      },
    },
  });
  assert.deepEqual(state.revisions, [0, 1]);
  assert.deepEqual(state.processed, ["last"]);
  assert.equal(capture.read().outcome, "committed");
});

void test("repeated stale writes fail instead of acknowledging unprocessed speech", async () => {
  const { deps } = createCommitDependencies({ isCommitted: true });
  const state = { attempts: 0, failures: 0 };
  await assert.rejects(
    runMeetingTracker({
      job,
      logger: createLogCapture().logger,
      deps: {
        ...deps,
        finish: async () => {
          state.attempts += 1;

          return false;
        },
        fail: async () => {
          state.failures += 1;
        },
      },
    }),
    /changed during every processing attempt/,
  );
  assert.equal(state.attempts, MAX_EXPECTED_ATTEMPTS);
  assert.equal(state.failures, 1);
});

void test("collects for a fixed three seconds and coalesces speech during a run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps } = createCommitDependencies({ isCommitted: true });
  const state = { runs: 0, active: 0, peak: 0, release: () => {} };
  const blocked = new Promise<void>((resolve) => {
    state.release = resolve;
  });
  const request = {
    job,
    logger: createLogCapture().logger,
    deps: {
      ...deps,
      finish: async () => true,
      analyze: async () => {
        state.runs += 1;
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        if (state.runs === 1) {
          await blocked;
        }
        state.active -= 1;

        return [];
      },
    },
  };
  const first = runMeetingTracker(request);
  t.mock.timers.tick(EARLY_FRAGMENT_MS);
  const bundled = runMeetingTracker(request);
  t.mock.timers.tick(BEFORE_WINDOW_END_MS);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(state.runs, 0);
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(state.runs, 1);
  const during = runMeetingTracker(request);
  const alsoDuring = runMeetingTracker(request);
  state.release();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  t.mock.timers.tick(COLLECTION_MS);
  await Promise.all([first, bundled, during, alsoDuring]);
  assert.equal(state.runs, TWO_RUNS);
  assert.equal(state.peak, 1);
  const later = runMeetingTracker(request);
  t.mock.timers.tick(COLLECTION_MS);
  await later;
  assert.equal(state.runs, MAX_EXPECTED_ATTEMPTS);
});
