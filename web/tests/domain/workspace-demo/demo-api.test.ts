import {
  agentSettingsResponseSchema,
  calendarEventPrepEstimateResponseSchema,
  calendarEventPrepResponseSchema,
  calendarEventsResponseSchema,
  meetingDetailResponseSchema,
  meetingListResponseSchema,
  meetingTasksStatusResponseSchema,
  type MemoryListChanges,
  type MemoryListPage,
  myWorkspaceResponseSchema,
  personalAssignedTasksResponseSchema,
  updateMeetingTaskResponseSchema,
  workspaceMemberBillingResponseSchema,
} from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { createWorkspaceDemoApi } from "../../../domain/workspace-demo/demo-api";
import { buildWorkspaceDemoDataset } from "../../../domain/workspace-demo/demo-dataset";

const dataset = buildWorkspaceDemoDataset();
const api = createWorkspaceDemoApi(dataset);
const ws = `/workspaces/${dataset.workspaceId}`;
const get = (path: string) => api({ path, options: {} });

const demoSendBodySchema = z.union([
  z.object({ status: z.literal("completed") }),
  z.object({ ids: z.array(z.string()), action: z.literal("forget") }),
  z.object({
    filters: z.record(z.string(), z.unknown()),
    cursor: z.string().optional(),
    through: z.null(),
  }),
  z.object({}).strict(),
]);

