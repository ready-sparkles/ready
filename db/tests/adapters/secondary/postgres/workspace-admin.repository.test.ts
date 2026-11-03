import type { MeetingTaskCandidate } from "@readymeet/shared";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { closeDbPool, db } from "../../../../adapters/secondary/postgres/client";
import { recordMeetingAttendeeWorkspace } from "../../../../adapters/secondary/postgres/meeting-attendee-workspace";
import {
  createCreditGrant,
  createMeeting,
  ensureDefaultWorkspaceForUser,
  ensureWorkspaceMembership,
  getUserCreditBalanceData,
  isWorkspaceMember,
  listAssignedTasksForUser,
  listWorkspaceIdsForUser,
  listWorkspaceMembers,
  recordAiCreditUsageEvent,
  replaceMeetingTasksForList,
  updateUserPlan,
  upsertBillingSubscription,
  upsertMeetingTaskList,
  upsertParticipantPresence,
  upsertUser,
  workspaceNameForUser,
} from "../../../../adapters/secondary/postgres/repositories";
import {
  acceptWorkspaceInvitation,
  createWorkspaceForUser,
  createWorkspaceInvitation,
  deleteWorkspaceForAdmin,
  getWorkspaceById,
  getWorkspaceMembership,
  isMeetingConfidentialityRequired,
  listAccountDeletionAdminBlocks,
  listMyWorkspacesDetailed,
  listOpenWorkspaceInvitations,
  listWorkspaceAuditEvents,
  listWorkspaceMembersAdmin,
  listWorkspaceVisibleMeetingsForUser,
  markWorkspaceInvitationResent,
  maybeAutoMarkMeetingConfidential,
  MeetingConfidentialityRequiredError,
  removeWorkspaceMember,
  restoreWorkspaceMember,
  revokeWorkspaceInvitation,
  setActiveWorkspaceForUser,
  setMeetingConfidentiality,
  setWorkspaceLogo,
  suspendWorkspaceMember,
  touchUserLastSeen,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
  updateWorkspaceName,
  WorkspaceAdminError,
} from "../../../../adapters/secondary/postgres/workspace-admin";
import {
  countActiveWorkspaceMembers,
  createWorkspaceCreditGrant,
  upsertWorkspaceBillingSubscription,
} from "../../../../adapters/secondary/postgres/workspace-billing";

function postgresErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  const collect = (current: unknown): string[] => {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return [];
    }
    seen.add(current);
    const code: unknown = Object.prototype.hasOwnProperty.call(current, "code")
      ? Object.getOwnPropertyDescriptor(current, "code")?.value
      : undefined;
    const nested = Object.values(current).flatMap((value) => collect(value));

    return typeof code === "string" ? [code, ...nested] : nested;
  };

  return collect(error).find((code) => /^\d{5}$/.test(code));
}

after(async () => {
  await closeDbPool();
});

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MILLISECONDS_PER_DAY = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;
const ONE_DAY_MS = MILLISECONDS_PER_DAY;

const DEFAULT_INVITATION_EXPIRY_DAYS = 14;
const PAST_TIMESTAMP_OFFSET_MS = 60_000;

const ACTIVE_SEAT_COUNT_THREE = 3;
const ACTIVE_SEAT_COUNT_TWO = 2;
const INVITATION_RESEND_COUNT_TWO = 2;

const PROMOTIONAL_GRANT_CREDITS = 6;
const PARALLEL_MEETING_PREP_COST_MICRO_USD = 250_000;
const SUBSCRIPTION_INCLUDED_CREDITS_PER_PERIOD = 6;
const SUBSCRIPTION_PERIOD_START_OFFSET_MS = PAST_TIMESTAMP_OFFSET_MS;
const SUBSCRIPTION_PERIOD_END_OFFSET_MS = ONE_DAY_MS;
const CANCELED_SUBSCRIPTION_START_OFFSET_MS = 7_200_000;
const CANCELED_SUBSCRIPTION_END_OFFSET_MS = 3_600_000;

const DELIBERATE_WORKSPACE_MAX_PER_USER = 10;
const TOPUP_GRANT_CREDITS = 500;
const DELETE_WORKSPACE_INCLUDED_CREDITS = 100;
const DELETE_WORKSPACE_SEAT_QUANTITY = 1;

const MESSAGE_EXPECTED_RELATIONSHIP_MEMORY = "Expected a relationship memory";
const MESSAGE_LAST_SEEN_SET_AFTER_ACTIVITY = "last seen is set after activity";

function futureDate(days = DEFAULT_INVITATION_EXPIRY_DAYS) {
  return new Date(Date.now() + days * MILLISECONDS_PER_DAY);
}

async function makeUser(label: string) {
  return upsertUser({
    email: `${randomUUID()}@${label}.readymeet.test`,
    displayName: `${label} user`,
  });
}

async function makeWorkspaceWithMembers() {
  const admin = await makeUser("wsadmin");
  const member = await makeUser("wsmember");
  await ensureWorkspaceMembership({ workspaceId: admin.workspaceId, userId: member.id, role: "member" });

  return { admin, member, workspaceId: admin.workspaceId };
}

async function activeWorkspaceIdOf(userId: string) {
  const [row] = await db.users.findMany({
    where: { id: userId },
    select: { /** @external Prisma field */ activeWorkspaceId: true },
  });

  return row?.activeWorkspaceId ?? null;
}

function taskCandidate(assignee: { id: string; displayName: string; email: string }): MeetingTaskCandidate {
  return {
    title: "Confidential follow up",
    description: null,
    type: "task",
    workKind: "general",
    owner: {
      userId: assignee.id,
      name: assignee.displayName,
      email: assignee.email,
      confidence: "high",
    },
    dueDate: { value: null, confidence: null },
    confidence: "high",
    completion: { completedDuringMeeting: false, quote: null, confidence: null },
    sourceQuotes: [
      {
        quote: "I will follow up.",
        speaker: assignee.displayName,
        timestamp: "2026-07-01T10:00:00.000Z",
        segmentId: randomUUID(),
      },
    ],
    sourceReason: "Committed during the meeting.",
  };
}

// --- Workspace settings ---

void test("workspace name and logo can be updated and cleared", async () => {
  const { workspaceId } = await makeWorkspaceWithMembers();

  const renamed = await updateWorkspaceName({ workspaceId, name: "Acme HQ" });
  assert.equal(renamed?.name, "Acme HQ");

  const withLogo = await setWorkspaceLogo({ workspaceId, logoUrl: "data:image/png;base64,aGVsbG8=" });
  assert.equal(withLogo?.logoUrl, "data:image/png;base64,aGVsbG8=");

  const cleared = await setWorkspaceLogo({ workspaceId, logoUrl: null });
  assert.equal(cleared?.logoUrl, null);
  assert.equal((await getWorkspaceById(workspaceId))?.name, "Acme HQ");
});

// --- Membership management + owner protection ---

