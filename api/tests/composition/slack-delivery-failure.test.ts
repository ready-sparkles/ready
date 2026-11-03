import {
  appendTranscriptSegment,
  closeDbPool,
  createGuestUser,
  createMeeting,
  createMeetingLinkWithInitialMeeting,
  db,
  ensureDefaultAgentProfileForUser,
  ensureMeetingParticipantRecord,
  getSlackMeetingReview,
  reopenDismissedSlackMeetingReview,
  saveSlackMeetingReview,
  upsertAgentConnector,
  upsertSummaryForMeeting,
  upsertUser,
} from "@readymeet/db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { z } from "zod";

import { encryptJsonSecret } from "../../adapters/secondary/node/secret-crypto";
import { runSlackMeetingDelivery } from "../../adapters/secondary/slack/slack-delivery";
import {
  confirmSlackMeetingReview,
  prepareSlackMeetingReview,
  reviseSlackMeetingReview,
} from "../../adapters/secondary/slack/slack-review-service";
import { apiEnv } from "../../composition/env";

const CONNECTION_CLOSED_AFTER_SENDING_MESSAGE = "Connection closed after sending";
const UNEXPECTED_EXTERNAL_API_MESSAGE = "Unexpected external API";
const UNEXPECTED_EXTERNAL_API_SEPARATOR = ": ";

const REVIEW_RECIPIENT_COUNT = 2;
const CHANNEL_DELIVERY_POST_COUNT = 2;
const UNCERTAIN_SEND_POST_COUNT = 3;

const SALES_CLASSIFIER_CONFIDENCE = 0.99;
const NO_SENSITIVE_CONTENT_CONFIDENCE = 0.99;
const MOCK_INPUT_TOKENS = 1000;
const MOCK_OUTPUT_TOKENS = 20;

const slackConversationsOpenBodySchema = z.object({
  users: z.union([z.string(), z.number()]),
});

const slackChatPostMessageBodySchema = z.object({
  channel: z.string(),
});

function readFetchAddress(url: unknown): string {
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.href;
  }
  if (url instanceof Request) {
    return url.url;
  }

  return String(url);
}

function readRequestInitBody(init: RequestInit): string {
  if (typeof init.body === "string") {
    return init.body;
  }
  if (init.body === undefined || init.body === null) {
    return "";
  }

  return JSON.stringify(init.body);
}

function parseSlackConversationsOpenBody(init: RequestInit) {
  return slackConversationsOpenBodySchema.parse(JSON.parse(readRequestInitBody(init)));
}

function parseSlackChatPostMessageBody(init: RequestInit) {
  return slackChatPostMessageBodySchema.parse(JSON.parse(readRequestInitBody(init)));
}

function unexpectedExternalApiFailure(address: string): Error {
  return new Error(UNEXPECTED_EXTERNAL_API_MESSAGE + UNEXPECTED_EXTERNAL_API_SEPARATOR + address);
}

type SlackDeliveryFetchState = {
  /** The Slack user auth.test reports; scenarios that reconnect as another user replace it. */
  senderAuthedUserId: string;
  posts: number;
  isSalesMode: boolean;
  shouldFailPost: boolean;
  createdChannels: number;
  lastDestination: string;
  classifications: number;
  lockDuringChannelLookupMeetingId: string | null;
  verifyMeetingLockMeetingId: string | null;
  confidentialityUpdate: Promise<void> | undefined;
  confidentialityUpdateError: unknown;
};

type SlackDeliveryFetchContext = {
  hostEmail: string;
  userAccessToken: string;
  channels: { id: string; name: string }[];
  state: SlackDeliveryFetchState;
  confidentialityUpdateErrorSlot: { value: unknown };
};

type SlackFetchRuntime = {
  hostEmail: string;
  userAccessToken: string;
  state: SlackDeliveryFetchState;
  channels: { id: string; name: string }[];
  confidentialityUpdateErrorSlot: { value: unknown };
};

