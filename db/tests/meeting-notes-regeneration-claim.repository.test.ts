import { INSUFFICIENT_CREDITS_CODE } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool } from "../adapters/secondary/postgres/client";
import {
  claimMeetingNotesRegeneration,
  completeAiWorkflowJob,
  createMeeting,
  failAiWorkflowJob,
  upsertSummaryForMeeting,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";
import { createWorkspaceCreditGrant } from "../adapters/secondary/postgres/workspace-billing";

const FALLBACK_MODEL = "fallback-summary-v1";
const RETRY_WINDOW_MS = 900_000;
const CONCURRENT_CLAIMS = 3;
const TOP_UP_CREDITS = 100;

after(closeDbPool);

async function meetingWithSummary(model: string | null) {
  const user = await upsertUser({ email: `${randomUUID()}@regen.test`, displayName: "Regen fixture" });
  const meeting = await createMeeting({
    title: "Regen",
    roomName: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  if (model !== null) {
    await upsertSummaryForMeeting({ meetingId: meeting.id, content: "Fallback notes", model });
  }

  return { meetingId: meeting.id, workspaceId: user.workspaceId };
}

void test("only fallback notes can be claimed for regeneration", async () => {
  const { meetingId: realNotes } = await meetingWithSummary("gpt-5.4-mini");
  const { meetingId: noNotes } = await meetingWithSummary(null);
  const claim = { regenerableSummaryModel: FALLBACK_MODEL };
  assert.deepEqual(await claimMeetingNotesRegeneration({ ...claim, meetingId: realNotes }), { status: "not_needed" });
  assert.deepEqual(await claimMeetingNotesRegeneration({ ...claim, meetingId: noNotes }), { status: "not_needed" });
});

void test("concurrent claims start exactly one run and later claims see it in progress", async () => {
  const { meetingId } = await meetingWithSummary(FALLBACK_MODEL);
  const claims = await Promise.all(
    Array.from({ length: CONCURRENT_CLAIMS }, () =>
      claimMeetingNotesRegeneration({ meetingId, regenerableSummaryModel: FALLBACK_MODEL }),
    ),
  );
  const claimedJobs = claims.flatMap((claim) => (claim.status === "claimed" ? [claim.job] : []));
  assert.deepEqual(
    claimedJobs.map((job) => [job.type, job.status]),
    [["generate_meeting_snapshot", "running"]],
  );
  assert.deepEqual(
    claims.filter((claim) => claim.status !== "claimed"),
    [{ status: "in_progress" }, { status: "in_progress" }],
  );
});

void test("a completed run that replaced the fallback is not claimed again", async () => {
  const { meetingId } = await meetingWithSummary(FALLBACK_MODEL);
  const first = await claimMeetingNotesRegeneration({ meetingId, regenerableSummaryModel: FALLBACK_MODEL });
  assert.equal(first.status, "claimed");
  const jobId = first.job.id;
  await upsertSummaryForMeeting({ meetingId, jobId, content: "Real notes", model: "gpt-5.4-mini" });
  await completeAiWorkflowJob({ jobId });
  assert.deepEqual(await claimMeetingNotesRegeneration({ meetingId, regenerableSummaryModel: FALLBACK_MODEL }), {
    status: "not_needed",
  });
});

void test("automatic retries wait after a failed run while a manual retry may claim at once", async () => {
  const { meetingId } = await meetingWithSummary(FALLBACK_MODEL);
  const first = await claimMeetingNotesRegeneration({ meetingId, regenerableSummaryModel: FALLBACK_MODEL });
  const jobId = first.status === "claimed" ? first.job.id : "";
  await failAiWorkflowJob({ jobId, error: INSUFFICIENT_CREDITS_CODE });
  assert.deepEqual(
    await claimMeetingNotesRegeneration({
      meetingId,
      regenerableSummaryModel: FALLBACK_MODEL,
      retryAfterFailureMs: RETRY_WINDOW_MS,
    }),
    { status: "recently_failed" },
  );
  const manual = await claimMeetingNotesRegeneration({ meetingId, regenerableSummaryModel: FALLBACK_MODEL });
  assert.equal(manual.status, "claimed");
});

void test("credits added after a failed run let the automatic retry claim at once", async () => {
  const { meetingId, workspaceId } = await meetingWithSummary(FALLBACK_MODEL);
  const first = await claimMeetingNotesRegeneration({ meetingId, regenerableSummaryModel: FALLBACK_MODEL });
  const jobId = first.status === "claimed" ? first.job.id : "";
  await failAiWorkflowJob({ jobId, error: INSUFFICIENT_CREDITS_CODE });
  await createWorkspaceCreditGrant({ workspaceId, source: "credit_topup", credits: TOP_UP_CREDITS });
  const automatic = await claimMeetingNotesRegeneration({
    meetingId,
    regenerableSummaryModel: FALLBACK_MODEL,
    retryAfterFailureMs: RETRY_WINDOW_MS,
  });
  assert.equal(automatic.status, "claimed");
});