void test("owners can change, suspend, restore, and remove non-owner members", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();

  await updateWorkspaceMemberRole({ workspaceId, actorUserId: admin.id, targetUserId: member.id, role: "admin" });
  assert.equal((await getWorkspaceMembership({ workspaceId, userId: member.id }))?.role, "admin");

  await suspendWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id });
  const suspended = await getWorkspaceMembership({ workspaceId, userId: member.id });
  assert.equal(suspended?.status, "suspended");
  assert.ok(suspended.suspendedAt);

  await restoreWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id, role: "member" });
  const restored = await getWorkspaceMembership({ workspaceId, userId: member.id });
  assert.equal(restored?.status, "active");
  assert.equal(restored.role, "member");

  await removeWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id });
  assert.equal(await getWorkspaceMembership({ workspaceId, userId: member.id }), null);
});

void test("the owner cannot be demoted, suspended, or removed", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();

  await assert.rejects(
    updateWorkspaceMemberRole({ workspaceId, actorUserId: admin.id, targetUserId: admin.id, role: "member" }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "owner_protected",
  );
  await assert.rejects(
    suspendWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: admin.id }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "owner_protected",
  );
  await assert.rejects(
    removeWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: admin.id }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "owner_protected",
  );
  await assert.rejects(
    db.workspaceMemberships.updateMany({
      where: { workspaceId, userId: admin.id },
      data: { status: "suspended" },
    }),
    (error: unknown) => postgresErrorCode(error) === "23514",
  );

  await updateWorkspaceMemberRole({ workspaceId, actorUserId: admin.id, targetUserId: member.id, role: "admin" });
  await assert.rejects(
    suspendWorkspaceMember({ workspaceId, actorUserId: member.id, targetUserId: admin.id }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "owner_protected",
  );
});

