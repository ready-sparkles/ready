import assert from "node:assert/strict";
import { test } from "node:test";

import { compareRelationshipMemories, memoryImportanceSchema } from "../domain/relationship-memory";

const MEDIUM_MEMORY_IMPORTANCE = 2;
const HIGH_MEMORY_IMPORTANCE = 4;
const OUT_OF_RANGE_MEMORY_IMPORTANCE = 5;
const FRACTIONAL_MEMORY_IMPORTANCE = 2.5;

void test("importance breaks timestamp ties without outranking newer meetings", () => {
  const time = "2026-09-17T19:17:15.323Z";
  const memories = [
    { id: "z", occurredAt: time, importance: 1 },
    { id: "b", occurredAt: time, importance: MEDIUM_MEMORY_IMPORTANCE },
    { id: "a", occurredAt: time, importance: HIGH_MEMORY_IMPORTANCE },
    { id: "old", occurredAt: "2026-09-16T19:17:15Z", importance: HIGH_MEMORY_IMPORTANCE },
    { id: "new", occurredAt: "2026-09-18T19:17:15Z", importance: 1 },
  ];
  assert.deepEqual(
    [...memories].sort(compareRelationshipMemories).map((m) => m.id),
    ["new", "a", "b", "z", "old"],
  );
});
void test("equal importance uses deterministic descending IDs; legacy entries default to context", () => {
  const occurredAt = "2026-09-17T19:17:15Z";
  assert.deepEqual(
    [
      { id: "a", occurredAt },
      { id: "b", occurredAt, importance: 1 },
    ]
      .sort(compareRelationshipMemories)
      .map((m) => m.id),
    ["b", "a"],
  );
  [0, OUT_OF_RANGE_MEMORY_IMPORTANCE, FRACTIONAL_MEMORY_IMPORTANCE, "4", NaN].forEach((invalid) => {
    assert.equal(memoryImportanceSchema.safeParse(invalid).success, false);
  });
});

void test("cursor chronology preserves PostgreSQL microseconds before importance and ID", () => {
  const older = { id: "z", occurredAt: "2026-09-19 10:00:00.123455+00", importance: HIGH_MEMORY_IMPORTANCE };
  const newer = { id: "a", occurredAt: "2026-09-19T10:00:00.123456Z", importance: 1 };
  assert.ok(compareRelationshipMemories(newer, older) < 0);
  assert.equal(compareRelationshipMemories({ ...newer, occurredAt: "2026-09-19T12:00:00.123456+02:00" }, newer), 0);
});