const send = (input: { path: string; method: string; body: unknown }) => {
  const body = demoSendBodySchema.parse(input.body);

  return api({ path: input.path, options: { method: input.method, body: JSON.stringify(body) } });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMemoryListPage(value: unknown): value is MemoryListPage {
  if (!isRecord(value)) {
    return false;
  }
  const memories = value.memories;
  const nextCursor = value.nextCursor;
  const syncCursor = value.syncCursor;

  return (
    Array.isArray(memories) &&
    (nextCursor === null || typeof nextCursor === "string") &&
    (syncCursor === undefined || typeof syncCursor === "string")
  );
}

function isMemoryListChanges(value: unknown): value is MemoryListChanges {
  if (!isRecord(value)) {
    return false;
  }
  const memories = value.memories;
  const removedIds = value.removedIds;
  const syncCursor = value.syncCursor;

  return Array.isArray(memories) && Array.isArray(removedIds) && typeof syncCursor === "string";
}

const TEST_VALUE_2 = 2;
const TEST_VALUE_3 = 3;
const TEST_VALUE_30 = 30;
void test("workspace endpoints return schema-valid payloads", async () => {
  myWorkspaceResponseSchema.parse(await get("/me/workspace"));
  workspaceMemberBillingResponseSchema.parse(await get(`${ws}/billing/me`));
  agentSettingsResponseSchema.parse(await get("/me/agent"));
  const { meetings } = meetingListResponseSchema.parse(await get("/meetings"));
  assert.equal(meetings.length, TEST_VALUE_30);
  const firstMeeting = meetings[0];
  assert.ok(firstMeeting !== undefined);
  const detail = meetingDetailResponseSchema.parse(await get(`/meetings/${firstMeeting.id}`));
  assert.ok(detail.summary !== null && detail.summary.content !== "");
  meetingTasksStatusResponseSchema.parse(await get(`/meetings/${firstMeeting.id}/tasks/status`));
  personalAssignedTasksResponseSchema.parse(await get("/me/tasks/personal"));
});

void test("upcoming calls come with completed prep", async () => {
  const calendar = calendarEventsResponseSchema.parse(await get("/me/calendar/events"));
  assert.equal(calendar.prepSummaries.length, calendar.events.length);
  const firstPrep = calendar.prepSummaries[0];
  assert.ok(firstPrep !== undefined);
  const prep = calendarEventPrepResponseSchema.parse(await get(`/me/calendar/prep/${firstPrep.prepId}`));
  assert.ok(prep.brief.bullets.length !== 0);
  calendarEventPrepEstimateResponseSchema.parse(
    await send({ path: "/me/calendar/prep/estimate", method: "POST", body: {} }),
  );
});

void test("memory pages follow the API cursor contract", async () => {
  const firstRaw = await get(`${ws}/memory`);
  if (!isMemoryListPage(firstRaw)) {
    assert.fail("expected memory list page");
  }
  const first = firstRaw;
  assert.equal(first.memories.length, TEST_VALUE_30);
  assert.equal(first.nextCursor, null);
  const featuredRaw = await get(`${ws}/memory?personId=${dataset.featuredPersonId}`);
  if (!isMemoryListPage(featuredRaw)) {
    assert.fail("expected memory list page");
  }
  const featured = featuredRaw;
  assert.ok(
    featured.memories.length !== 0 &&
      featured.memories.every((memory) => memory.personIds.includes(dataset.featuredPersonId)),
  );
  const searchedRaw = await get(`${ws}/memory?q=${encodeURIComponent("Bellagio eleven")}`);
  if (!isMemoryListPage(searchedRaw)) {
    assert.fail("expected memory list page");
  }
  const searched = searchedRaw;
  assert.ok(searched.memories.some((memory) => memory.title.includes("Bellagio")));
});

void test("task edits and forgotten memories persist for the session", async () => {
  const { tasks } = personalAssignedTasksResponseSchema.parse(await get("/me/tasks/personal"));
  const task = tasks.find((item) => item.sourceType === "meeting" && item.status === "open");
  assert.ok(task !== undefined);
  const { task: updated } = updateMeetingTaskResponseSchema.parse(
    await send({
      path: `/meetings/${task.sourceId}/tasks/${task.taskId}`,
      method: "PATCH",
      body: { status: "completed" },
    }),
  );
  assert.equal(updated.status, "completed");
  const after = personalAssignedTasksResponseSchema.parse(await get("/me/tasks/personal"));
  assert.equal(after.tasks.find((item) => item.taskId === task.taskId)?.status, "completed");

  const pageRaw = await get(`${ws}/memory`);
  if (!isMemoryListPage(pageRaw)) {
    assert.fail("expected memory list page");
  }
  const page = pageRaw;
  const forgotten = page.memories[0];
  assert.ok(forgotten !== undefined);
  await send({ path: `${ws}/memory/actions`, method: "POST", body: { ids: [forgotten.id], action: "forget" } });
  const changesRaw = await send({
    path: `${ws}/memory/sync`,
    method: "POST",
    body: {
      filters: {},
      cursor: page.syncCursor,
      through: null,
    },
  });
  if (!isMemoryListChanges(changesRaw)) {
    assert.fail("expected memory list changes");
  }
  const changes = changesRaw;
  assert.deepEqual(changes.removedIds, [forgotten.id]);
});

void test("requests outside the demo fail without reaching the network", async () => {
  await assert.rejects(send({ path: "/meetings/instant", method: "POST", body: {} }), /demo/);
});

void test("upcoming briefs cite sources and open past meetings inside the demo", async () => {
  const calendar = calendarEventsResponseSchema.parse(await get("/me/calendar/events"));
  await calendar.prepSummaries.reduce(async (previous, summary) => {
    await previous;
    const prep = calendarEventPrepResponseSchema.parse(await get(`/me/calendar/prep/${summary.prepId}`));
    assert.ok(prep.people.bullets.length >= TEST_VALUE_3);
    // Sophie's brief cites two past meetings; other fixtures have more sources.
    assert.ok(prep.people.sources.length >= TEST_VALUE_2);
    await prep.people.sources
      .filter((item) => item.url.includes("/workspace/"))
      .reduce(async (sourcePrevious, source) => {
        await sourcePrevious;
        const meetingId = source.url.split("/workspace/")[1];
        assert.ok(meetingId !== undefined && meetingId !== "");
        meetingDetailResponseSchema.parse(await get(`/meetings/${meetingId}`));
      }, Promise.resolve());
  }, Promise.resolve());
});
