import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db, Prisma } from "../adapters/secondary/postgres/client";
import {
  ensureDefaultAgentProfileForUser,
  getMeetingTaskListForMeeting,
  recordUserAuthentication,
  upsertAgentConnector,
  upsertCalendarSyncSubscription,
} from "../adapters/secondary/postgres/repositories";

const isolated = { /** @external Node test option */ skip: process.env.MEMORY_ISOLATED_DB !== "1" };
const MEETING_DURATION_MS = 60_000;
const SECOND_TRIAL_SLOT = 2;

after(closeDbPool);

void test("targeted billing lookup and unique indexes remain without product advisory locks", isolated, async () => {
  const rows = await db.$queryRaw<{ name: string; definition: string }[]>`
    SELECT indexname AS "name", indexdef AS "definition"
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
  `;
  assert.notEqual(rows.length, 0);
  const publicTables = await db.$queryRaw<{ name: string }[]>`
    SELECT tablename AS "name"
    FROM pg_catalog.pg_tables
    WHERE schemaname = 'public'
  `;
  assert.equal(
    publicTables.some((row) => row.name === "analytics_outbox"),
    false,
  );
  assert.equal(
    publicTables.some((row) => row.name === "memory_meeting_events"),
    false,
  );
  assert.equal(
    publicTables.some((row) => row.name === "user_acquisition"),
    true,
  );
  assert.equal(
    publicTables.some((row) => row.name === "acquisition_payments"),
    true,
  );
  assert.deepEqual(
    rows
      .filter((row) => !row.definition.startsWith("CREATE UNIQUE INDEX"))
      .map((row) => row.name)
      .sort(),
    ["ai_credit_reservations_reserved_allowance_idx", "ai_credit_usage_events_user_workspace_created_idx"],
  );
  [
    "agent_tool_policies_profile_tool_uidx",
    "workspace_memberships_active_owner_key_uidx",
    "meetings_current_link_key_uidx",
    "meeting_trial_slots_pkey",
    "voice_web_research_runs_active_query_uidx",
    "workspaces_one_system_default_per_creator_uidx",
    "attendance_one_open",
    "workspace_task_sections_default_uidx",
  ].forEach((name) => {
    assert.ok(
      rows.some((row) => row.name === name),
      name,
    );
  });
  assert.equal(
    rows.some((row) => row.name === "workspace_memberships_active_owner_uidx"),
    false,
  );
  assert.equal(
    rows.some((row) => row.name === "meetings_one_current_per_link_uidx"),
    false,
  );
  const productFunctions = await db.$queryRaw<{ name: string; source: string | null }[]>`
    SELECT proc.proname AS "name", proc.prosrc AS "source"
    FROM pg_catalog.pg_proc AS proc
    INNER JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = 'public'
  `;
  assert.deepEqual(
    productFunctions.filter((row) => row.source?.includes("pg_advisory") === true),
    [],
  );
  [
    "canonicalize_memory_people_write",
    "prevent_redirected_memory_projection",
    "allocate_completed_meeting_trial_slot",
  ].forEach((name) => {
    assert.ok(
      productFunctions.some((row) => row.name === name),
      name,
    );
  });
  ["link_guest_memory_account", "consolidate_memory_projections", "memory_meeting_revision"].forEach((name) => {
    assert.equal(
      productFunctions.some((row) => row.name === name),
      false,
      "Plaintext content routines are retired.",
    );
  });
});

async function fixture() {
  const ownerId = randomUUID();
  const peerId = randomUUID();
  const workspaceId = randomUUID();
  const meetingId = randomUUID();
  const linkId = randomUUID();
  const now = new Date();
  await db.users.createMany({
    data: [ownerId, peerId].map((id) => ({ id, email: `${id}@lookup.test`, displayName: "Fixture" })),
  });
  await db.workspaces.create({ data: { id: workspaceId, name: "Lookup fixture", createdByUserId: ownerId } });
  await db.workspaceMemberships.create({ data: { workspaceId, userId: ownerId, role: "owner" } });
  await db.meetingLinks.create({
    data: { id: linkId, code: linkId, workspaceId, createdByUserId: ownerId, title: "Fixture" },
  });
  await db.meetings.create({
    data: {
      id: meetingId,
      meetingLinkId: linkId,
      workspaceId,
      createdByUserId: ownerId,
      title: "Fixture",
      roomName: meetingId,
      startedAt: new Date(now.getTime() - MEETING_DURATION_MS),
    },
  });

  return {
    ownerId,
    peerId,
    workspaceId,
    meetingId,
    linkId,
    now,
    async cleanup() {
      await db.meetings.deleteMany({ where: { workspaceId } });
      await db.meetingLinks.deleteMany({ where: { id: linkId } });
      await db.workspaces.deleteMany({ where: { id: workspaceId } });
      await db.users.deleteMany({ where: { id: { in: [ownerId, peerId] } } });
    },
  };
}

