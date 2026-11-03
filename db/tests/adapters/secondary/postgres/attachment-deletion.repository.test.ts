import assert from "node:assert/strict";
import { after, test } from "node:test";

import { finishDataDeletionRequest } from "../../../../adapters/secondary/postgres/attachment-deletion";
import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";

const MISSING_DELETION_ROW = "Expected a deletion row.";

const deletionStatus = async (id: string): Promise<string> => {
  const [row] = await db.dataDeletionRequests.findMany({
    where: { id },
    select: { /** @external Prisma field */ status: true },
  });
  if (row === undefined) {
    throw new Error(MISSING_DELETION_ROW);
  }

  return row.status;
};

after(closeDbPool);

void test("attachment deletion claims return nothing and an idle request can finish", async (t) => {
  const deletion = await db.dataDeletionRequests.create({
    data: { targetKind: "ready_account", status: "running" },
    select: { /** @external Prisma field */ id: true },
  });
  t.after(async () => {
    await db.dataDeletionRequests.deleteMany({ where: { id: deletion.id } });
  });
  await finishDataDeletionRequest(deletion.id);
  assert.equal(await deletionStatus(deletion.id), "completed");
});
