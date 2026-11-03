import {
  appendTranscriptSegment,
  closeDbPool,
  createMeetingLinkCallIn,
  createMeetingLinkWithInitialMeeting,
  db,
  getMeetingLinkCallIn,
  getSummaryForMeeting,
  pool,
  upsertUser,
} from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { z } from "zod";

import {
  deactivateMeetingCallInForEndedMeeting,
  ensureMeetingCallInForMeeting,
  ensureMeetingCallInForMeetingSafely,
} from "../../application/meeting-call-in";
import { CALENDAR_EVENT_CALL_IN_WAIT_MS, waitForSyncedCallInForMeeting } from "../../application/meeting-dto";
import { finalizeMeetingIfIdle } from "../../application/meeting-lifecycle";
import { apiEnv } from "../../composition/env";

const POLL_ATTEMPT_COUNT = 100;
const POLL_INTERVAL_MS = 10;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;
const EXPECTED_REPLACEMENT_SYNC_REQUEST_COUNT = 2;
const POOL_SATURATION_MAX_CONNECTIONS = 2;
const PROVIDER_FETCH_YIELD_MS = 30;
const CONCURRENT_REPLACEMENT_CALL_COUNT = 20;
const EXPECTED_SINGLE_PROVIDER_MUTATION_COUNT = 1;
const TEST_TIMEOUT_MS = 10_000;
const DUAL_CAPACITY_SLOT_COUNT = 2;
const CALL_IN_ACTIVE_LEAD_MS = 300_000;
const THIRD_FIXTURE_SLICE_END = 2;
const TOTAL_CAPACITY_SETUP_COUNT = 3;
const CAPACITY_WAIT_PROBE_MS = 30;
const TRANSCRIPT_SEGMENT_STARTED_OFFSET_MS = 120_000;
const TRANSCRIPT_SEGMENT_ENDED_OFFSET_MS = 110_000;
const REQUEST_DEADLINE_WAIT_MS = 25;
const DELETE_RETRY_EXPECTED_ATTEMPTS = 2;
const SINGLE_CONNECTION_POOL_MAX = 1;
const CALENDAR_SLOW_CREATE_DELAY_MS = 1_700;

const LIVEKIT_PROVIDER_ERROR_COPY = {
  notFoundCode: "not_found",
  objectCannotBeFoundMessage: "object cannot be found",
  invalidArgumentCode: "invalid_argument",
  conflictingDispatchRuleMessage: "Conflicting dispatch rule",
  unavailableCode: "unavailable",
  temporaryFailureMessage: "Temporary failure",
};

const sipDeleteRequestBodySchema = z.object({
  sip_dispatch_rule_id: z.string(),
});

const sipCreateRequestBodySchema = z.object({
  dispatch_rule: z.object({
    metadata: z.string(),
  }),
});

const sipDispatchRuleMetadataSchema = z.object({
  meetingLinkId: z.string(),
});

function readRequestInitBody(init: RequestInit): string {
  if (typeof init.body === "string") {
    return init.body;
  }
  if (init.body === undefined || init.body === null) {
    return "";
  }

  return JSON.stringify(init.body);
}

function parseSipDeleteRequestBody(init: RequestInit) {
  return sipDeleteRequestBodySchema.parse(JSON.parse(readRequestInitBody(init)));
}

function parseSipCreateRequestBody(init: RequestInit) {
  return sipCreateRequestBodySchema.parse(JSON.parse(readRequestInitBody(init)));
}

function parseSipDispatchRuleMetadata(metadata: string) {
  return sipDispatchRuleMetadataSchema.parse(JSON.parse(metadata));
}

async function markCallInMeeting(input: { meetingId: string; status: "active" | "ended" }) {
  await db.meetings.updateMany({
    where: { id: input.meetingId },
    data:
      input.status === "active"
        ? { status: "active", startedAt: new Date(Date.now() - CALL_IN_ACTIVE_LEAD_MS) }
        : { status: "ended" },
  });
}

after(closeDbPool);

function deferred() {
  const gate: { resolve: (() => void) | null } = { resolve: null };
  const promise = new Promise<void>((done) => {
    gate.resolve = done;
  });
  if (gate.resolve === null) {
    throw new TypeError(String(gate.resolve));
  }

  return { promise, resolve: gate.resolve };
}

