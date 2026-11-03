import {
  closeDbPool,
  createWorkspaceCreditGrant,
  db,
  reservePlanCredits,
  STALE_PLAN_CREDIT_RESERVATION_MS,
  updateWorkspacePlan,
  upsertUser,
} from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { getWorkspaceBillingSummary } from "../adapters/secondary/stripe/workspace-stripe-billing";

const TOPUP_CREDITS = 100;
const HELD_COST_MICRO_USD = 140_000;
const HOUR_MS = 3_600_000;

after(closeDbPool);

void test("the owner billing summary returns credits held by an orphaned hold to the pool", async () => {
  const owner = await upsertUser({ email: `${randomUUID()}@stale-hold.test`, displayName: "Stale hold owner" });
  await updateWorkspacePlan({ workspaceId: owner.workspaceId, plan: "pro" });
  await createWorkspaceCreditGrant({ workspaceId: owner.workspaceId, source: "credit_topup", credits: TOPUP_CREDITS });
  const orphan = await reservePlanCredits({
    workspaceId: owner.workspaceId,
    userId: owner.id,
    maximumCostMicroUsd: HELD_COST_MICRO_USD,
    isIncluded: false,
  });
  await db.aiCreditReservations.update({
    where: { id: orphan.id },
    data: { createdAt: new Date(Date.now() - STALE_PLAN_CREDIT_RESERVATION_MS - HOUR_MS) },
  });

  const summary = await getWorkspaceBillingSummary({ workspaceId: owner.workspaceId, viewerUserId: owner.id });

  assert.equal(summary.pool.balance, TOPUP_CREDITS);
  const released = await db.aiCreditReservations.findUniqueOrThrow({ where: { id: orphan.id } });
  assert.equal(released.status, "released");
});
