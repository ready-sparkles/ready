import {
  closeDbPool,
  createMeeting,
  db,
  ensureDefaultWorkspaceForUser,
  ensureWorkspaceMembership,
  getWorkspaceMemberCreditAccess,
  upsertUser,
  upsertWorkspaceBillingSubscription,
} from "@readymeet/db";
import Fastify from "fastify";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { internalMeetingAgentRoutes } from "../../../../../adapters/primary/http/routes/internal-meeting-agent";
import { apiEnv } from "../../../../../composition/env";

const HTTP_STATUS_OK = 200;
const INCLUDED_CREDITS_PER_PERIOD = 100;
const MEETING_ASK_CREDITS = 0;
const PERIOD_START_OFFSET_MS = 60_000;
// Twenty days, so the billing window is open for the whole test run.
const PERIOD_LENGTH_MS = 1_728_000_000;
const isIsolatedDb = process.env.READYMEET_ISOLATED_DB === "1" || process.env.CI === "true";

after(closeDbPool);

async function subscribedMember(label: string): Promise<{ userId: string; workspaceId: string }> {
  const suffix = randomUUID();
  const user = await upsertUser({ email: `${label}-${suffix}@meeting-ask.test`, displayName: label, source: "auth" });
  const workspaceId = await ensureDefaultWorkspaceForUser({
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
  });
  const now = Date.now();
  await upsertWorkspaceBillingSubscription({
    workspaceId,
    userId: user.id,
    stripeSubscriptionId: `sub_${suffix}`,
    stripePriceId: "price_meeting_ask_test",
    status: "active",
    planInterval: "month",
    includedCreditsPerPeriod: INCLUDED_CREDITS_PER_PERIOD,
    seatQuantity: 1,
    currentPeriodStart: new Date(now - PERIOD_START_OFFSET_MS),
    currentPeriodEnd: new Date(now + PERIOD_LENGTH_MS),
  });

  return { userId: user.id, workspaceId };
}

async function askAssistant(input: { userId: string; meetingId: string }): Promise<number> {
  const app = Fastify();
  try {
    await app.register(internalMeetingAgentRoutes);
    const response = await app.inject({
      method: "POST",
      url: "/internal/meeting-agent",
      headers: { "x-assistant-service-secret": apiEnv.ASSISTANT_SERVICE_SECRET },
      payload: {
        action: "recordCreditUsage",
        userId: input.userId,
        meetingId: input.meetingId,
        meetingTurnId: randomUUID(),
        actionLabel: "Agent push-to-talk",
        trigger: "push_to_talk",
        provider: "openai",
        participantIdentity: `${input.userId}:browser`,
        assistantDisplayName: "Ready",
      },
    });

    return response.statusCode;
  } finally {
    await app.close();
  }
}

async function chargedWorkspaceIds(userId: string): Promise<(string | null)[]> {
  const rows = await db.aiCreditUsageEvents.findMany({ where: { userId }, select: { workspaceId: true } });

  return rows.map((row) => row.workspaceId);
}

void test(
  "legacy meeting-ask reporting records workspace usage without debiting the allowance",
  { skip: !isIsolatedDb },
  async () => {
    const member = await subscribedMember("member");
    const meeting = await createMeeting({
      title: "Weekly sync",
      roomName: `room-${randomUUID()}`,
      createdByUserId: member.userId,
      workspaceId: member.workspaceId,
    });

    assert.equal(await askAssistant({ userId: member.userId, meetingId: meeting.id }), HTTP_STATUS_OK);

    assert.deepEqual(await chargedWorkspaceIds(member.userId), [member.workspaceId]);
    const access = await getWorkspaceMemberCreditAccess(member);
    assert.equal(access.allowanceUsed, MEETING_ASK_CREDITS);
  },
);

void test(
  "legacy meeting-ask reporting uses the workspace the attendee filed the meeting under",
  { skip: !isIsolatedDb },
  async () => {
    const attendee = await subscribedMember("attendee");
    const host = await subscribedMember("host");
    const meeting = await createMeeting({
      title: "Partner call",
      roomName: `room-${randomUUID()}`,
      createdByUserId: host.userId,
      workspaceId: host.workspaceId,
    });
    await ensureWorkspaceMembership({ workspaceId: host.workspaceId, userId: attendee.userId, role: "member" });
    await db.meetingAttendeeWorkspaces.create({
      data: {
        meetingId: meeting.id,
        userId: attendee.userId,
        workspaceId: host.workspaceId,
        assignment: "host_workspace",
      },
    });

    assert.equal(await askAssistant({ userId: attendee.userId, meetingId: meeting.id }), HTTP_STATUS_OK);

    assert.deepEqual(await chargedWorkspaceIds(attendee.userId), [host.workspaceId]);
  },
);