void test("ownership transfer is atomic, preserves seat count, and records an audit event", async () => {
  const { admin: owner, member, workspaceId } = await makeWorkspaceWithMembers();
  const seatsBefore = await countActiveWorkspaceMembers(workspaceId);

  await transferWorkspaceOwnership({
    workspaceId,
    actorUserId: owner.id,
    targetUserId: member.id,
  });

  assert.equal((await getWorkspaceMembership({ workspaceId, userId: owner.id }))?.role, "admin");
  assert.equal((await getWorkspaceMembership({ workspaceId, userId: member.id }))?.role, "owner");
  assert.equal(await countActiveWorkspaceMembers(workspaceId), seatsBefore);
  const [event] = await listWorkspaceAuditEvents({ workspaceId, limit: 1 });
  assert.equal(event?.eventType, "workspace.ownership.transferred");
  assert.deepEqual(event.metadata, {
    previousOwnerUserId: owner.id,
    newOwnerUserId: member.id,
  });

  await assert.rejects(
    transferWorkspaceOwnership({ workspaceId, actorUserId: owner.id, targetUserId: member.id }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "workspace_owner_required",
  );
});

void test("concurrent ownership transfers allow only one new owner", async () => {
  const { admin: owner, member, workspaceId } = await makeWorkspaceWithMembers();
  const other = await makeUser("ownership-race");
  await ensureWorkspaceMembership({ workspaceId, userId: other.id, role: "member" });

  const results = await Promise.allSettled([
    transferWorkspaceOwnership({ workspaceId, actorUserId: owner.id, targetUserId: member.id }),
    transferWorkspaceOwnership({ workspaceId, actorUserId: owner.id, targetUserId: other.id }),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const memberships = await listWorkspaceMembersAdmin(workspaceId);
  assert.equal(
    memberships.filter((membership) => membership.role === "owner" && membership.status === "active").length,
    1,
  );
});

void test("billing seats include active roles and exclude suspended members and pending invitations", async () => {
  const { admin: owner, member, workspaceId } = await makeWorkspaceWithMembers();
  const workspaceAdmin = await makeUser("seat-admin");
  await ensureWorkspaceMembership({ workspaceId, userId: workspaceAdmin.id, role: "admin" });
  await createWorkspaceInvitation({
    workspaceId,
    email: `${randomUUID()}@pending-seat.readymeet.test`,
    role: "member",
    invitedByUserId: owner.id,
    tokenHash: hashToken(randomUUID()),
    expiresAt: futureDate(),
  });

  assert.equal(await countActiveWorkspaceMembers(workspaceId), ACTIVE_SEAT_COUNT_THREE);
  await suspendWorkspaceMember({ workspaceId, actorUserId: owner.id, targetUserId: member.id });
  assert.equal(await countActiveWorkspaceMembers(workspaceId), ACTIVE_SEAT_COUNT_TWO);
  await transferWorkspaceOwnership({ workspaceId, actorUserId: owner.id, targetUserId: workspaceAdmin.id });
  assert.equal(await countActiveWorkspaceMembers(workspaceId), ACTIVE_SEAT_COUNT_TWO);
});

void test("account deletion guard requires owners of shared workspaces to transfer first", async () => {
  const soloAdmin = await makeUser("solo-admin");
  assert.deepEqual(await listAccountDeletionAdminBlocks(soloAdmin.id), []);

  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();
  assert.deepEqual(
    (await listAccountDeletionAdminBlocks(admin.id)).map((workspace) => workspace.workspaceId),
    [workspaceId],
  );

  await updateWorkspaceMemberRole({ workspaceId, actorUserId: admin.id, targetUserId: member.id, role: "admin" });
  assert.deepEqual(
    (await listAccountDeletionAdminBlocks(admin.id)).map((workspace) => workspace.workspaceId),
    [workspaceId],
  );
  await transferWorkspaceOwnership({ workspaceId, actorUserId: admin.id, targetUserId: member.id });
  assert.deepEqual(await listAccountDeletionAdminBlocks(admin.id), []);
});

void test("private-beta Pro credit events do not consume promotional grants", async () => {
  const user = await makeUser("private-beta-pro");
  await updateUserPlan({ userId: user.id, plan: "business", privateBetaProEnabled: true });
  await createCreditGrant({
    userId: user.id,
    source: "promotional",
    credits: PROMOTIONAL_GRANT_CREDITS,
    metadata: { /** @external existing fixture metadata flag */ test: true },
  });

  await recordAiCreditUsageEvent({
    userId: user.id,
    actionType: "meeting_prep",
    actionLabel: "Meeting prep research",
    provider: "parallel",
    actualCostMicroUsd: PARALLEL_MEETING_PREP_COST_MICRO_USD,
    idempotencyKey: `test:private-beta-pro:${randomUUID()}`,
    requireAvailableCredits: true,
  });

  const balance = await getUserCreditBalanceData(user.id);
  assert.equal(balance.promotionalCredits, PROMOTIONAL_GRANT_CREDITS);
  assert.equal(balance.balance, PROMOTIONAL_GRANT_CREDITS);
});

void test("retired raw credit recorder preserves promotional grants without private-beta entitlement", async () => {
  const user = await makeUser("stale-paid-plan");
  await updateUserPlan({ userId: user.id, plan: "business" });
  await createCreditGrant({
    userId: user.id,
    source: "promotional",
    credits: PROMOTIONAL_GRANT_CREDITS,
    metadata: { /** @external existing fixture metadata flag */ test: true },
  });

  await recordAiCreditUsageEvent({
    userId: user.id,
    actionType: "meeting_prep",
    actionLabel: "Meeting prep research",
    provider: "parallel",
    actualCostMicroUsd: 0,
    minimumCredits: 1,
    idempotencyKey: `test:stale-paid-plan:${randomUUID()}`,
    requireAvailableCredits: true,
  });

  const balance = await getUserCreditBalanceData(user.id);
  assert.equal(balance.promotionalCredits, PROMOTIONAL_GRANT_CREDITS);
  assert.equal(balance.balance, PROMOTIONAL_GRANT_CREDITS);
});

void test("retired raw credit recorder preserves subscriber grants even with private-beta flags", async () => {
  const user = await makeUser("private-beta-subscriber");
  await updateUserPlan({ userId: user.id, plan: "business", privateBetaProEnabled: true });
  await createCreditGrant({
    userId: user.id,
    source: "subscription_period",
    credits: PROMOTIONAL_GRANT_CREDITS,
    metadata: { /** @external existing fixture metadata flag */ test: true },
  });
  await upsertBillingSubscription({
    userId: user.id,
    stripeSubscriptionId: `sub_test_${randomUUID()}`,
    stripePriceId: "price_test",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: SUBSCRIPTION_INCLUDED_CREDITS_PER_PERIOD,
    currentPeriodStart: new Date(Date.now() - SUBSCRIPTION_PERIOD_START_OFFSET_MS),
    currentPeriodEnd: new Date(Date.now() + SUBSCRIPTION_PERIOD_END_OFFSET_MS),
  });

  await recordAiCreditUsageEvent({
    userId: user.id,
    actionType: "meeting_prep",
    actionLabel: "Meeting prep research",
    provider: "parallel",
    actualCostMicroUsd: 0,
    minimumCredits: 1,
    idempotencyKey: `test:private-beta-subscriber:${randomUUID()}`,
    requireAvailableCredits: true,
  });

  const balance = await getUserCreditBalanceData(user.id);
  assert.equal(balance.subscriptionCredits, PROMOTIONAL_GRANT_CREDITS);
  assert.equal(balance.balance, PROMOTIONAL_GRANT_CREDITS);
});

void test("private-beta Pro credit events ignore old canceled subscription history", async () => {
  const user = await makeUser("private-beta-canceled-subscription");
  await updateUserPlan({ userId: user.id, plan: "business", privateBetaProEnabled: true });
  await createCreditGrant({
    userId: user.id,
    source: "promotional",
    credits: PROMOTIONAL_GRANT_CREDITS,
    metadata: { /** @external existing fixture metadata flag */ test: true },
  });
  await upsertBillingSubscription({
    userId: user.id,
    stripeSubscriptionId: `sub_test_${randomUUID()}`,
    stripePriceId: "price_test",
    status: "canceled",
    planInterval: "month",
    includedCreditsPerPeriod: SUBSCRIPTION_INCLUDED_CREDITS_PER_PERIOD,
    currentPeriodStart: new Date(Date.now() - CANCELED_SUBSCRIPTION_START_OFFSET_MS),
    currentPeriodEnd: new Date(Date.now() - CANCELED_SUBSCRIPTION_END_OFFSET_MS),
  });

  await recordAiCreditUsageEvent({
    userId: user.id,
    actionType: "meeting_prep",
    actionLabel: "Meeting prep research",
    provider: "parallel",
    actualCostMicroUsd: 0,
    minimumCredits: 1,
    idempotencyKey: `test:private-beta-canceled-subscription:${randomUUID()}`,
    requireAvailableCredits: true,
  });

  const balance = await getUserCreditBalanceData(user.id);
  assert.equal(balance.promotionalCredits, PROMOTIONAL_GRANT_CREDITS);
  assert.equal(balance.balance, PROMOTIONAL_GRANT_CREDITS);
});

void test("suspended members lose workspace access checks until restored", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();

  // The member attended a meeting; while suspended it must vanish from their
  // list too (matching the per-meeting access check), not just workspace-wide
  // meetings they never attended.
  const attended = await createMeeting({
    title: "Attended before suspension",
    roomName: `attended-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
  });
  await upsertParticipantPresence({ meetingId: attended.id, userId: member.id, role: "guest" });

  assert.equal(await isWorkspaceMember({ workspaceId, userId: member.id }), true);
  assert.ok((await listWorkspaceIdsForUser(member.id)).includes(workspaceId));
  const beforeSuspension = await listWorkspaceVisibleMeetingsForUser({
    userId: member.id,
    workspaceIds: await listWorkspaceIdsForUser(member.id),
  });
  assert.ok(beforeSuspension.some((meeting) => meeting.id === attended.id));

  await suspendWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id });
  assert.equal(await isWorkspaceMember({ workspaceId, userId: member.id }), false);
  assert.equal((await listWorkspaceIdsForUser(member.id)).includes(workspaceId), false);
  const whileSuspended = await listWorkspaceVisibleMeetingsForUser({
    userId: member.id,
    workspaceIds: await listWorkspaceIdsForUser(member.id),
  });
  assert.equal(
    whileSuspended.some((meeting) => meeting.workspaceId === workspaceId),
    false,
    "no meetings from the suspending workspace, attended ones included",
  );
  assert.equal(
    (await listWorkspaceMembers(workspaceId)).some((row) => row.userId === member.id),
    false,
    "suspended members are hidden from the assignee picker listing",
  );
  assert.equal(
    (await listWorkspaceMembersAdmin(workspaceId)).some(
      (row) => row.userId === member.id && row.status === "suspended",
    ),
    true,
    "suspended members stay visible to admins",
  );

  await restoreWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: member.id, role: "member" });
  assert.equal(await isWorkspaceMember({ workspaceId, userId: member.id }), true);
  const afterRestore = await listWorkspaceVisibleMeetingsForUser({
    userId: member.id,
    workspaceIds: await listWorkspaceIdsForUser(member.id),
  });
  assert.ok(afterRestore.some((meeting) => meeting.id === attended.id));
});

// --- Invitations ---

void test("invitation lifecycle: create, list, resend, revoke", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const email = `${randomUUID()}@invitee.readymeet.test`;
  const token = randomUUID();

  const invitation = await createWorkspaceInvitation({
    workspaceId,
    email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });
  assert.equal(invitation.email, email);

  // Duplicate active invitations are rejected.
  await assert.rejects(
    createWorkspaceInvitation({
      workspaceId,
      email: email.toUpperCase(),
      role: "admin",
      invitedByUserId: admin.id,
      tokenHash: hashToken(randomUUID()),
      expiresAt: futureDate(),
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "already_invited",
  );

  const open = await listOpenWorkspaceInvitations(workspaceId);
  assert.ok(open.some((row) => row.id === invitation.id));

  // Resending rotates the token so the previous link stops working.
  const newToken = randomUUID();
  const resent = await markWorkspaceInvitationResent({
    workspaceId,
    invitationId: invitation.id,
    tokenHash: hashToken(newToken),
    expiresAt: futureDate(),
  });
  assert.equal(resent.sendCount, INVITATION_RESEND_COUNT_TWO);
  await assert.rejects(
    acceptWorkspaceInvitation({ tokenHash: hashToken(token), userId: admin.id, userEmail: email }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "invitation_not_found",
  );

  await revokeWorkspaceInvitation({ workspaceId, invitationId: invitation.id });
  assert.equal(
    (await listOpenWorkspaceInvitations(workspaceId)).some((row) => row.id === invitation.id),
    false,
  );
  await assert.rejects(
    acceptWorkspaceInvitation({
      tokenHash: hashToken(newToken),
      userId: admin.id,
      userEmail: email,
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "invitation_revoked",
  );
});

void test("inviting an existing member is rejected", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();
  await assert.rejects(
    createWorkspaceInvitation({
      workspaceId,
      email: member.email,
      role: "member",
      invitedByUserId: admin.id,
      tokenHash: hashToken(randomUUID()),
      expiresAt: futureDate(),
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "already_member",
  );
});

void test("a removed member can be invited back and accept the fresh invitation", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();

  // Legacy and manually repaired workspaces can contain a pending invitation
  // alongside the membership. Removal must close it before re-inviting.
  await db.workspaceInvitations.create({
    data: {
      workspaceId,
      email: member.email,
      role: "member",
      tokenHash: hashToken(randomUUID()),
      invitedByUserId: admin.id,
      expiresAt: futureDate(),
    },
  });

  await removeWorkspaceMember({
    workspaceId,
    actorUserId: admin.id,
    targetUserId: member.id,
  });

  const token = randomUUID();
  const invitation = await createWorkspaceInvitation({
    workspaceId,
    email: member.email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });
  assert.equal(invitation.email, member.email);

  await acceptWorkspaceInvitation({
    tokenHash: hashToken(token),
    userId: member.id,
    userEmail: member.email,
  });

  const membership = await getWorkspaceMembership({ workspaceId, userId: member.id });
  assert.ok(membership);
  assert.equal(membership.status, "active");
  assert.equal(membership.role, "member");
});

void test("creating a new invitation retires an expired invitation for the same email", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const email = `${randomUUID()}@returning.readymeet.test`;

  const expired = await createWorkspaceInvitation({
    workspaceId,
    email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(randomUUID()),
    expiresAt: new Date(Date.now() - PAST_TIMESTAMP_OFFSET_MS),
  });

  const fresh = await createWorkspaceInvitation({
    workspaceId,
    email,
    role: "admin",
    invitedByUserId: admin.id,
    tokenHash: hashToken(randomUUID()),
    expiresAt: futureDate(),
  });

  assert.notEqual(fresh.id, expired.id);
  assert.equal(fresh.role, "admin");
  const open = await listOpenWorkspaceInvitations(workspaceId);
  assert.equal(
    open.some((row) => row.id === expired.id),
    false,
  );
  assert.equal(
    open.some((row) => row.id === fresh.id),
    true,
  );
});

void test("the database rejects invitations that attempt to grant Owner", async () => {
  const { admin: owner, workspaceId } = await makeWorkspaceWithMembers();
  await assert.rejects(
    db.workspaceInvitations.create({
      data: {
        workspaceId,
        email: `${randomUUID()}@owner-invite.readymeet.test`,
        role: "owner",
        tokenHash: hashToken(randomUUID()),
        invitedByUserId: owner.id,
        expiresAt: futureDate(),
      },
    }),
    (error: unknown) => postgresErrorCode(error) === "23514",
  );
});

void test("an existing Ready user can accept an invitation with the invited email only", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const invitee = await makeUser("invitee");
  const token = randomUUID();

  await createWorkspaceInvitation({
    workspaceId,
    email: invitee.email,
    role: "admin",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });

  const wrongUser = await makeUser("wrong-invitee");
  await assert.rejects(
    acceptWorkspaceInvitation({
      tokenHash: hashToken(token),
      userId: wrongUser.id,
      userEmail: wrongUser.email,
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "invitation_email_mismatch",
  );

  const accepted = await acceptWorkspaceInvitation({
    tokenHash: hashToken(token),
    userId: invitee.id,
    userEmail: invitee.email.toUpperCase(),
  });
  assert.equal(accepted.role, "admin");
  const membership = await getWorkspaceMembership({ workspaceId, userId: invitee.id });
  assert.equal(membership?.role, "admin");
  assert.equal(membership.status, "active");
  assert.equal(await activeWorkspaceIdOf(invitee.id), workspaceId);

  // Accepting twice fails cleanly.
  await assert.rejects(
    acceptWorkspaceInvitation({
      tokenHash: hashToken(token),
      userId: invitee.id,
      userEmail: invitee.email,
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "invitation_accepted",
  );
});

void test("a brand-new invited signup ends up with only the joined workspace", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const invitee = await makeUser("fresh-invitee");
  const signupWorkspaceId = invitee.workspaceId;
  const token = randomUUID();

  await createWorkspaceInvitation({
    workspaceId,
    email: invitee.email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });
  await acceptWorkspaceInvitation({
    tokenHash: hashToken(token),
    userId: invitee.id,
    userEmail: invitee.email,
  });

  // The auto-created signup workspace is gone; the joined workspace is the
  // user's only workspace and their active one.
  assert.equal(await getWorkspaceById(signupWorkspaceId), null);
  assert.deepEqual(await listWorkspaceIdsForUser(invitee.id), [workspaceId]);
  assert.equal(await activeWorkspaceIdOf(invitee.id), workspaceId);
  // The default-workspace fallback resolves to the joined workspace instead
  // of resurrecting a personal one.
  assert.equal(
    await ensureDefaultWorkspaceForUser({
      userId: invitee.id,
      email: invitee.email,
      displayName: invitee.displayName,
    }),
    workspaceId,
  );
});

void test("an invited user with a used workspace keeps it and joins the new one", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const invitee = await makeUser("established-invitee");
  await createMeeting({
    title: "Existing meeting",
    roomName: `room-${randomUUID()}`,
    createdByUserId: invitee.id,
    workspaceId: invitee.workspaceId,
  });

  const token = randomUUID();
  await createWorkspaceInvitation({
    workspaceId,
    email: invitee.email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });
  await acceptWorkspaceInvitation({
    tokenHash: hashToken(token),
    userId: invitee.id,
    userEmail: invitee.email,
  });

  assert.notEqual(await getWorkspaceById(invitee.workspaceId), null);
  assert.deepEqual(
    [...(await listWorkspaceIdsForUser(invitee.id))].sort(),
    [...[invitee.workspaceId, workspaceId]].sort(),
  );
  assert.equal(await activeWorkspaceIdOf(invitee.id), workspaceId);
});

const insertExternalHistoryMemory = async (input: {
  userId: string;
  workspaceId: string;
  meetingId: string;
}): Promise<string> => {
  const sourceRow = await db.memorySources.create({
    data: {
      userId: input.userId,
      workspaceId: input.workspaceId,
      kind: "meeting_transcript",
      externalId: input.meetingId,
      meetingId: input.meetingId,
      occurredAt: new Date(),
      revision: "fixture",
    },
    select: { /** @external Prisma field */ id: true },
  });
  const memoryRow = await db.relationshipMemories.create({
    data: {
      sourceId: sourceRow.id,
      fingerprint: "fixture",
      factFingerprint: "fixture",
      factIdentity: { subject: "contact", predicate: "offered", object: "proposal", context: "" },
      title: "Your contact offered a proposal",
      description: "They offered to send you a proposal.",
      category: "Sales",
      personIds: [],
      /** @external column */
      sensitive: false,
      confidence: "high",
      occurredAt: new Date(),
    },
    select: { /** @external Prisma field */ id: true },
  });

  return memoryRow.id;
};

[false, true].forEach((hasMemory) => {
  void test(`a signup workspace with external meeting history survives invitation acceptance (memory=${hasMemory})`, async () => {
    const { admin, workspaceId } = await makeWorkspaceWithMembers();
    const invitee = await makeUser("external-history-invitee");
    const host = await makeUser("external-history-host");
    const meeting = await createMeeting({
      title: "Privately attended external meeting",
      roomName: `room-${randomUUID()}`,
      createdByUserId: host.id,
      workspaceId: host.workspaceId,
    });
    await recordMeetingAttendeeWorkspace({
      meetingId: meeting.id,
      userId: invitee.id,
      workspaceId: invitee.workspaceId,
    });
    await upsertParticipantPresence({ meetingId: meeting.id, userId: invitee.id });
    await db.meetings.updateMany({ where: { id: meeting.id }, data: { status: "ended", endedAt: new Date() } });
    const memoryId = hasMemory
      ? await insertExternalHistoryMemory({
          userId: invitee.id,
          workspaceId: invitee.workspaceId,
          meetingId: meeting.id,
        })
      : undefined;
    const token = randomUUID();
    await createWorkspaceInvitation({
      workspaceId,
      email: invitee.email,
      role: "member",
      invitedByUserId: admin.id,
      tokenHash: hashToken(token),
      expiresAt: futureDate(),
    });
    await acceptWorkspaceInvitation({
      tokenHash: hashToken(token),
      userId: invitee.id,
      userEmail: invitee.email,
    });

    assert.notEqual(await getWorkspaceById(invitee.workspaceId), null);
    assert.equal(await activeWorkspaceIdOf(invitee.id), workspaceId);
    assert.deepEqual(
      [...(await listWorkspaceIdsForUser(invitee.id))].sort(),
      [...[invitee.workspaceId, workspaceId]].sort(),
    );
    const [mapping] = await db.meetingAttendeeWorkspaces.findMany({
      where: { meetingId: meeting.id, userId: invitee.id },
      select: { /** @external Prisma field */ workspaceId: true },
    });
    assert.equal(mapping?.workspaceId, invitee.workspaceId);
    assert.ok(
      (
        await listWorkspaceVisibleMeetingsForUser({
          userId: invitee.id,
          workspaceIds: [invitee.workspaceId],
        })
      ).some((row) => row.id === meeting.id),
    );
    assert.ok(
      !(
        await listWorkspaceVisibleMeetingsForUser({
          userId: invitee.id,
          workspaceIds: [workspaceId],
        })
      ).some((row) => row.id === meeting.id),
    );
    if (hasMemory) {
      if (memoryId === undefined) {
        throw new Error(MESSAGE_EXPECTED_RELATIONSHIP_MEMORY);
      }
      const [savedMemory] = await db.relationshipMemories.findMany({
        where: { id: memoryId },
        select: { /** @external Prisma field */ id: true },
      });
      assert.ok(savedMemory);
    }
  });
});

void test("a deliberately created empty workspace survives invitation acceptance", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const invitee = await makeUser("deliberate-workspace-invitee");
  // The user intentionally created a second, still-empty workspace. Only the
  // system-created signup workspace is a deletable artifact.
  const deliberate = await createWorkspaceForUser({
    userId: invitee.id,
    name: "My side project",
    maxWorkspacesPerUser: DELIBERATE_WORKSPACE_MAX_PER_USER,
  });

  const token = randomUUID();
  await createWorkspaceInvitation({
    workspaceId,
    email: invitee.email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });
  await acceptWorkspaceInvitation({
    tokenHash: hashToken(token),
    userId: invitee.id,
    userEmail: invitee.email,
  });

  assert.equal((await getWorkspaceById(deliberate.id))?.name, "My side project");
  assert.equal(await getWorkspaceById(invitee.workspaceId), null);
  assert.deepEqual([...(await listWorkspaceIdsForUser(invitee.id))].sort(), [...[deliberate.id, workspaceId]].sort());
  assert.equal(await activeWorkspaceIdOf(invitee.id), workspaceId);
});

void test("a signup workspace that gained another member survives invitation acceptance", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const invitee = await makeUser("shared-workspace-invitee");
  const teammate = await makeUser("shared-workspace-teammate");
  await ensureWorkspaceMembership({
    workspaceId: invitee.workspaceId,
    userId: teammate.id,
    role: "member",
  });

  const token = randomUUID();
  await createWorkspaceInvitation({
    workspaceId,
    email: invitee.email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });
  await acceptWorkspaceInvitation({
    tokenHash: hashToken(token),
    userId: invitee.id,
    userEmail: invitee.email,
  });

  assert.notEqual(await getWorkspaceById(invitee.workspaceId), null);
  assert.equal(await isWorkspaceMember({ workspaceId: invitee.workspaceId, userId: teammate.id }), true);
  assert.equal(await activeWorkspaceIdOf(invitee.id), workspaceId);
});

void test("a signup workspace holding paid top-up credits survives invitation acceptance", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const invitee = await makeUser("topup-workspace-invitee");
  const stripeReference = `cs_test_${randomUUID()}`;
  await createWorkspaceCreditGrant({
    workspaceId: invitee.workspaceId,
    source: "credit_topup",
    credits: TOPUP_GRANT_CREDITS,
    stripeReference,
  });

  const token = randomUUID();
  await createWorkspaceInvitation({
    workspaceId,
    email: invitee.email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });
  await acceptWorkspaceInvitation({
    tokenHash: hashToken(token),
    userId: invitee.id,
    userEmail: invitee.email,
  });

  assert.notEqual(await getWorkspaceById(invitee.workspaceId), null);
  const grants = await db.creditGrants.findMany({
    where: { stripeReference },
    select: { creditsRemaining: true },
  });
  assert.deepEqual(grants, [{ creditsRemaining: TOPUP_GRANT_CREDITS }]);
  assert.equal(await activeWorkspaceIdOf(invitee.id), workspaceId);
});

void test("a signup workspace with only a canceled subscription survives invitation acceptance", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const invitee = await makeUser("canceled-subscription-invitee");
  await upsertWorkspaceBillingSubscription({
    workspaceId: invitee.workspaceId,
    userId: invitee.id,
    stripeSubscriptionId: `sub_canceled_${randomUUID()}`,
    stripePriceId: "price_test",
    status: "canceled",
    planInterval: "month",
    includedCreditsPerPeriod: 0,
    seatQuantity: 1,
  });

  const token = randomUUID();
  await createWorkspaceInvitation({
    workspaceId,
    email: invitee.email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: futureDate(),
  });
  await acceptWorkspaceInvitation({
    tokenHash: hashToken(token),
    userId: invitee.id,
    userEmail: invitee.email,
  });

  assert.notEqual(await getWorkspaceById(invitee.workspaceId), null);
});

void test("expired invitations cannot be accepted", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const invitee = await makeUser("expired-invitee");
  const token = randomUUID();

  await createWorkspaceInvitation({
    workspaceId,
    email: invitee.email,
    role: "member",
    invitedByUserId: admin.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() - PAST_TIMESTAMP_OFFSET_MS),
  });

  await assert.rejects(
    acceptWorkspaceInvitation({
      tokenHash: hashToken(token),
      userId: invitee.id,
      userEmail: invitee.email,
    }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "invitation_expired",
  );
});

// --- Workspace visibility + confidentiality ---

void test("workspace members see colleague meetings but never confidential ones", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();

  const openMeeting = await createMeeting({
    title: "Open standup",
    roomName: `open-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
    isConfidential: false,
  });
  const confidentialMeeting = await createMeeting({
    title: "Sensitive 1:1",
    roomName: `conf-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
  });
  // New meetings are confidential unless the host deliberately unlocks them.
  assert.equal(openMeeting.isConfidential, false);
  assert.equal(confidentialMeeting.isConfidential, true);

  const memberVisible = await listWorkspaceVisibleMeetingsForUser({
    userId: member.id,
    workspaceIds: [workspaceId],
  });
  assert.ok(memberVisible.some((meeting) => meeting.id === openMeeting.id));
  assert.equal(
    memberVisible.some((meeting) => meeting.id === confidentialMeeting.id),
    false,
  );
  assert.equal(
    memberVisible.find((meeting) => meeting.id === openMeeting.id)?.isParticipant,
    false,
    "non-attended colleague meetings are flagged for the read-only viewer role",
  );

  // Another workspace admin without participation gets no special access.
  const otherAdmin = await makeUser("other-admin");
  await ensureWorkspaceMembership({ workspaceId, userId: otherAdmin.id, role: "admin" });
  const adminVisible = await listWorkspaceVisibleMeetingsForUser({
    userId: otherAdmin.id,
    workspaceIds: [workspaceId],
  });
  assert.equal(
    adminVisible.some((meeting) => meeting.id === confidentialMeeting.id),
    false,
  );

  // Participants keep access to confidential meetings.
  await upsertParticipantPresence({ meetingId: confidentialMeeting.id, userId: member.id, role: "guest" });
  const participantVisible = await listWorkspaceVisibleMeetingsForUser({
    userId: member.id,
    workspaceIds: [workspaceId],
  });
  assert.ok(participantVisible.some((meeting) => meeting.id === confidentialMeeting.id));

  // Outsiders see nothing from this workspace.
  const outsider = await makeUser("outsider");
  const outsiderVisible = await listWorkspaceVisibleMeetingsForUser({
    userId: outsider.id,
    workspaceIds: await listWorkspaceIdsForUser(outsider.id),
  });
  assert.equal(
    outsiderVisible.some((meeting) => meeting.workspaceId === workspaceId),
    false,
  );
});

void test("tasks from confidential meetings are hidden from non-participants", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();

  const meeting = await createMeeting({
    title: "Task source meeting",
    roomName: `tasks-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
    isConfidential: false,
  });
  const taskList = await upsertMeetingTaskList({
    meetingId: meeting.id,
    status: "completed",
    phase: "complete",
  });
  const [task] = await replaceMeetingTasksForList({
    meetingId: meeting.id,
    taskListId: taskList.id,
    items: [taskCandidate(member)],
  });
  assert.ok(task);

  // Visible while the meeting is workspace-visible.
  const before = await listAssignedTasksForUser({ userId: member.id, workspaceIds: [workspaceId] });
  assert.ok(before.some((row) => row.task.id === task.id));

  // Confidential: the assignee is not a participant, so the task disappears.
  await setMeetingConfidentiality({
    meetingId: meeting.id,
    isConfidential: true,
    source: "manual",
    actorUserId: admin.id,
  });
  const hidden = await listAssignedTasksForUser({ userId: member.id, workspaceIds: [workspaceId] });
  assert.equal(
    hidden.some((row) => row.task.id === task.id),
    false,
  );

  // Task visibility follows the source meeting: participants keep access.
  await upsertParticipantPresence({ meetingId: meeting.id, userId: member.id, role: "guest" });
  const asParticipant = await listAssignedTasksForUser({ userId: member.id, workspaceIds: [workspaceId] });
  assert.ok(asParticipant.some((row) => row.task.id === task.id));

  // Once this is no longer a one-to-one, unlocking restores workspace
  // visibility (inheritance is live, not copied).
  const third = await makeUser("task-source-third");
  await ensureWorkspaceMembership({ workspaceId, userId: third.id });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: third.id, role: "guest" });
  await setMeetingConfidentiality({
    meetingId: meeting.id,
    isConfidential: false,
    source: "manual",
    actorUserId: admin.id,
  });
  const restored = await listAssignedTasksForUser({ userId: member.id, workspaceIds: [workspaceId] });
  assert.ok(restored.some((row) => row.task.id === task.id));
});

