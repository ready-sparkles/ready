import { db } from "./client";

export type WorkspaceAshbyIntegration = {
  workspaceId: string;
  secretRef: string;
  configuredByUserId: string | null;
  configuredByName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AshbyCandidateLookup = {
  candidateId: string | null;
  profileUrl: string | null;
  checkedAt: string;
};

const normalizedEmail = (email: string): string => email.trim().toLowerCase();

export async function getWorkspaceAshbyIntegration(workspaceId: string): Promise<WorkspaceAshbyIntegration | null> {
  const row = await db.workspaceAshbyIntegrations.findUnique({
    where: { workspaceId },
    select: {
      workspaceId: true,
      secretRef: true,
      configuredByUserId: true,
      createdAt: true,
      updatedAt: true,
      users: { select: { displayName: true } },
    },
  });

  return row === null
    ? null
    : {
        workspaceId: row.workspaceId,
        secretRef: row.secretRef,
        configuredByUserId: row.configuredByUserId,
        configuredByName: row.users?.displayName ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
}

/** Saves the workspace key. Cached lookups are dropped: a new key may see a different Ashby account. */
export async function saveWorkspaceAshbyIntegration(input: {
  workspaceId: string;
  secretRef: string;
  configuredByUserId: string;
}): Promise<void> {
  await db.workspaceAshbyIntegrations.upsert({
    where: { workspaceId: input.workspaceId },
    create: {
      workspaceId: input.workspaceId,
      secretRef: input.secretRef,
      configuredByUserId: input.configuredByUserId,
    },
    update: {
      secretRef: input.secretRef,
      configuredByUserId: input.configuredByUserId,
      updatedAt: new Date(),
    },
  });
  await db.ashbyCandidateEmailLookups.deleteMany({ where: { workspaceId: input.workspaceId } });
}

/** Removes the workspace key, every member's connection, and cached lookups. */
export async function deleteWorkspaceAshbyIntegration(workspaceId: string): Promise<void> {
  await db.ashbyMemberConnections.deleteMany({ where: { workspaceId } });
  await db.ashbyCandidateEmailLookups.deleteMany({ where: { workspaceId } });
  await db.workspaceAshbyIntegrations.deleteMany({ where: { workspaceId } });
}

const activeAdminNames = async (input: { workspaceId: string; role: "owner" | "admin" }): Promise<string[]> => {
  const rows = await db.workspaceMemberships.findMany({
    where: {
      workspaceId: input.workspaceId,
      role: input.role,
      status: "active",
      users: { deletedAt: null },
    },
    orderBy: { users: { displayName: "asc" } },
    select: { users: { select: { displayName: true } } },
  });

  return rows.map((row) => row.users.displayName);
};

export async function listWorkspaceAdminNames(workspaceId: string): Promise<string[]> {
  const owners = await activeAdminNames({ workspaceId, role: "owner" });
  const admins = await activeAdminNames({ workspaceId, role: "admin" });

  return owners.concat(admins);
}

export async function isAshbyMemberConnected(input: { workspaceId: string; userId: string }): Promise<boolean> {
  const row = await db.ashbyMemberConnections.findUnique({
    where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
    select: { userId: true },
  });

  return row !== null;
}

const workspaceHasAshbyKey = async (workspaceId: string): Promise<boolean> => {
  const row = await db.workspaceAshbyIntegrations.findUnique({
    where: { workspaceId },
    select: { workspaceId: true },
  });

  return row !== null;
};

/** Turns Ashby on for a member. Returns false when the workspace has no key. */
export async function connectAshbyMember(input: { workspaceId: string; userId: string }): Promise<boolean> {
  if (await workspaceHasAshbyKey(input.workspaceId)) {
    await db.ashbyMemberConnections.createMany({
      data: [{ workspaceId: input.workspaceId, userId: input.userId }],
      skipDuplicates: true,
    });
  }

  return isAshbyMemberConnected(input);
}

export async function disconnectAshbyMember(input: { workspaceId: string; userId: string }): Promise<void> {
  await db.ashbyMemberConnections.deleteMany({
    where: { workspaceId: input.workspaceId, userId: input.userId },
  });
}

/** A cached lookup younger than `maxAgeMs`, or null when Ashby should be asked again. */
export async function getCachedAshbyCandidateLookup(input: {
  workspaceId: string;
  email: string;
  maxAgeMs: number;
}): Promise<AshbyCandidateLookup | null> {
  const row = await db.ashbyCandidateEmailLookups.findFirst({
    where: {
      workspaceId: input.workspaceId,
      email: normalizedEmail(input.email),
      checkedAt: { gt: new Date(Date.now() - input.maxAgeMs) },
    },
    select: { candidateId: true, profileUrl: true, checkedAt: true },
  });

  return row === null
    ? null
    : {
        candidateId: row.candidateId,
        profileUrl: row.profileUrl,
        checkedAt: row.checkedAt.toISOString(),
      };
}

export async function saveAshbyCandidateLookup(input: {
  workspaceId: string;
  email: string;
  candidateId: string | null;
  profileUrl: string | null;
}): Promise<void> {
  // Only cache while the workspace still has a key; a removed key must not leave lookups behind.
  if (!(await workspaceHasAshbyKey(input.workspaceId))) {
    return;
  }
  const email = normalizedEmail(input.email);
  const checkedAt = new Date();
  await db.ashbyCandidateEmailLookups.upsert({
    where: { workspaceId_email: { workspaceId: input.workspaceId, email } },
    create: {
      workspaceId: input.workspaceId,
      email,
      candidateId: input.candidateId,
      profileUrl: input.profileUrl,
      checkedAt,
    },
    update: {
      candidateId: input.candidateId,
      profileUrl: input.profileUrl,
      checkedAt,
    },
  });
}
