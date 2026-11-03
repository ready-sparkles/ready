import { strict as assert } from "node:assert";
import test from "node:test";

import { persistedQueryScope, shouldPersistQuery } from "../../composition/query-cache-policy";

void test("meeting and workspace query data is never persisted to browser storage", () => {
  const queries = [
    ["meetings", "workspace"],
    ["meetingDetail", "meeting"],
    ["assignedTasks", "all-workspaces", "user"],
    ["calendar-events", "user", "upcoming-30-days"],
    ["meetingTasksStatus", "meeting", { /** @external query option */ terminal: true }],
    ["relationship-memory", "user", "workspace", "people"],
    ["assignedTaskContext", "meeting"],
  ] as const;
  queries.forEach((queryKey) => {
    assert.equal(persistedQueryScope(queryKey), null);
    assert.equal(shouldPersistQuery(queryKey), false);
  });
});
