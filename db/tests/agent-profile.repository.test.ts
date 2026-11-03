import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../adapters/secondary/postgres/client";
import {
  ensureDefaultAgentProfileForUser,
  getDefaultAgentProfileForUser,
  upsertUser,
} from "../adapters/secondary/postgres/repositories";

after(closeDbPool);

const CONCURRENT_PROFILE_REQUEST_COUNT = 20;
const EXPECTED_UNIQUE_PROFILE_COUNT = 1;
const EXPECTED_RELATED_TABLE_ROW_COUNT = 1;
const REQUEST_INDEX_PARITY_DIVISOR = 2;
const ODD_REQUEST_INDEX_REMAINDER = 1;
const AGENT_PROFILE_MISSING_MESSAGE = "Expected a default agent profile";
const TOOL_POLICY_DISABLED_CONFIG = { /** @external agent tool policy config */ enabled: false } as const;

void test("concurrent initialization creates one complete default profile and preserves customized access", async () => {
  const user = await upsertUser({ email: `${randomUUID()}@profile.readymeet.test`, displayName: "Personaa Example" });
  try {
    const input = { userId: user.id, displayName: "Personaa Example", voiceId: "initial-voice" };
    const profiles = await Promise.all(
      Array.from({ length: CONCURRENT_PROFILE_REQUEST_COUNT }, () => ensureDefaultAgentProfileForUser(input)),
    );
    const profile = profiles[0];
    if (profile === undefined) {
      throw new Error(AGENT_PROFILE_MISSING_MESSAGE);
    }
    assert.equal(new Set(profiles.map((item) => item.id)).size, EXPECTED_UNIQUE_PROFILE_COUNT);
    assert.equal(profile.displayName, "Personaa's Assistant");
    const profileCount = await db.agentProfiles.count({ where: { id: profile.id } });
    const connectorCount = await db.agentConnectors.count({ where: { agentProfileId: profile.id } });
    const policyCount = await db.agentToolPolicies.count({ where: { agentProfileId: profile.id } });
    assert.equal(profileCount, EXPECTED_RELATED_TABLE_ROW_COUNT, "agent_profiles");
    assert.equal(connectorCount, EXPECTED_RELATED_TABLE_ROW_COUNT, "agent_connectors");
    assert.equal(policyCount, EXPECTED_RELATED_TABLE_ROW_COUNT, "agent_tool_policies");
    await db.agentToolPolicies.updateMany({
      where: { agentProfileId: profile.id },
      data: { mode: "disabled", config: TOOL_POLICY_DISABLED_CONFIG },
    });
    await db.agentConnectors.updateMany({ where: { agentProfileId: profile.id }, data: { status: "disconnected" } });
    await Promise.all(
      Array.from({ length: CONCURRENT_PROFILE_REQUEST_COUNT }, (_, index) =>
        index % REQUEST_INDEX_PARITY_DIVISOR === ODD_REQUEST_INDEX_REMAINDER
          ? getDefaultAgentProfileForUser(user.id)
          : ensureDefaultAgentProfileForUser({ ...input, displayName: "Changed Name", voiceId: "replacement" }),
      ),
    );
    const unchanged = await getDefaultAgentProfileForUser(user.id);
    assert.equal(unchanged?.displayName, profile.displayName);
    assert.equal(unchanged.voiceId, "initial-voice");
    const policies = await db.agentToolPolicies.findMany({
      where: { agentProfileId: profile.id },
      select: { /** @external Prisma field */ mode: true, /** @external Prisma field */ config: true },
    });
    assert.deepEqual(policies, [{ mode: "disabled", config: TOOL_POLICY_DISABLED_CONFIG }]);
    const connectors = await db.agentConnectors.findMany({
      where: { agentProfileId: profile.id },
      select: { /** @external Prisma field */ status: true },
    });
    assert.deepEqual(connectors, [{ status: "disconnected" }]);

    // Old profiles may be missing defaults. Both read and create paths repair
    // them, and must share the same lock to avoid duplicate tool policies.
    await db.agentToolPolicies.deleteMany({ where: { agentProfileId: profile.id } });
    await db.agentConnectors.deleteMany({ where: { agentProfileId: profile.id } });
    await Promise.all(
      Array.from({ length: CONCURRENT_PROFILE_REQUEST_COUNT }, (_, index) =>
        index % REQUEST_INDEX_PARITY_DIVISOR === ODD_REQUEST_INDEX_REMAINDER
          ? getDefaultAgentProfileForUser(user.id)
          : ensureDefaultAgentProfileForUser(input),
      ),
    );
    const repairedConnectors = await db.agentConnectors.count({ where: { agentProfileId: profile.id } });
    const repairedPolicies = await db.agentToolPolicies.count({ where: { agentProfileId: profile.id } });
    assert.equal(repairedConnectors, EXPECTED_RELATED_TABLE_ROW_COUNT, "agent_connectors");
    assert.equal(repairedPolicies, EXPECTED_RELATED_TABLE_ROW_COUNT, "agent_tool_policies");
  } finally {
    await db.workspaces.deleteMany({ where: { createdByUserId: user.id } });
    await db.users.deleteMany({ where: { id: user.id } });
  }
});