async function pollCallIn(input: { read: () => Promise<boolean> }) {
  await Array.from({ length: POLL_ATTEMPT_COUNT }, (_value, index) => index).reduce(async (previous) => {
    const isDone = await previous;
    if (isDone) {
      return true;
    }
    if (await input.read()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });

    return false;
  }, Promise.resolve(false));
}

async function callInFixture(t: TestContext) {
  const user = await upsertUser({ email: `${randomUUID()}@call-in.readymeet.test`, displayName: "Call-in Fixture" });
  const fixture = await createMeetingLinkWithInitialMeeting({
    title: "Call-in Fixture",
    code: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const originalNumber = apiEnv.LIVEKIT_DIAL_IN_NUMBER;
  apiEnv.LIVEKIT_DIAL_IN_NUMBER = "+15555550100";
  t.after(async () => {
    apiEnv.LIVEKIT_DIAL_IN_NUMBER = originalNumber;
    await db.meetingLinkCallIns.deleteMany({ where: { meetingLinkId: fixture.meetingLink.id } });
    await db.meetings.deleteMany({ where: { id: fixture.meeting.id } });
    await db.meetingLinks.deleteMany({ where: { id: fixture.meetingLink.id } });
    await db.workspaces.deleteMany({ where: { id: user.workspaceId } });
    await db.users.deleteMany({ where: { id: user.id } });
  });

  return fixture;
}

void test("call-in sync replaces missing rules, records create failures and logs useful errors", async (t) => {
  const fixture = await callInFixture(t);
  await createMeetingLinkCallIn({
    meetingLinkId: fixture.meetingLink.id,
    phoneNumber: apiEnv.LIVEKIT_DIAL_IN_NUMBER,
    pin: "123456",
    sipDispatchRuleId: "SDR_missing",
    dispatchRuleKind: "direct",
    lastSyncedMeetingId: fixture.meeting.id,
  });
  const requestLog = { urls: [] as string[] };
  const createState = { isRejected: false };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requestLog.urls = [...requestLog.urls, url];
    if (url.endsWith("/DeleteSIPDispatchRule")) {
      return Response.json(
        { code: LIVEKIT_PROVIDER_ERROR_COPY.notFoundCode, msg: LIVEKIT_PROVIDER_ERROR_COPY.objectCannotBeFoundMessage },
        { status: HTTP_NOT_FOUND },
      );
    }
    assert.ok(url.endsWith("/CreateSIPDispatchRule"), "No other provider calls allowed");

    return createState.isRejected
      ? Response.json(
          {
            code: LIVEKIT_PROVIDER_ERROR_COPY.invalidArgumentCode,
            msg: LIVEKIT_PROVIDER_ERROR_COPY.conflictingDispatchRuleMessage,
          },
          { status: HTTP_BAD_REQUEST },
        )
      : Response.json({ sip_dispatch_rule_id: "SDR_replacement" });
  });
  const warningLog = { entries: [] as Record<string, unknown>[] };
  const logger = {
    warn: (bindings: Record<string, unknown>) => {
      warningLog.entries = [...warningLog.entries, bindings];
    },
  };
  const synced = await ensureMeetingCallInForMeetingSafely({ ...fixture, logger });
  assert.equal(synced?.status, "active");
  assert.equal(synced.sipDispatchRuleId, "SDR_replacement");
  assert.equal(synced.dispatchRuleKind, "holding");
  assert.equal(synced.pin, "123456");
  assert.equal(requestLog.urls.length, EXPECTED_REPLACEMENT_SYNC_REQUEST_COUNT);
  assert.equal(warningLog.entries.length, 0);

  // Force a replacement and reproduce the observed provider rejection.
  await db.meetingLinkCallIns.updateMany({ where: { id: synced.id }, data: { status: "error" } });
  createState.isRejected = true;
  assert.equal(await ensureMeetingCallInForMeetingSafely({ ...fixture, logger }), null);
  const failed = await getMeetingLinkCallIn(fixture.meetingLink.id);
  assert.equal(failed?.status, "error");
  assert.match(failed.lastSyncError ?? "", new RegExp(LIVEKIT_PROVIDER_ERROR_COPY.conflictingDispatchRuleMessage));
  assert.ok(warningLog.entries[0]?.err instanceof Error);
  assert.match(
    warningLog.entries[0].err.message,
    new RegExp(LIVEKIT_PROVIDER_ERROR_COPY.conflictingDispatchRuleMessage),
  );
  assert.equal(failed.sipDispatchRuleId, null);
  createState.isRejected = false;
  assert.equal(
    (await ensureMeetingCallInForMeetingSafely({ ...fixture, logger }))?.status,
    "active",
    "A failed provider operation must release the lock for recovery",
  );
});

