import { db } from "./client";

const deleteUserOwnedRows = async (userId: string): Promise<void> => {
  await db.userCapabilityPreferences.deleteMany({ where: { userId } });
  await db.userMediaPreferences.deleteMany({ where: { userId } });
  await db.privateBetaWaitlistEntries.deleteMany({ where: { userId } });
  await db.agentMemories.deleteMany({ where: { userId } });
};

const clearConnectorSecrets = async (connectorIds: string[]): Promise<void> => {
  if (connectorIds.length === 0) {
    return;
  }
  await db.agentConnectorSecrets.deleteMany({ where: { agentConnectorId: { in: connectorIds } } });
  await db.pendingGoogleAddonCalendarCredentials.deleteMany({
    where: { agentConnectorId: { in: connectorIds } },
  });
};

const disconnectUserConnectors = async (userId: string): Promise<void> => {
  const connectors = await db.agentConnectors.findMany({
    where: { userId, deletedAt: null },
  });
  await clearConnectorSecrets(connectors.map((connector) => connector.id));
  await connectors.reduce<Promise<void>>(async (previous, connector) => {
    await previous;
    const now = new Date();
    await db.agentConnectors.updateMany({
      where: { id: connector.id },
      data: {
        status: "disconnected",
        providerAccountId: null,
        providerEmail: null,
        providerTenantId: null,
        externalAccountEmail: null,
        scopes: [],
        syncStatus: "deleted",
        disconnectedAt: connector.disconnectedAt ?? now,
        deletedAt: now,
        updatedAt: now,
      },
    });
  }, Promise.resolve());
};

export async function deleteRemainingUserAccountRows(input: { userId: string }): Promise<void> {
  await deleteUserOwnedRows(input.userId);
  await disconnectUserConnectors(input.userId);
}
