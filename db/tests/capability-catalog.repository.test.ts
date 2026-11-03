import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { closeDbPool } from "../adapters/secondary/postgres/client";
import {
  getCapabilityByKey,
  listActiveCapabilities,
  listCapabilitiesForMeetingType,
  upsertCapability,
} from "../adapters/secondary/postgres/repositories";
import { getValidatedCapabilityCatalogSeed } from "../domain/capability-catalog-seed";

const validatedSeed = getValidatedCapabilityCatalogSeed();
const INACTIVE_TEST_DEFAULT_PRIORITY = 50;

before(async () => {
  await Promise.all(validatedSeed.map((capability) => upsertCapability(capability)));
});

after(async () => {
  await closeDbPool();
});

void test("query helpers: getCapabilityByKey returns expected seeded capabilities", async () => {
  const externalFollowUp = await getCapabilityByKey("draft_external_follow_up");
  const updateCrm = await getCapabilityByKey("update_crm");

  assert.ok(externalFollowUp);
  assert.equal(externalFollowUp.category, "communication");
  assert.equal(externalFollowUp.sideEffectScope, "private_draft");

  assert.ok(updateCrm);
  assert.equal(updateCrm.category, "state_sync");
  assert.equal(updateCrm.sideEffectScope, "external_action");
});

void test("query helpers: listCapabilitiesForMeetingType filters by active rows and meeting type", async () => {
  const salesCallCapabilities = await listCapabilitiesForMeetingType("sales_call");
  const salesCallKeys = new Set(salesCallCapabilities.map((capability) => capability.key));

  assert.ok(salesCallCapabilities.length !== 0);
  assert.ok(!salesCallKeys.has("file_issue_or_bug"));
  assert.ok(!salesCallKeys.has("create_task_list"));
  assert.ok(!salesCallKeys.has("draft_decision_brief"));
  assert.ok(!salesCallKeys.has("draft_spec_outline"));
  assert.ok(!salesCallKeys.has("prepare_briefing_for_next_meeting"));

  salesCallCapabilities.forEach((capability) => {
    assert.equal(capability.isActive, true);
    assert.ok(capability.applicableMeetingTypes.includes("sales_call"));
  });
});

void test("query helpers: listActiveCapabilities respects is_active", async () => {
  const inactiveKey = `inactive_test_${randomUUID().replaceAll("-", "_")}`;

  await upsertCapability({
    key: inactiveKey,
    name: "Inactive Test Capability",
    description: "Used to verify inactive capabilities stay hidden.",
    category: "execution",
    applicableMeetingTypes: ["standup"],
    requiredSignals: [],
    exclusionSignals: [],
    exampleTriggers: ["Hide this inactive capability.", "Keep this inactive row out."],
    sideEffectScope: "none",
    defaultPriority: INACTIVE_TEST_DEFAULT_PRIORITY,
    isActive: false,
    metadata: {},
  });

  const activeCapabilities = await listActiveCapabilities();
  const activeKeys = new Set(activeCapabilities.map((capability) => capability.key));

  assert.ok(!activeKeys.has(inactiveKey));
});
