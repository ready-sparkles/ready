import { db, type DbTransaction, Prisma } from "./client";

export type AccountTransaction = DbTransaction;

/** Lock users in stable order before any workspace, and never call a provider inside run. */
export async function withAccountMutation<T>(input: {
  userIds: string[];
  run: (tx: AccountTransaction) => Promise<T>;
}): Promise<T> {
  return db.$transaction(async (tx) => {
    if (input.userIds.length !== 0) {
      const userIds = Prisma.join(input.userIds.map((userId) => Prisma.sql`${userId}::uuid`));
      await tx.$queryRaw`
        SELECT id
        FROM users
        WHERE id IN (${userIds})
        ORDER BY id ASC
        FOR UPDATE
      `;
    }

    return input.run(tx);
  });
}

export async function lockAccountWorkspace(input: { tx: AccountTransaction; workspaceId: string }): Promise<void> {
  await input.tx.$queryRaw`
    SELECT id
    FROM workspaces
    WHERE id = ${input.workspaceId}::uuid
    FOR UPDATE
  `;
}