void test("confidentiality changes record audit events and the meeting lock", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const meeting = await createMeeting({
    title: "Audited meeting",
    roomName: `audit-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
    isConfidential: false,
  });

  await setMeetingConfidentiality({
    meetingId: meeting.id,
    isConfidential: true,
    source: "manual",
    actorUserId: admin.id,
  });

  const events = await listWorkspaceAuditEvents({
    workspaceId,
    subjectType: "meeting",
    subjectId: meeting.id,
  });
  assert.ok(events.some((event) => event.eventType === "meeting.confidentiality.changed"));
  const visible = await listWorkspaceVisibleMeetingsForUser({ userId: admin.id, workspaceIds: [workspaceId] });
  assert.equal(visible.find((item) => item.id === meeting.id)?.isConfidential, true);
});

// --- Automatic one-to-one confidentiality ---

void test("an explicit creation-time confidentiality choice is recorded as manual", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const meeting = await createMeeting({
    title: "Explicitly open meeting",
    roomName: `explicit-open-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
    isConfidential: false,
  });

  assert.equal(meeting.isConfidential, false);
  assert.equal(meeting.confidentialitySource, "manual");
  assert.equal(meeting.confidentialityUpdatedByUserId, admin.id);
  assert.ok(meeting.confidentialityUpdatedAt);
});