void test(
  "concurrent replacement syncs create one provider rule even with a saturated pool",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await callInFixture(t);
    await createMeetingLinkCallIn({
      meetingLinkId: fixture.meetingLink.id,
      phoneNumber: apiEnv.LIVEKIT_DIAL_IN_NUMBER,
      pin: "654321",
      sipDispatchRuleId: "SDR_missing",
      dispatchRuleKind: "direct",
      lastSyncedMeetingId: fixture.meeting.id,
    });
    const originalMax = pool.options.max;
    pool.options.max = POOL_SATURATION_MAX_CONNECTIONS;
    t.after(() => {
      pool.options.max = originalMax;
    });
    const counts = { creates: 0, deletes: 0 };
    const providerRules = new Set<string>();
    t.mock.method(globalThis, "fetch", async (url: string) => {
      if (url.endsWith("/DeleteSIPDispatchRule")) {
        counts.deletes += 1;
        // Yield so competitors can acquire another connection and wait on the lock.
        await new Promise((done) => {
          setTimeout(done, PROVIDER_FETCH_YIELD_MS);
        });

        return Response.json({ code: LIVEKIT_PROVIDER_ERROR_COPY.notFoundCode }, { status: HTTP_NOT_FOUND });
      }
      assert.ok(url.endsWith("/CreateSIPDispatchRule"));
      const id = `SDR_replacement_${(counts.creates += 1)}`;
      providerRules.add(id);

      return Response.json({ sip_dispatch_rule_id: id });
    });
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REPLACEMENT_CALL_COUNT }, () => ensureMeetingCallInForMeeting(fixture)),
    );
    assert.equal(counts.creates, EXPECTED_SINGLE_PROVIDER_MUTATION_COUNT);
    assert.equal(counts.deletes, EXPECTED_SINGLE_PROVIDER_MUTATION_COUNT);
    assert.ok(results.every(Boolean), "Every setup caller must receive dial-in details");
    assert.equal(new Set(results.filter(Boolean).map((row) => row?.sipDispatchRuleId)).size, 1);
    const persisted = await getMeetingLinkCallIn(fixture.meetingLink.id);
    assert.deepEqual([...providerRules], [persisted?.sipDispatchRuleId]);
  },
);

void test(
  "a slow create on one meeting link does not serialize another meeting link",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = await callInFixture(t);
    const second = await callInFixture(t);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.ok(url.endsWith("/CreateSIPDispatchRule"));
      const createBody = parseSipCreateRequestBody(init);
      const meta = parseSipDispatchRuleMetadata(createBody.dispatch_rule.metadata);
      if (meta.meetingLinkId === first.meetingLink.id) {
        firstStarted.resolve();
        await releaseFirst.promise;

        return Response.json({ sip_dispatch_rule_id: "SDR_first" });
      }

      return Response.json({ sip_dispatch_rule_id: "SDR_second" });
    });
    const pending = ensureMeetingCallInForMeeting(first);
    await firstStarted.promise;
    try {
      assert.equal((await ensureMeetingCallInForMeeting(second))?.sipDispatchRuleId, "SDR_second");
    } finally {
      releaseFirst.resolve();
      await pending;
    }
  },
);

