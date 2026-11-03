import { db, type Prisma } from "./client";

type WorkspaceAuditEventRow = {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  eventType: string;
  subjectType: string | null;
  subjectId: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
};

const MESSAGE_FAILED_TO_RECORD_WORKSPACE_AUDIT_EVENT = "Failed to record workspace audit event";

function auditMetadataValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => auditMetadataValue(entry));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        if (entry === undefined) {
          return [];
        }

        return [[key, auditMetadataValue(entry)]];
      }),
    );
  }

  throw new Error(MESSAGE_FAILED_TO_RECORD_WORKSPACE_AUDIT_EVENT);
}

export async function recordWorkspaceAuditEvent(input: {
  workspaceId: string;
  actorUserId: string | null;
  eventType: string;
  subjectType?: string | null;
  subjectId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<WorkspaceAuditEventRow> {
  return db.workspaceAuditEvents.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      eventType: input.eventType,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      metadata: auditMetadataValue(input.metadata ?? {}) ?? {},
    },
  });
}