void test("internal one-to-one meetings become confidential automatically", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();
  const meeting = await createMeeting({
    title: "Internal 1:1",
    roomName: `one-on-one-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
    isConfidential: false,
  });

  await upsertParticipantPresence({ meetingId: meeting.id, userId: admin.id, role: "host" });
  assert.equal(await maybeAutoMarkMeetingConfidential(meeting.id), false, "one participant is not enough");

  await upsertParticipantPresence({ meetingId: meeting.id, userId: member.id, role: "guest" });
  assert.equal(await maybeAutoMarkMeetingConfidential(meeting.id), false, "participant write already applied privacy");

  const updated = await listWorkspaceVisibleMeetingsForUser({ userId: admin.id, workspaceIds: [workspaceId] });
  const row = updated.find((item) => item.id === meeting.id);
  assert.equal(row?.isConfidential, true);
  assert.equal(row.confidentialitySource, "auto");
  assert.equal(await isMeetingConfidentialityRequired(meeting.id), true);

  await assert.rejects(
    setMeetingConfidentiality({
      meetingId: meeting.id,
      isConfidential: false,
      source: "manual",
      actorUserId: admin.id,
    }),
    (error: unknown) => error instanceof MeetingConfidentialityRequiredError,
  );
});

void test("a default-locked internal one-to-one is marked as policy-required", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();
  const meeting = await createMeeting({
    title: "Default locked 1:1",
    roomName: `default-locked-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
  });

  await upsertParticipantPresence({ meetingId: meeting.id, userId: member.id, role: "guest" });
  assert.equal(await maybeAutoMarkMeetingConfidential(meeting.id), false, "participant write already applied privacy");

  const visible = await listWorkspaceVisibleMeetingsForUser({ userId: admin.id, workspaceIds: [workspaceId] });
  const row = visible.find((item) => item.id === meeting.id);
  assert.equal(row?.isConfidential, true);
  assert.equal(row.confidentialitySource, "auto");
  assert.equal(await isMeetingConfidentialityRequired(meeting.id), true);
});