void test(
  "meeting-end cleanup returns during creation and an explicit retry deletes a late rule",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await callInFixture(t);
    const createStarted = deferred();
    const releaseCreate = deferred();
    const providerRules = new Set<string>();
    const counts = { creates: 0 };
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/CreateSIPDispatchRule")) {
        counts.creates += 1;
        providerRules.add("SDR_inflight");
        createStarted.resolve();
        await releaseCreate.promise;

        return Response.json({ sip_dispatch_rule_id: "SDR_inflight" });
      }
      assert.ok(url.endsWith("/DeleteSIPDispatchRule"));
      providerRules.delete(parseSipDeleteRequestBody(init).sip_dispatch_rule_id);

      return Response.json({});
    });
    const pending = ensureMeetingCallInForMeeting(fixture);
    await createStarted.promise;
    await markCallInMeeting({ meetingId: fixture.meeting.id, status: "ended" });
    const cleanup = deactivateMeetingCallInForEndedMeeting({
      meeting: { ...fixture.meeting, status: "ended" },
      logger: { warn: () => assert.fail("Cleanup must succeed") },
    });
    await cleanup; // Must finish while creation is still blocked.
    releaseCreate.resolve();
    await pending;
    await deactivateMeetingCallInForEndedMeeting({
      meeting: { ...fixture.meeting, status: "ended" },
      logger: { warn: () => assert.fail("Cleanup must succeed") },
    });
    assert.equal((await getMeetingLinkCallIn(fixture.meetingLink.id))?.status, "inactive");
    assert.equal(providerRules.size, 0);
    assert.equal(await ensureMeetingCallInForMeeting(fixture), null);
    assert.equal(counts.creates, EXPECTED_SINGLE_PROVIDER_MUTATION_COUNT);
  },
);

void test(
  "a third setup waits for capacity and returns its dial-in details",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixtures = [await callInFixture(t), await callInFixture(t), await callInFixture(t)];
    const bothStarted = deferred();
    const release = deferred();
    const counts = { creates: 0 };
    const completion = { isCompleted: false };
    t.mock.method(globalThis, "fetch", async (url: string) => {
      assert.ok(url.endsWith("/CreateSIPDispatchRule"));
      const sequence = (counts.creates += 1);
      if (sequence <= DUAL_CAPACITY_SLOT_COUNT) {
        if (sequence === DUAL_CAPACITY_SLOT_COUNT) {
          bothStarted.resolve();
        }
        await release.promise;
      }

      return Response.json({ sip_dispatch_rule_id: `SDR_capacity_${sequence}` });
    });
    const initial = fixtures.slice(0, THIRD_FIXTURE_SLICE_END).map((fixture) => ensureMeetingCallInForMeeting(fixture));
    await bothStarted.promise;
    const thirdFixture = fixtures[2];
    if (!thirdFixture) {
      throw new TypeError(String(fixtures.length));
    }
    const third = (async () => {
      const result = await ensureMeetingCallInForMeeting(thirdFixture);
      completion.isCompleted = true;

      return result;
    })();
    try {
      await new Promise((resolve) => {
        setTimeout(resolve, CAPACITY_WAIT_PROBE_MS);
      });
      assert.equal(completion.isCompleted, false);
      assert.equal(counts.creates, DUAL_CAPACITY_SLOT_COUNT);
    } finally {
      release.resolve();
    }
    const results = await Promise.all([...initial, third]);
    assert.ok(results.every((result) => result?.status === "active"));
    assert.equal(counts.creates, TOTAL_CAPACITY_SETUP_COUNT);
  },
);

void test(
  "notes are queued while phone-provider deletion is still pending",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await callInFixture(t);
    await markCallInMeeting({ meetingId: fixture.meeting.id, status: "active" });
    await appendTranscriptSegment({
      meetingId: fixture.meeting.id,
      speakerIdentity: "fixture",
      speakerName: "Fixture",
      speakerRole: "human",
      content: "We agreed to review the draft tomorrow and send the finished proposal to the team.",
      startedAt: new Date(Date.now() - TRANSCRIPT_SEGMENT_STARTED_OFFSET_MS),
      endedAt: new Date(Date.now() - TRANSCRIPT_SEGMENT_ENDED_OFFSET_MS),
    });
    await createMeetingLinkCallIn({
      meetingLinkId: fixture.meetingLink.id,
      phoneNumber: apiEnv.LIVEKIT_DIAL_IN_NUMBER,
      pin: "456789",
      sipDispatchRuleId: "SDR_slow_delete",
      dispatchRuleKind: "holding",
      lastSyncedMeetingId: fixture.meeting.id,
    });
    const deleteStarted = deferred();
    const releaseDelete = deferred();
    t.mock.method(globalThis, "fetch", async (url: string | URL) => {
      const address = String(url);
      if (address.endsWith("/DeleteSIPDispatchRule")) {
        deleteStarted.resolve();
        await releaseDelete.promise;

        return Response.json({});
      }
      assert.ok(
        address.includes("ci.livekit.invalid") || address.startsWith(`${apiEnv.ASSISTANT_SERVICE_URL}/`),
        "Only mock control calls allowed",
      );

      return Response.json({
        /** @external livekit mock control ok wire field */
        ok: true,
        /** @external livekit mock control stopped wire field */
        stopped: true,
        /** @external meeting end finalized wire field */
        finalized: true,
      });
    });
    const finalization = finalizeMeetingIfIdle(fixture.meeting.id, { warn() {} }, { force: true });
    await deleteStarted.promise;
    try {
      assert.equal((await finalization).finalized, true);
      assert.ok(await getSummaryForMeeting(fixture.meeting.id));
    } finally {
      releaseDelete.resolve();
      await finalization;
      // Drain the detached cleanup before deleting its test fixtures.
      await pollCallIn({
        read: async () => (await getMeetingLinkCallIn(fixture.meetingLink.id))?.status === "inactive",
      });
      assert.equal((await getMeetingLinkCallIn(fixture.meetingLink.id))?.status, "inactive");
    }
  },
);

