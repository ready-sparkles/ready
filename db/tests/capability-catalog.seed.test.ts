import { validateCapabilitySignalReferences } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { assertUniqueCapabilityKeys, getValidatedCapabilityCatalogSeed } from "../domain/capability-catalog-seed";

const validatedSeed = getValidatedCapabilityCatalogSeed();
const EXPECTED_SEEDED_CAPABILITY_COUNT = 7;
const MIN_EXAMPLE_TRIGGER_COUNT = 2;
const MAX_EXAMPLE_TRIGGER_COUNT = 4;

void test("signal registry integrity: seeded capabilities only reference registered signals", () => {
  assert.doesNotThrow(() => validateCapabilitySignalReferences(validatedSeed));
});

void test("seed validity: every seeded capability validates against the shared schema", () => {
  assert.equal(validatedSeed.length, EXPECTED_SEEDED_CAPABILITY_COUNT);

  validatedSeed.forEach((capability) => {
    assert.ok(capability.exampleTriggers.length >= MIN_EXAMPLE_TRIGGER_COUNT);
    assert.ok(capability.exampleTriggers.length <= MAX_EXAMPLE_TRIGGER_COUNT);
    assert.ok(capability.name.length > 0);
    assert.ok(capability.description.length > 0);
  });

  assert.equal(
    validatedSeed.some((capability) => capability.key === "draft_internal_recap"),
    false,
  );
});

void test("key uniqueness: seeded capabilities do not reuse keys", () => {
  assert.doesNotThrow(() => assertUniqueCapabilityKeys(validatedSeed));
});

void test("category coverage: seed data covers the active capability categories", () => {
  const seededCategories = new Set(validatedSeed.map((capability) => capability.category));
  const expectedCategories = new Set([
    "communication",
    "coordination",
    "execution",
    "investigation",
    "preparation",
    "state_sync",
  ]);

  assert.deepEqual(seededCategories, expectedCategories);
});