void test("a later third participant never removes automatic confidentiality", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();
  const third = await makeUser("third");
  await ensureWorkspaceMembership({ workspaceId, userId: third.id });

  const meeting = await createMeeting({
    title: "Grew beyond 1:1",
    roomName: `grew-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
    isConfidential: false,
  });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: admin.id, role: "host" });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: member.id, role: "guest" });
  assert.equal(await maybeAutoMarkMeetingConfidential(meeting.id), false, "participant write already applied privacy");

  await upsertParticipantPresence({ meetingId: meeting.id, userId: third.id, role: "guest" });
  assert.equal(await maybeAutoMarkMeetingConfidential(meeting.id), false, "no re-evaluation once set");
  const visible = await listWorkspaceVisibleMeetingsForUser({ userId: admin.id, workspaceIds: [workspaceId] });
  assert.equal(visible.find((item) => item.id === meeting.id)?.isConfidential, true);
});

void test("meetings with a guest or external participant are not auto-confidential", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const external = await makeUser("external");

  const meeting = await createMeeting({
    title: "External 1:1",
    roomName: `external-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
    isConfidential: false,
  });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: admin.id, role: "host" });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: external.id, role: "guest" });

  assert.equal(await maybeAutoMarkMeetingConfidential(meeting.id), false);
});