void test(
  "request deadline returns while setup continues and notes queue before it finishes",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await callInFixture(t);
    await markCallInMeeting({ meetingId: fixture.meeting.id, status: "active" });
    await appendTranscriptSegment({
      meetingId: fixture.meeting.id,
      speakerIdentity: "fixture",
      speakerName: "Fixture",
      speakerRole: "human",
      content: "We agreed to review the draft tomorrow and send the finished proposal to the team.",
      startedAt: new Date(Date.now() - TRANSCRIPT_SEGMENT_STARTED_OFFSET_MS),
      endedAt: new Date(Date.now() - TRANSCRIPT_SEGMENT_ENDED_OFFSET_MS),
    });
    const createStarted = deferred();
    const releaseCreate = deferred();
    const creation = { isFinished: false };
    t.mock.method(globalThis, "fetch", async (url: string | URL) => {
      const address = String(url);
      if (address.endsWith("/CreateSIPDispatchRule")) {
        createStarted.resolve();
        await releaseCreate.promise;
        creation.isFinished = true;

        return Response.json({ sip_dispatch_rule_id: "SDR_after_request_deadline" });
      }
      if (address.endsWith("/DeleteSIPDispatchRule")) {
        return Response.json({});
      }
      assert.ok(address.includes("ci.livekit.invalid") || address.startsWith(`${apiEnv.ASSISTANT_SERVICE_URL}/`));

      return Response.json({
        /** @external livekit mock control ok wire field */
        ok: true,
        /** @external livekit mock control stopped wire field */
        stopped: true,
        /** @external meeting end finalized wire field */
        finalized: true,
      });
    });
    const logger = { warn() {} };
    const response = waitForSyncedCallInForMeeting({
      input: { ...fixture, logger },
      timeoutMs: REQUEST_DEADLINE_WAIT_MS,
    });
    await createStarted.promise;
    try {
      assert.equal(await response, null, "Request must finish without cancelling provisioning");
      assert.equal(creation.isFinished, false);
      assert.equal((await finalizeMeetingIfIdle(fixture.meeting.id, logger, { force: true })).finalized, true);
      assert.equal(creation.isFinished, false, "Finalization must not wait for SIP setup");
      assert.ok(await getSummaryForMeeting(fixture.meeting.id));
    } finally {
      releaseCreate.resolve();
      await pollCallIn({
        read: async () => Boolean((await getMeetingLinkCallIn(fixture.meetingLink.id))?.sipDispatchRuleId),
      });
      assert.equal(
        (await getMeetingLinkCallIn(fixture.meetingLink.id))?.sipDispatchRuleId,
        "SDR_after_request_deadline",
      );
      await deactivateMeetingCallInForEndedMeeting({ meeting: { ...fixture.meeting, status: "ended" }, logger });
      assert.equal((await getMeetingLinkCallIn(fixture.meetingLink.id))?.status, "inactive");
    }
  },
);

