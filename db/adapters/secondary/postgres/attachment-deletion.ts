import { db } from "./client";

/** Called only after relational/account deletion has finished. */
export async function finishDataDeletionRequest(id: string): Promise<void> {
  const now = new Date();
  await db.dataDeletionRequests.updateMany({
    where: { id },
    data: { status: "completed", attachmentsDeletedAt: now, completedAt: now, updatedAt: now },
  });
}