function buildSlackFetchRuntime(input: SlackDeliveryFetchContext): SlackFetchRuntime {
  return {
    hostEmail: input.hostEmail,
    userAccessToken: input.userAccessToken,
    state: input.state,
    channels: [...input.channels],
    confidentialityUpdateErrorSlot: input.confidentialityUpdateErrorSlot,
  };
}

async function beginCompetingConfidentialityUpdate(input: {
  meetingId: string;
  confidentialityUpdateErrorSlot: { value: unknown };
}) {
  const meetingId = input.meetingId;
  const confidentialityUpdateErrorSlot = input.confidentialityUpdateErrorSlot;
  try {
    await db.meetings.updateMany({ where: { id: meetingId }, data: { isConfidential: true } });
  } catch (error) {
    confidentialityUpdateErrorSlot.value = error;
  }
}

async function slackFetchAuthTest(input: { init: RequestInit | undefined; runtime: SlackFetchRuntime }) {
  assert.equal(new Headers(input.init?.headers).get("authorization"), `Bearer ${input.runtime.userAccessToken}`);

  return Response.json({
    /** @external slack api ok wire field */
    ok: true,
    user_id: input.runtime.state.senderAuthedUserId,
    team_id: "T1",
  });
}

function slackFetchGatewayClassifier(input: { state: SlackDeliveryFetchState }) {
  const state = input.state;

  const text = state.isSalesMode
    ? JSON.stringify({
        category: "sales",
        /** @external slack classifier internal one-on-one wire field */
        is_internal_one_on_one: false,
        /** @external slack classifier sensitive content wire field */
        contains_sensitive_content: false,
        sensitive_reason: null,
        /** @external slack classifier pure sales call wire field */
        pure_sales_call: true,
        sales_confidence: SALES_CLASSIFIER_CONFIDENCE,
        no_sensitive_content_confidence: NO_SENSITIVE_CONTENT_CONFIDENCE,
        salesperson_evidence: "I sell this product to teams.",
        customer_evidence: "I want to buy it for our company.",
      })
    : "";

  return Response.json({
    content: [{ type: "text", text }],
    usage: { inputTokens: { total: MOCK_INPUT_TOKENS }, outputTokens: { total: MOCK_OUTPUT_TOKENS } },
    finishReason: state.isSalesMode ? { unified: "stop", raw: "stop" } : { unified: "length", raw: "length" },
    warnings: [],
  });
}

async function slackFetchConversationsList(input: {
  state: SlackDeliveryFetchState;
  channels: { id: string; name: string }[];
  meetingIdToLock: string | null;
}) {
  if (input.meetingIdToLock !== null && input.meetingIdToLock.length > 0) {
    await db.meetings.updateMany({ where: { id: input.meetingIdToLock }, data: { isConfidential: true } });
  }

  return Response.json({
    /** @external slack api ok wire field */
    ok: true,
    channels: input.channels,
  });
}

function slackFetchConversationsCreate(input: { channels: { id: string; name: string }[] }) {
  return Response.json({
    /** @external slack api ok wire field */
    ok: true,
    channel: input.channels[0],
  });
}

function slackFetchUsersLookupByEmail(input: { address: string; runtime: SlackFetchRuntime }) {
  const email = new URL(input.address).searchParams.get("email");

  return Response.json({
    /** @external slack api ok wire field */
    ok: true,
    user: { id: email === input.runtime.hostEmail ? "U1" : "U2", profile: { email } },
  });
}

function slackFetchConversationsOpen(input: { init: RequestInit | undefined; runtime: SlackFetchRuntime }) {
  assert.equal(new Headers(input.init?.headers).get("authorization"), `Bearer ${input.runtime.userAccessToken}`);
  const body = parseSlackConversationsOpenBody(input.init ?? { body: "" });
  const usersKey = String(body.users);

  return Response.json({
    /** @external slack api ok wire field */
    ok: true,
    channel: { id: `D${usersKey}`, /** @external slack channel im wire field */ is_im: true },
  });
}

