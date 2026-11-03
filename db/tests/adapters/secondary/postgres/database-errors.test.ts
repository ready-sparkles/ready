import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import {
  INSUFFICIENT_AI_CREDITS_SQLSTATE,
  LOCK_NOT_AVAILABLE_SQLSTATE,
  postgresSqlState,
} from "../../../../adapters/secondary/postgres/database-errors";

const PRICE_PER_CREDIT_MICRO_USD = 100_000;
const INSUFFICIENT_CREDITS_TEXT = "Insufficient AI credits";
const SOCKET_ERROR_TEXT = "socket closed";
const SOCKET_ERROR_CODE = "ECONNRESET";
const LOCK_ERROR_TEXT = "could not obtain lock";

after(closeDbPool);

void test("an uncovered credit debit raises the dedicated SQLSTATE, read without matching message text", async () => {
  const user = await db.users.create({ data: { email: `${randomUUID()}@sqlstate.test`, displayName: "No credits" } });
  try {
    await assert.rejects(
      db.aiCreditUsageEvents.create({
        data: {
          userId: user.id,
          actionType: "meeting_ask",
          actionLabel: "Agent push-to-talk",
          actualCostMicroUsd: 0,
          pricePerCreditMicroUsd: PRICE_PER_CREDIT_MICRO_USD,
          markupMultiplier: "1",
          minimumCredits: 1,
          included: false,
          creditsCharged: 1,
          requireAvailableCredits: true,
          revenueMicroUsd: 0,
          profitMicroUsd: 0,
          metadata: {},
        },
      }),
      (error: unknown) => postgresSqlState(error) === INSUFFICIENT_AI_CREDITS_SQLSTATE,
    );
  } finally {
    await db.users.delete({ where: { id: user.id } });
  }
});

void test("errors without a PostgreSQL code have no SQLSTATE", () => {
  assert.equal(postgresSqlState(new Error(INSUFFICIENT_CREDITS_TEXT)), undefined);
  assert.equal(postgresSqlState(Object.assign(new Error(SOCKET_ERROR_TEXT), { code: SOCKET_ERROR_CODE })), undefined);
  assert.equal(
    postgresSqlState(Object.assign(new Error(LOCK_ERROR_TEXT), { code: LOCK_NOT_AVAILABLE_SQLSTATE })),
    LOCK_NOT_AVAILABLE_SQLSTATE,
  );
  assert.equal(postgresSqlState("not an error"), undefined);
});