void test("internal one-to-one confidentiality overrides a prior manual unlock", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();
  const meeting = await createMeeting({
    title: "Organizer opted out",
    roomName: `manual-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
  });

  // Organizer explicitly unlocked the meeting before the second join.
  await setMeetingConfidentiality({
    meetingId: meeting.id,
    isConfidential: false,
    source: "manual",
    actorUserId: admin.id,
  });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: admin.id, role: "host" });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: member.id, role: "guest" });

  assert.equal(await maybeAutoMarkMeetingConfidential(meeting.id), false, "participant write already applied privacy");
  const visible = await listWorkspaceVisibleMeetingsForUser({ userId: member.id, workspaceIds: [workspaceId] });
  const row = visible.find((item) => item.id === meeting.id);
  assert.equal(row?.isConfidential, true);
  assert.equal(row.confidentialitySource, "auto");
});

// --- Joining no longer auto-enrolls workspace membership ---

void test("joining a meeting does not add the participant to the workspace", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const visitor = await makeUser("visitor");

  const meeting = await createMeeting({
    title: "Visited meeting",
    roomName: `visited-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
  });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: visitor.id, role: "guest" });

  assert.equal(await isWorkspaceMember({ workspaceId, userId: visitor.id }), false);
  // They still see the meeting they attended.
  const visible = await listWorkspaceVisibleMeetingsForUser({
    userId: visitor.id,
    workspaceIds: await listWorkspaceIdsForUser(visitor.id),
  });
  assert.ok(visible.some((item) => item.id === meeting.id));
});