void test("meeting-end cleanup retains failed deletes for an explicit retry", async (t) => {
  const fixture = await callInFixture(t);
  await createMeetingLinkCallIn({
    meetingLinkId: fixture.meetingLink.id,
    phoneNumber: apiEnv.LIVEKIT_DIAL_IN_NUMBER,
    pin: "912345",
    sipDispatchRuleId: "SDR_failed_delete",
    dispatchRuleKind: "holding",
    lastSyncedMeetingId: fixture.meeting.id,
  });
  await markCallInMeeting({ meetingId: fixture.meeting.id, status: "ended" });
  const counts = { attempts: 0 };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.endsWith("/DeleteSIPDispatchRule"));
    counts.attempts += 1;

    return counts.attempts === EXPECTED_SINGLE_PROVIDER_MUTATION_COUNT
      ? Response.json(
          {
            code: LIVEKIT_PROVIDER_ERROR_COPY.unavailableCode,
            msg: LIVEKIT_PROVIDER_ERROR_COPY.temporaryFailureMessage,
          },
          { status: HTTP_SERVICE_UNAVAILABLE },
        )
      : Response.json({});
  });
  const logger = { warn() {} };
  await deactivateMeetingCallInForEndedMeeting({ meeting: { ...fixture.meeting, status: "ended" }, logger });
  assert.equal((await getMeetingLinkCallIn(fixture.meetingLink.id))?.sipDispatchRuleId, "SDR_failed_delete");
  await deactivateMeetingCallInForEndedMeeting({ meeting: { ...fixture.meeting, status: "ended" }, logger });
  assert.equal(counts.attempts, DELETE_RETRY_EXPECTED_ATTEMPTS);
  assert.equal((await getMeetingLinkCallIn(fixture.meetingLink.id))?.status, "inactive");
});

void test(
  "single-connection cleanup leaves the main database connection free during deletion",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await callInFixture(t);
    const originalMax = pool.options.max;
    pool.options.max = SINGLE_CONNECTION_POOL_MAX;
    t.after(() => {
      pool.options.max = originalMax;
    });
    await createMeetingLinkCallIn({
      meetingLinkId: fixture.meetingLink.id,
      phoneNumber: apiEnv.LIVEKIT_DIAL_IN_NUMBER,
      pin: "923456",
      sipDispatchRuleId: "SDR_single_connection",
      dispatchRuleKind: "holding",
      lastSyncedMeetingId: fixture.meeting.id,
    });
    await markCallInMeeting({ meetingId: fixture.meeting.id, status: "ended" });
    const started = deferred();
    const release = deferred();
    t.mock.method(globalThis, "fetch", async (url: string) => {
      assert.ok(url.endsWith("/DeleteSIPDispatchRule"));
      started.resolve();
      await release.promise;

      return Response.json({});
    });
    const pending = deactivateMeetingCallInForEndedMeeting({
      meeting: { ...fixture.meeting, status: "ended" },
      logger: { warn() {} },
    });
    await started.promise;
    try {
      assert.equal((await getMeetingLinkCallIn(fixture.meetingLink.id))?.sipDispatchRuleId, "SDR_single_connection");
    } finally {
      release.resolve();
      await pending;
    }
    assert.equal((await getMeetingLinkCallIn(fixture.meetingLink.id))?.status, "inactive");
  },
);

void test(
  "Calendar wait includes dial-in that finishes after the ordinary request deadline",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await callInFixture(t);
    const counts = { creates: 0 };
    t.mock.method(globalThis, "fetch", async (url: string) => {
      assert.ok(url.endsWith("/CreateSIPDispatchRule"));
      counts.creates += 1;
      await new Promise((resolve) => {
        setTimeout(resolve, CALENDAR_SLOW_CREATE_DELAY_MS);
      });

      return Response.json({ sip_dispatch_rule_id: "SDR_calendar_slow" });
    });
    const result = await waitForSyncedCallInForMeeting({
      input: { ...fixture, logger: { warn() {} } },
      timeoutMs: CALENDAR_EVENT_CALL_IN_WAIT_MS,
    });
    assert.ok(result !== null && "sipDispatchRuleId" in result);
    assert.equal(result.sipDispatchRuleId, "SDR_calendar_slow");
    assert.equal(result.phoneNumber, apiEnv.LIVEKIT_DIAL_IN_NUMBER);
    assert.ok(result.pin !== "");
    assert.equal(counts.creates, EXPECTED_SINGLE_PROVIDER_MUTATION_COUNT);
  },
);
