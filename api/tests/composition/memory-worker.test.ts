import assert from "node:assert/strict";
import test from "node:test";

import { generateFinalizedMeetingMemories } from "../../application/relationship-memory";
import { apiEnv } from "../../composition/env";
import { repositories } from "../../ports/repository-runtime";

const DATABASE_UNAVAILABLE_MESSAGE = "database unavailable";

void test("disabled memory does not discover or dispatch work", async (t) => {
  const isInitiallyEnabled = apiEnv.MEMORY_ENABLED;
  apiEnv.MEMORY_ENABLED = false;
  t.after(() => {
    apiEnv.MEMORY_ENABLED = isInitiallyEnabled;
  });
  t.mock.method(repositories(), "listMemoryMeetingAttendees", async () => {
    assert.fail("must not discover");
  });
  await generateFinalizedMeetingMemories("meeting");
});
void test("memory discovery failures reach the owning request", async (t) => {
  const isInitiallyEnabled = apiEnv.MEMORY_ENABLED;
  apiEnv.MEMORY_ENABLED = true;
  t.after(() => {
    apiEnv.MEMORY_ENABLED = isInitiallyEnabled;
  });
  t.mock.method(repositories(), "listMemoryMeetingAttendees", async () => {
    throw new Error(DATABASE_UNAVAILABLE_MESSAGE);
  });
  await assert.rejects(generateFinalizedMeetingMemories("meeting"), /database unavailable/);
});