void test("authentication and calendar retries use retained generated unique keys", isolated, async () => {
  const f = await fixture();
  try {
    const first = await recordUserAuthentication({ userId: f.ownerId, provider: "google" });
    const retry = await recordUserAuthentication({ userId: f.ownerId, provider: "google" });
    assert.ok(first);
    assert.equal(retry?.id, first.id);
    const profile = await ensureDefaultAgentProfileForUser({ userId: f.ownerId, displayName: "Fixture" });
    const connector = await upsertAgentConnector({
      userId: f.ownerId,
      agentProfileId: profile.id,
      provider: "google_calendar",
      status: "connected",
    });
    const input = {
      userId: f.ownerId,
      agentConnectorId: connector.id,
      provider: "google_calendar" as const,
      channelId: randomUUID(),
    };
    const subscription = await upsertCalendarSyncSubscription(input);
    const channelId = randomUUID();
    const renewed = await upsertCalendarSyncSubscription({ ...input, channelId });
    assert.equal(renewed.id, subscription.id);
    assert.equal(renewed.channelId, channelId);
  } finally {
    await f.cleanup();
  }
});

const uniqueViolation = (constraint: string) => (error: unknown) => {
  assert.ok(error instanceof Prisma.PrismaClientKnownRequestError);
  assert.equal(error.code, "P2002");
  assert.match(error.message, new RegExp(`constraint: \`${constraint}\``));

  return true;
};

void test(
  "active-owner, current-link and trial-slot conflicts still fail; summary retries keep their slot",
  isolated,
  async () => {
    const f = await fixture();
    const secondId = randomUUID();
    try {
      await assert.rejects(
        db.workspaceMemberships.create({ data: { workspaceId: f.workspaceId, userId: f.peerId, role: "owner" } }),
        uniqueViolation("workspace_memberships_active_owner_key_uidx"),
      );
      const second = {
        id: secondId,
        meetingLinkId: f.linkId,
        workspaceId: f.workspaceId,
        createdByUserId: f.ownerId,
        title: "Second",
        roomName: secondId,
        startedAt: new Date(f.now.getTime() - MEETING_DURATION_MS),
      };
      await assert.rejects(db.meetings.create({ data: second }), uniqueViolation("meetings_current_link_key_uidx"));
      await db.meetings.updateMany({ where: { id: f.meetingId }, data: { status: "ended", endedAt: f.now } });
      await db.meetings.create({ data: { ...second, status: "ended", endedAt: f.now } });
      await db.summaries.create({ data: { meetingId: f.meetingId, content: "Delivered notes", model: "fixture" } });
      await assert.rejects(
        db.meetingTrialSlots.create({
          data: { userId: f.ownerId, workspaceId: f.workspaceId, meetingId: secondId, slot: 1 },
        }),
        uniqueViolation("meeting_trial_slots_pkey"),
      );
      await db.summaries.updateMany({ where: { meetingId: f.meetingId }, data: { content: "Revised notes" } });
      await db.summaries.create({ data: { meetingId: secondId, content: "Second notes", model: "fixture" } });
      const slots = await db.meetingTrialSlots.findMany({
        where: { workspaceId: f.workspaceId },
        select: { /** @external Prisma field */ meetingId: true, /** @external Prisma field */ slot: true },
        orderBy: { slot: "asc" },
      });
      assert.deepEqual(slots, [
        { meetingId: f.meetingId, slot: 1 },
        { meetingId: secondId, slot: SECOND_TRIAL_SLOT },
      ]);
    } finally {
      await f.cleanup();
    }
  },
);

void test("meeting-task reads retain ordering without lookup indexes", isolated, async () => {
  const f = await fixture();
  try {
    const listId = randomUUID();
    await db.meetingTaskLists.create({ data: { id: listId, meetingId: f.meetingId } });
    await db.meetingTasks.createMany({
      data: [1, 0].map((position) => ({
        meetingId: f.meetingId,
        taskListId: listId,
        position,
        title: `Task ${position}`,
        type: "task" as const,
        confidence: "high" as const,
        sourceReason: "Fixture",
        sourceQuotes: [{ quote: "Send the proposal.", speaker: null, timestamp: null }],
      })),
    });
    assert.deepEqual(
      (await getMeetingTaskListForMeeting(f.meetingId))?.items.map((item) => item.title),
      ["Task 0", "Task 1"],
    );
  } finally {
    await f.cleanup();
  }
});