async function slackFetchChatPostMessage(input: { init?: RequestInit; runtime: SlackFetchRuntime }) {
  const { init, runtime } = input;
  assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${runtime.userAccessToken}`);
  const meetingIdForLock = runtime.state.verifyMeetingLockMeetingId;
  if (meetingIdForLock !== null && meetingIdForLock.length > 0) {
    runtime.state.confidentialityUpdate = beginCompetingConfidentialityUpdate({
      meetingId: meetingIdForLock,
      confidentialityUpdateErrorSlot: runtime.confidentialityUpdateErrorSlot,
    });
  }
  runtime.state.posts++;
  runtime.state.lastDestination = parseSlackChatPostMessageBody(init ?? { body: "" }).channel;
  if (runtime.state.shouldFailPost) {
    throw new Error(CONNECTION_CLOSED_AFTER_SENDING_MESSAGE);
  }

  return Response.json({
    /** @external slack api ok wire field */
    ok: true,
    ts: "123.456",
  });
}

async function dispatchSlackDeliveryFetch(input: { url: unknown; init?: RequestInit; runtime: SlackFetchRuntime }) {
  const { init, runtime } = input;
  const address = readFetchAddress(input.url);
  if (address.endsWith("auth.test")) {
    return slackFetchAuthTest({ init, runtime });
  }
  if (address.includes("conversations.info?")) {
    return Response.json({
      /** @external slack api ok wire field */
      ok: true,
      channel: {
        /** @external slack channel membership wire field */
        is_member: true,
        /** @external slack channel archived wire field */
        is_archived: false,
      },
    });
  }
  if (address === "https://ai-gateway.vercel.sh/v4/ai/language-model") {
    runtime.state.classifications++;

    return slackFetchGatewayClassifier({ state: runtime.state });
  }
  if (address.endsWith("conversations.list")) {
    const meetingIdToLock = runtime.state.lockDuringChannelLookupMeetingId;
    if (meetingIdToLock !== null && meetingIdToLock.length > 0) {
      runtime.state.lockDuringChannelLookupMeetingId = null;
    }

    return slackFetchConversationsList({
      state: runtime.state,
      channels: runtime.channels,
      meetingIdToLock,
    });
  }
  if (address.endsWith("conversations.create")) {
    runtime.state.createdChannels++;
    runtime.channels = [...runtime.channels, { id: "C1", name: "sales-meetings" }];

    return slackFetchConversationsCreate({ channels: runtime.channels });
  }
  if (address.endsWith("conversations.invite")) {
    return Response.json({
      /** @external slack api ok wire field */
      ok: true,
    });
  }
  if (address.includes("users.lookupByEmail")) {
    return slackFetchUsersLookupByEmail({ address, runtime });
  }
  if (address.endsWith("conversations.open")) {
    return slackFetchConversationsOpen({ init, runtime });
  }
  if (address.endsWith("chat.postMessage")) {
    return slackFetchChatPostMessage({ init, runtime });
  }
  throw unexpectedExternalApiFailure(address);
}

function installSlackDeliveryFetchMock(input: { t: TestContext; context: SlackDeliveryFetchContext }) {
  const runtime = buildSlackFetchRuntime(input.context);
  input.t.mock.method(globalThis, "fetch", (url: unknown, init?: RequestInit) =>
    dispatchSlackDeliveryFetch({ url, init, runtime }),
  );
}

async function runReviewConfirmationGuards(input: {
  meetingId: string;
  userId: string;
  otherUserId: string;
  otherUserEmail: string;
  reviewVersion: number;
  agentProfileId: string;
  senderTokens: {
    accessToken: string;
    teamId: string;
    teamName: string;
    scope: string;
    authedUserId: string;
    authedUserName: string;
    userAccessToken: string;
    userScope: string;
  };
  deliveryState: SlackDeliveryFetchState;
  job: { meetingId: string; logger: { info(): void; warn(): void } };
}) {
  const {
    meetingId,
    userId,
    otherUserId,
    otherUserEmail,
    reviewVersion,
    agentProfileId,
    senderTokens,
    deliveryState,
    job,
  } = input;
  await assert.rejects(confirmSlackMeetingReview(meetingId, userId, reviewVersion), /connection changed/);
  assert.equal(deliveryState.posts, 0, "switching Slack accounts must invalidate the prior confirmation");
  await upsertAgentConnector({
    userId,
    agentProfileId,
    provider: "slack",
    status: "connected",
    secretRef: encryptJsonSecret(senderTokens),
  });
  await assert.rejects(confirmSlackMeetingReview(meetingId, otherUserId, reviewVersion), /changed/);
  await assert.rejects(reviseSlackMeetingReview(meetingId, userId, reviewVersion, "Use #sales"), /DM-only/);
  await upsertSummaryForMeeting({ meetingId, content: "Updated private discussion.", model: "fixture" });
  await assert.rejects(confirmSlackMeetingReview(meetingId, userId, reviewVersion), /meeting changed/);
  const refreshed = await prepareSlackMeetingReview(meetingId, userId, true);
  assert.ok(refreshed);
  const excluded = await reviseSlackMeetingReview(meetingId, userId, refreshed.version, `Exclude ${otherUserEmail}`);
  const dismissed = await saveSlackMeetingReview({
    review: { ...excluded, status: "dismissed", version: excluded.version + 1 },
    expectedVersion: excluded.version,
  });
  assert.ok(dismissed);
  await runSlackMeetingDelivery(job);
  assert.equal(
    (await getSlackMeetingReview(meetingId))?.status,
    "dismissed",
    "background preparation must respect Not now",
  );
  assert.equal(
    await reopenDismissedSlackMeetingReview({
      meetingId,
      userId: otherUserId,
      expectedVersion: dismissed.version,
    }),
    null,
  );
  const reopened = await Promise.all([
    prepareSlackMeetingReview(meetingId, userId, false, true),
    prepareSlackMeetingReview(meetingId, userId, false, true),
  ]);
  const revised = reopened[0];
  assert.ok(revised);
  assert.equal(revised.status, "awaiting_user");
  assert.equal(revised.version, dismissed.version + 1);
  assert.equal(reopened[1]?.version, revised.version, "concurrent reopening must not increment twice");
  assert.equal(
    revised.recipients.find((r) => r.userId === otherUserId)?.included,
    false,
    "reopening preserves exclusions",
  );
  assert.equal(deliveryState.posts, 0, "reopening must never send");
  await runConcurrentConfirmationGuards({
    meetingId,
    userId,
    refreshedVersion: refreshed.version,
    revisedVersion: revised.version,
    deliveryState,
  });

  return { refreshed, revised, dismissed };
}

async function runConcurrentConfirmationGuards(input: {
  meetingId: string;
  userId: string;
  refreshedVersion: number;
  revisedVersion: number;
  deliveryState: SlackDeliveryFetchState;
}) {
  const { meetingId, userId, refreshedVersion, revisedVersion, deliveryState } = input;
  await assert.rejects(confirmSlackMeetingReview(meetingId, userId, refreshedVersion), /changed/);
  const attempts = await Promise.allSettled([
    confirmSlackMeetingReview(meetingId, userId, revisedVersion),
    confirmSlackMeetingReview(meetingId, userId, revisedVersion),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(deliveryState.posts, 1);
  assert.equal((await getSlackMeetingReview(meetingId))?.status, "completed");
  assert.equal((await prepareSlackMeetingReview(meetingId, userId, true, true))?.status, "completed");
  assert.equal(
    await reopenDismissedSlackMeetingReview({
      meetingId,
      userId,
      expectedVersion: revisedVersion + 1,
    }),
    null,
    "sent reviews cannot reopen",
  );
  await assert.rejects(confirmSlackMeetingReview(meetingId, userId, revisedVersion));
  assert.equal(deliveryState.posts, 1);
}

async function runSalesChannelDeliveryScenarios(input: {
  userId: string;
  otherUserId: string;
  workspaceId: string;
  deliveryState: SlackDeliveryFetchState;
  confidentialityUpdateErrorSlot: { value: unknown };
}) {
  const { userId, otherUserId, workspaceId, deliveryState, confidentialityUpdateErrorSlot } = input;
  deliveryState.isSalesMode = true;
  const sales = await createMeeting({
    title: "Customer demo",
    roomName: randomUUID(),
    createdByUserId: userId,
    workspaceId,
    isConfidential: false,
  });
  await db.meetings.updateMany({ where: { id: sales.id }, data: { status: "ended" } });
  await ensureMeetingParticipantRecord({ meetingId: sales.id, userId, role: "host" });
  await ensureMeetingParticipantRecord({ meetingId: sales.id, userId: otherUserId, role: "guest" });
  await appendTranscriptSegment({
    meetingId: sales.id,
    speakerIdentity: otherUserId,
    speakerName: "Personqs",
    speakerRole: "human",
    content: "I want to buy it for our company.",
    startedAt: new Date(),
  });
  await upsertSummaryForMeeting({ meetingId: sales.id, content: "Product demo and pricing.", model: "fixture" });
  await appendTranscriptSegment({
    meetingId: sales.id,
    speakerIdentity: userId,
    speakerName: "Personqo",
    speakerRole: "human",
    content: "I sell this product to teams.",
    startedAt: new Date(),
  });
  const salesReview = await prepareSlackMeetingReview(sales.id, userId);
  assert.ok(salesReview);
  assert.equal(salesReview.mode, "channel");
  assert.equal(salesReview.channel?.name, "sales-meetings");
  assert.equal(deliveryState.createdChannels, 1);
  assert.equal(deliveryState.posts, 1, "channel setup must not post notes");
  deliveryState.lockDuringChannelLookupMeetingId = sales.id;
  await assert.rejects(
    confirmSlackMeetingReview(sales.id, userId, salesReview.version),
    /confidential|meeting changed/,
  );
  assert.equal(deliveryState.posts, 1, "a confidentiality change during Slack lookup must prevent channel delivery");
  assert.equal((await getSlackMeetingReview(sales.id))?.status, "awaiting_user", "no delivery was claimed");
  await db.meetings.updateMany({ where: { id: sales.id }, data: { isConfidential: false } });
  deliveryState.verifyMeetingLockMeetingId = sales.id;
  assert.equal((await confirmSlackMeetingReview(sales.id, userId, salesReview.version)).status, "completed");
  const confidentialityUpdate = deliveryState.confidentialityUpdate;
  if (confidentialityUpdate !== undefined) {
    await confidentialityUpdate;
  }
  assert.equal(
    confidentialityUpdateErrorSlot.value,
    undefined,
    "delivery and the competing confidentiality change must both complete without cancellation",
  );
  deliveryState.verifyMeetingLockMeetingId = null;
  await db.meetings.updateMany({ where: { id: sales.id }, data: { isConfidential: true } });
  assert.equal(deliveryState.lastDestination, "C1");
  assert.equal(deliveryState.posts, CHANNEL_DELIVERY_POST_COUNT);
}

async function runPrivateMeetingFailureScenario(input: {
  userId: string;
  otherUserId: string;
  workspaceId: string;
  agentProfileId: string;
  senderTokens: {
    accessToken: string;
    teamId: string;
    teamName: string;
    scope: string;
    authedUserId: string;
    authedUserName: string;
    userAccessToken: string;
    userScope: string;
  };
  deliveryState: SlackDeliveryFetchState;
  job: { meetingId: string; logger: { info(): void; warn(): void } };
}) {
  const { userId, otherUserId, workspaceId, agentProfileId, senderTokens, deliveryState, job } = input;
  const privateMeeting = await createMeeting({
    title: "Private catch-up",
    roomName: randomUUID(),
    createdByUserId: userId,
    workspaceId,
    isConfidential: true,
  });
  await db.meetings.updateMany({ where: { id: privateMeeting.id }, data: { status: "ended" } });
  await ensureMeetingParticipantRecord({ meetingId: privateMeeting.id, userId, role: "host" });
  await ensureMeetingParticipantRecord({ meetingId: privateMeeting.id, userId: otherUserId, role: "guest" });
  await upsertSummaryForMeeting({ meetingId: privateMeeting.id, content: "Private notes", model: "fixture" });
  const privateSenderTokens = { ...senderTokens, authedUserId: "U1" };
  deliveryState.senderAuthedUserId = privateSenderTokens.authedUserId;
  await upsertAgentConnector({
    userId,
    agentProfileId,
    provider: "slack",
    status: "connected",
    secretRef: encryptJsonSecret(privateSenderTokens),
  });
  const privateReview = await prepareSlackMeetingReview(privateMeeting.id, userId);
  assert.ok(privateReview);
  assert.equal(privateReview.sender?.slackUserId, "U1");
  assert.deepEqual(
    privateReview.recipients.map((r) => r.slackUserId),
    ["U2"],
    "the sending user must not receive their own DM",
  );
  assert.equal(privateReview.mode, "dm", "confidential flag overrides classifier");
  deliveryState.shouldFailPost = true;
  const failed = await confirmSlackMeetingReview(privateMeeting.id, userId, privateReview.version);
  assert.equal(failed.status, "failed");
  assert.equal(deliveryState.posts, UNCERTAIN_SEND_POST_COUNT, "stop after the first uncertain send");
  await assert.rejects(confirmSlackMeetingReview(privateMeeting.id, userId, privateReview.version));
  await runSlackMeetingDelivery({ ...job, meetingId: privateMeeting.id });
  assert.equal(
    (await prepareSlackMeetingReview(privateMeeting.id, userId, true, true))?.status,
    "failed",
    "uncertain deliveries cannot reopen",
  );
  assert.equal(
    deliveryState.posts,
    UNCERTAIN_SEND_POST_COUNT,
    "background retry and repeated confirmation must not resend",
  );
}

async function seedSlackDeliveryFailureFixture(input: { t: TestContext }) {
  const user = await upsertUser({ email: `${randomUUID()}@slack.readymeet.test`, displayName: "Personqo" });
  const guest = await createGuestUser({ displayName: "Personrb" });
  const other = await upsertUser({ email: `${randomUUID()}@slack.readymeet.test`, displayName: "Personqs" });
  const { meeting, meetingLink } = await createMeetingLinkWithInitialMeeting({
    title: "Team check-in",
    code: randomUUID(),
    createdByUserId: user.id,
    workspaceId: user.workspaceId,
  });
  const originalKey = apiEnv.OPENAI_API_KEY;
  const originalGatewayKey = apiEnv.AI_GATEWAY_API_KEY;
  apiEnv.OPENAI_API_KEY = "fixture";
  apiEnv.AI_GATEWAY_API_KEY = "fixture-gateway";
  input.t.after(async () => {
    apiEnv.OPENAI_API_KEY = originalKey;
    apiEnv.AI_GATEWAY_API_KEY = originalGatewayKey;
    await db.meetings.deleteMany({ where: { createdByUserId: user.id } });
    await db.meetingLinks.deleteMany({ where: { id: meetingLink.id } });
    await db.workspaces.deleteMany({ where: { id: { in: [user.workspaceId, other.workspaceId] } } });
    await db.users.deleteMany({ where: { id: { in: [user.id, other.id, guest.id] } } });
  });
  await db.meetings.updateMany({
    where: { id: meeting.id },
    data: { status: "ended", isConfidential: false },
  });
  await ensureMeetingParticipantRecord({ meetingId: meeting.id, userId: user.id, role: "host" });
  await ensureMeetingParticipantRecord({ meetingId: meeting.id, userId: other.id, role: "guest" });
  await ensureMeetingParticipantRecord({ meetingId: meeting.id, userId: guest.id, role: "guest" });
  const profile = await ensureDefaultAgentProfileForUser({ userId: user.id, displayName: "Personqo" });
  const senderTokens = {
    accessToken: "fixture-token",
    teamId: "T1",
    teamName: "Test",
    scope: "users:read.email,im:write",
    authedUserId: "U0",
    authedUserName: "Sender",
    userAccessToken: "fixture-user-token",
    userScope: "chat:write,im:write,channels:read,groups:read",
  };
  await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "slack",
    status: "connected",
    secretRef: encryptJsonSecret(senderTokens),
  });
  await upsertSummaryForMeeting({ meetingId: meeting.id, content: "A private discussion.", model: "fixture" });
  await appendTranscriptSegment({
    meetingId: meeting.id,
    speakerIdentity: user.id,
    speakerName: "Personqo",
    speakerRole: "human",
    content: "Discussed a private personnel matter.",
    startedAt: new Date(),
  });
  await appendTranscriptSegment({
    meetingId: meeting.id,
    speakerIdentity: other.id,
    speakerName: "Personqs",
    speakerRole: "human",
    content: "Thanks for sharing that privately.",
    startedAt: new Date(),
  });
  const confidentialityUpdateErrorSlot: { value: unknown } = { value: undefined };
  const deliveryState: SlackDeliveryFetchState = {
    senderAuthedUserId: senderTokens.authedUserId,
    posts: 0,
    isSalesMode: false,
    shouldFailPost: false,
    createdChannels: 0,
    lastDestination: "",
    classifications: 0,
    lockDuringChannelLookupMeetingId: null,
    verifyMeetingLockMeetingId: null,
    confidentialityUpdate: undefined,
    confidentialityUpdateError: undefined,
  };
  const fetchContext: SlackDeliveryFetchContext = {
    hostEmail: user.email,
    userAccessToken: senderTokens.userAccessToken,
    channels: [],
    state: deliveryState,
    confidentialityUpdateErrorSlot,
  };
  installSlackDeliveryFetchMock({ t: input.t, context: fetchContext });

  return {
    user,
    guest,
    other,
    meeting,
    profile,
    senderTokens,
    deliveryState,
    confidentialityUpdateErrorSlot,
  };
}

after(closeDbPool);

void test("reviews never auto-send; stale, foreign, and concurrent confirmations are guarded", async (t) => {
  const { user, guest, other, meeting, profile, senderTokens, deliveryState, confidentialityUpdateErrorSlot } =
    await seedSlackDeliveryFailureFixture({ t });
  await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "slack",
    status: "connected",
    secretRef: encryptJsonSecret({ ...senderTokens, userAccessToken: undefined }),
  });
  await assert.rejects(prepareSlackMeetingReview(meeting.id, user.id), /Reconnect Slack/);
  assert.equal(deliveryState.posts, 0);
  await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "slack",
    status: "connected",
    secretRef: encryptJsonSecret(senderTokens),
  });
  const job = { meetingId: meeting.id, logger: { info() {}, warn() {} } };
  assert.equal((await runSlackMeetingDelivery(job))?.status, "awaiting_user");
  await runSlackMeetingDelivery(job);
  assert.equal(deliveryState.posts, 0);
  assert.equal(deliveryState.classifications, 1);
  const review = await getSlackMeetingReview(meeting.id);
  assert.ok(review);
  assert.equal(review.mode, "dm");
  assert.equal(review.channelEligible, false);
  assert.equal(review.recipients.length, REVIEW_RECIPIENT_COUNT);
  assert.ok(review.unmatchedNames.includes("Personrb"));
  const guestMemberships = await db.workspaceMemberships.findMany({
    where: { userId: guest.id },
  });
  assert.equal(guestMemberships.length, 0);
  await upsertAgentConnector({
    userId: user.id,
    agentProfileId: profile.id,
    provider: "slack",
    status: "connected",
    secretRef: encryptJsonSecret({ ...senderTokens, authedUserId: "U_DIFFERENT" }),
  });
  await runReviewConfirmationGuards({
    meetingId: meeting.id,
    userId: user.id,
    otherUserId: other.id,
    otherUserEmail: other.email,
    reviewVersion: review.version,
    agentProfileId: profile.id,
    senderTokens,
    deliveryState,
    job,
  });
  await runSalesChannelDeliveryScenarios({
    userId: user.id,
    otherUserId: other.id,
    workspaceId: user.workspaceId,
    deliveryState,
    confidentialityUpdateErrorSlot,
  });
  await runPrivateMeetingFailureScenario({
    userId: user.id,
    otherUserId: other.id,
    workspaceId: user.workspaceId,
    agentProfileId: profile.id,
    senderTokens,
    deliveryState,
    job,
  });
});