void test("attended meetings appear only under the workspace they belong to for members", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();
  const meeting = await createMeeting({
    title: "Scoped to its workspace",
    roomName: `scoped-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
  });
  await upsertParticipantPresence({ meetingId: meeting.id, userId: member.id, role: "guest" });

  // Viewing the workspace the meeting belongs to: visible.
  const inOwningWorkspace = await listWorkspaceVisibleMeetingsForUser({
    userId: member.id,
    workspaceIds: [workspaceId],
  });
  assert.ok(inOwningWorkspace.some((row) => row.id === meeting.id));

  // Viewing the member's own default workspace: the attended meeting belongs
  // to another workspace they are a member of, so it stays out of this view.
  const inOtherWorkspace = await listWorkspaceVisibleMeetingsForUser({
    userId: member.id,
    workspaceIds: [member.workspaceId],
  });
  assert.equal(
    inOtherWorkspace.some((row) => row.id === meeting.id),
    false,
  );

  // Outsiders file attended meetings in their joining workspace.
  const outsider = await makeUser("scoped-outsider");
  await upsertParticipantPresence({ meetingId: meeting.id, userId: outsider.id, role: "guest" });
  const outsiderView = await listWorkspaceVisibleMeetingsForUser({
    userId: outsider.id,
    workspaceIds: [outsider.workspaceId],
  });
  assert.ok(outsiderView.some((row) => row.id === meeting.id));
});

// --- Default workspace naming ---

void test("new default workspace names derive from the company domain or first name", async () => {
  assert.equal(workspaceNameForUser({ email: "personbr@example.edu", displayName: "Personbr M" }), "Example");
  assert.equal(workspaceNameForUser({ email: "personbz@example.net", displayName: "Personbz R" }), "Example");
  assert.equal(workspaceNameForUser({ email: "personbr@gmail.com", displayName: "Personbr" }), "Personbr's workspace");
  assert.equal(workspaceNameForUser({ email: "x@yahoo.com", displayName: "  " }), "My workspace");

  const created = await upsertUser({
    email: `${randomUUID()}@acmecorp.example`,
    displayName: "Acme Person",
  });
  assert.equal((await getWorkspaceById(created.workspaceId))?.name, "Acmecorp");

  const consumer = await upsertUser({
    email: `${randomUUID()}@gmail.com`,
    displayName: "Personaz Example",
  });
  assert.equal((await getWorkspaceById(consumer.workspaceId))?.name, "Personaz's workspace");
});

// --- Active workspace switching ---

void test("switching the active workspace changes request resolution and survives suspension fallback", async () => {
  const { admin, workspaceId } = await makeWorkspaceWithMembers();
  const switcher = await makeUser("switcher");
  await ensureWorkspaceMembership({ workspaceId, userId: switcher.id, role: "member" });

  const home = { userId: switcher.id, email: switcher.email, displayName: switcher.displayName };
  assert.equal(await ensureDefaultWorkspaceForUser(home), switcher.workspaceId, "default is the first membership");

  // Not a member of a random workspace → switch rejected.
  const stranger = await makeUser("stranger");
  await assert.rejects(
    setActiveWorkspaceForUser({ userId: switcher.id, workspaceId: stranger.workspaceId }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "membership_not_found",
  );

  await setActiveWorkspaceForUser({ userId: switcher.id, workspaceId });
  assert.equal(await ensureDefaultWorkspaceForUser(home), workspaceId, "active selection wins");
  assert.ok((await listMyWorkspacesDetailed(switcher.id)).some((workspace) => workspace.id === workspaceId));

  // Suspension invalidates the selection: resolution falls back to the
  // oldest membership instead of a workspace the user can no longer access.
  await suspendWorkspaceMember({ workspaceId, actorUserId: admin.id, targetUserId: switcher.id });
  assert.equal(await ensureDefaultWorkspaceForUser(home), switcher.workspaceId);
  void admin;
});

void test("deleteWorkspaceForAdmin deletes the workspace and moves active users to replacements", async () => {
  const { admin, member, workspaceId } = await makeWorkspaceWithMembers();
  const replacementOwner = await makeUser("removal-replacement");
  await ensureWorkspaceMembership({ workspaceId: replacementOwner.workspaceId, userId: admin.id, role: "admin" });
  await setActiveWorkspaceForUser({ userId: member.id, workspaceId });
  const meeting = await createMeeting({
    title: "Workspace deletion meeting",
    roomName: `removed-workspace-${randomUUID()}`,
    createdByUserId: admin.id,
    workspaceId,
  });

  const result = await deleteWorkspaceForAdmin({ workspaceId, actorUserId: admin.id });

  assert.equal(result.workspace.id, workspaceId);
  assert.equal(result.activeWorkspaceId, replacementOwner.workspaceId);
  assert.equal(await getWorkspaceById(workspaceId), null);
  assert.equal(await activeWorkspaceIdOf(admin.id), replacementOwner.workspaceId);
  assert.equal(await activeWorkspaceIdOf(member.id), member.workspaceId);
  assert.equal(await getWorkspaceMembership({ workspaceId, userId: member.id }), null);
  const [savedMeeting] = await db.meetings.findMany({
    where: { id: meeting.id },
    select: { /** @external Prisma field */ id: true },
  });
  assert.equal(savedMeeting, undefined);
});

void test("deleteWorkspaceForAdmin creates a replacement when deleting the actor only workspace", async () => {
  const user = await makeUser("only-workspace");

  const result = await deleteWorkspaceForAdmin({
    workspaceId: user.workspaceId,
    actorUserId: user.id,
  });

  assert.equal(result.workspace.id, user.workspaceId);
  assert.notEqual(result.activeWorkspaceId, user.workspaceId);
  assert.equal(await getWorkspaceById(user.workspaceId), null);
  assert.notEqual(result.activeWorkspaceId, "");
  assert.equal(await activeWorkspaceIdOf(user.id), result.activeWorkspaceId);
  const membership = await getWorkspaceMembership({
    workspaceId: result.activeWorkspaceId,
    userId: user.id,
  });
  assert.ok(membership);
  assert.equal(membership.role, "owner");
  assert.equal(membership.status, "active");
});

void test("deleteWorkspaceForAdmin blocks workspaces with running subscriptions", async () => {
  const admin = await makeUser("subscribed-workspace");
  await upsertWorkspaceBillingSubscription({
    workspaceId: admin.workspaceId,
    userId: admin.id,
    stripeSubscriptionId: `sub_delete_${randomUUID()}`,
    stripePriceId: "price_delete_workspace",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: DELETE_WORKSPACE_INCLUDED_CREDITS,
    seatQuantity: DELETE_WORKSPACE_SEAT_QUANTITY,
    currentPeriodStart: new Date(Date.now() - PAST_TIMESTAMP_OFFSET_MS),
    currentPeriodEnd: futureDate(),
  });

  await assert.rejects(
    deleteWorkspaceForAdmin({ workspaceId: admin.workspaceId, actorUserId: admin.id }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "workspace_subscription_active",
  );
  assert.ok(await getWorkspaceById(admin.workspaceId));
  assert.ok(await getWorkspaceMembership({ workspaceId: admin.workspaceId, userId: admin.id }));
});

void test("workspace admins cannot remove a workspace owned by someone else", async () => {
  const { admin: owner, member, workspaceId } = await makeWorkspaceWithMembers();
  await updateWorkspaceMemberRole({
    workspaceId,
    actorUserId: owner.id,
    targetUserId: member.id,
    role: "admin",
  });

  await assert.rejects(
    deleteWorkspaceForAdmin({ workspaceId, actorUserId: member.id }),
    (error: unknown) => error instanceof WorkspaceAdminError && error.code === "workspace_owner_required",
  );
  assert.ok(await getWorkspaceById(workspaceId));
});

// --- Last seen ---

void test("touchUserLastSeen records authenticated activity", async () => {
  const user = await makeUser("lastseen");
  assert.equal(user.lastSeenAt ?? null, null);

  await touchUserLastSeen(user.id);
  const [row] = await db.users.findMany({
    where: { id: user.id },
    select: { /** @external Prisma field */ lastSeenAt: true },
  });
  assert.ok(row !== undefined && row.lastSeenAt !== null, MESSAGE_LAST_SEEN_SET_AFTER_ACTIVITY);
});
