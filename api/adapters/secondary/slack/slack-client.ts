import type { SlackChannel } from "@readymeet/shared";
import { z } from "zod";

import { apiEnv } from "../../../ports/api-env";

const SLACK_API_URL = "https://slack.com/api";
const SLACK_OAUTH_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_ERROR_SNIPPET_LENGTH = 160;
const MILLISECONDS_PER_SECOND = 1000;
const SLACK_REQUEST_TIMEOUT_SECONDS = 15;
const SLACK_REQUEST_TIMEOUT_MS = SLACK_REQUEST_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND;
const SLACK_CONVERSATIONS_LIST_PAGE_LIMIT = 200;
const SLACK_CHANNEL_PAGE_LIMIT = 5;
const SLACK_USERS_READ_EMAIL_SCOPE = "users:read.email";
const SLACK_OAUTH_USER_TOKEN_TYPE = "user";
const SLACK_ERROR_USERS_NOT_FOUND = "users_not_found";
const EMPTY_JSON_OBJECT = "{}";

const MESSAGE_SLACK_RECONNECT_TO_SEND = "Reconnect Slack in Settings to send messages as yourself.";
const MESSAGE_SLACK_OAUTH_NOT_CONFIGURED = "Slack OAuth is not configured";
const MESSAGE_SLACK_USER_ACCOUNT_NOT_AUTHORIZED = "Slack did not authorize a user account. Reconnect Slack.";
const MESSAGE_SLACK_ACCOUNT_CHANGED = "Your Slack account changed. Reconnect Slack before sending.";
const MESSAGE_SLACK_JOIN_CHANNEL_BEFORE_SEND =
  "Join the selected Slack channel with your connected account before sending.";
const MESSAGE_SLACK_CHANNEL_LIST_INCOMPLETE =
  "Slack channel list is incomplete. Narrow workspace access before choosing a destination.";
const MESSAGE_SLACK_CONVERSATIONS_CREATE_EMPTY = "Slack conversations.create returned no channel";
const MESSAGE_SLACK_DM_NOT_RETURNED = "Slack did not return a personal DM.";
const MESSAGE_SLACK_EMAIL_LOOKUP_FAILED_SUFFIX = ". Reconnect Slack if permissions have changed.";
const MESSAGE_SLACK_METHOD_FAILED_PREFIX = "Slack ";
const MESSAGE_SLACK_METHOD_FAILED_MIDDLE = " failed: ";
const MESSAGE_SLACK_INVALID_JSON_MIDDLE = " failed: invalid JSON response (";
const MESSAGE_SLACK_INVALID_JSON_SUFFIX = ")";
const MESSAGE_SLACK_TOKEN_EXCHANGE_FAILED_PREFIX = "Slack token exchange failed: ";
const MESSAGE_SLACK_MISSING_ACCESS_TOKEN = "missing access_token";
const MESSAGE_SLACK_EMAIL_LOOKUP_FAILED_PREFIX = "Slack email lookup failed: ";

function formatSlackTokenExchangeFailedMessage(detail: string | number): string {
  return `${MESSAGE_SLACK_TOKEN_EXCHANGE_FAILED_PREFIX}${detail}`;
}

function formatSlackEmailLookupFailedMessage(detail: string | number): string {
  return `${MESSAGE_SLACK_EMAIL_LOOKUP_FAILED_PREFIX}${detail}${MESSAGE_SLACK_EMAIL_LOOKUP_FAILED_SUFFIX}`;
}

/** Bot setup token and optional authorized sender token, encrypted at rest. */
export type SlackTokenSet = {
  accessToken: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  authedUserId: string;
  scope: string;
  userAccessToken?: string;
  userScope?: string;
  authedUserName?: string;
};

type SlackOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

// chat:write.public lets the bot post to public channels without joining;
// channels:manage/groups:write cover creating channels from the settings
// modal; the read scopes power the channel picker.
const SLACK_BOT_SCOPES = [
  "channels:read",
  "groups:read",
  "chat:write",
  "chat:write.public",
  "channels:manage",
  "groups:write",
  // Slack requires users:read alongside users:read.email during OAuth.
  "users:read",
  "users:read.email",
  "im:write",
].join(",");

const SLACK_USER_SCOPES = ["chat:write", "im:write", "channels:read", "groups:read"];

const slackApiBaseSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
  })
  .passthrough();

const slackOAuthAccessSchema = slackApiBaseSchema.extend({
  access_token: z.string().optional(),
  scope: z.string().optional(),
  bot_user_id: z.string().optional(),
  team: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  authed_user: z
    .object({
      id: z.string().optional(),
      access_token: z.string().optional(),
      scope: z.string().optional(),
      token_type: z.string().optional(),
    })
    .optional(),
});

const slackAuthTestResponseSchema = slackApiBaseSchema.extend({
  user_id: z.string().optional(),
  team_id: z.string().optional(),
});

const slackConversationInfoResponseSchema = slackApiBaseSchema.extend({
  channel: z
    .object({
      /** @external slack conversations.info is_member */
      is_member: z.boolean().optional(),
      /** @external slack conversations.info is_archived */
      is_archived: z.boolean().optional(),
    })
    .optional(),
});

const slackConversationSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  /** @external slack conversation is_private */
  is_private: z.boolean().optional(),
  /** @external slack conversation is_archived */
  is_archived: z.boolean().optional(),
});

const slackConversationsListResponseSchema = slackApiBaseSchema.extend({
  channels: z.array(slackConversationSchema).optional(),
  response_metadata: z
    .object({
      next_cursor: z.string().optional(),
    })
    .optional(),
});

const slackConversationsCreateResponseSchema = slackApiBaseSchema.extend({
  channel: slackConversationSchema.optional(),
});

const slackChatPostMessageResponseSchema = slackApiBaseSchema.extend({
  ts: z.string().optional(),
});

const slackUsersLookupByEmailResponseSchema = slackApiBaseSchema.extend({
  user: z
    .object({
      id: z.string().optional(),
      /** @external slack users.lookupByEmail deleted */
      deleted: z.boolean().optional(),
      /** @external slack users.lookupByEmail is_bot */
      is_bot: z.boolean().optional(),
      profile: z
        .object({
          email: z.string().optional(),
          real_name: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

const slackConversationsOpenResponseSchema = slackApiBaseSchema.extend({
  channel: z
    .object({
      id: z.string().optional(),
      /** @external slack conversations.open is_im */
      is_im: z.boolean().optional(),
    })
    .optional(),
});

const slackUsersInfoResponseSchema = slackApiBaseSchema.extend({
  user: z
    .object({
      real_name: z.string().optional(),
      name: z.string().optional(),
      profile: z
        .object({
          display_name: z.string().optional(),
          real_name: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

function formatSlackMethodFailedMessage(input: { method: string; detail: string }): string {
  return `${MESSAGE_SLACK_METHOD_FAILED_PREFIX}${input.method}${MESSAGE_SLACK_METHOD_FAILED_MIDDLE}${input.detail}`;
}

function formatSlackInvalidJsonMessage(input: { method: string; status: number; snippet: string }): string {
  const snippetSuffix = input.snippet.length > 0 ? ` ${input.snippet}` : "";

  return `${MESSAGE_SLACK_METHOD_FAILED_PREFIX}${input.method}${MESSAGE_SLACK_INVALID_JSON_MIDDLE}${input.status}${MESSAGE_SLACK_INVALID_JSON_SUFFIX}${snippetSuffix}`;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function parseSlackJsonBody<T>(input: { method: string; status: number; body: string; schema: z.ZodType<T> }): T {
  const rawBody = input.body.length > 0 ? input.body : EMPTY_JSON_OBJECT;
  try {
    const jsonPayload: unknown = JSON.parse(rawBody);
    const parsed = input.schema.safeParse(jsonPayload);
    if (!parsed.success) {
      const snippet = input.body.trim().slice(0, SLACK_ERROR_SNIPPET_LENGTH);
      throw new Error(formatSlackInvalidJsonMessage({ method: input.method, status: input.status, snippet }));
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      const snippet = input.body.trim().slice(0, SLACK_ERROR_SNIPPET_LENGTH);
      throw new Error(formatSlackInvalidJsonMessage({ method: input.method, status: input.status, snippet }));
    }
    throw error;
  }
}

async function slackApi<T>(input: {
  token: string;
  method: string;
  params?: Record<string, unknown>;
  schema: z.ZodType<T>;
}): Promise<T> {
  const params = input.params ?? {};
  const isReadMethod = input.method === "users.info" || input.method === "conversations.info";
  const url = new URL(`${SLACK_API_URL}/${input.method}`);
  if (isReadMethod) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
  }
  const response = await fetch(url, {
    method: isReadMethod ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    ...(isReadMethod ? {} : { body: JSON.stringify(params) }),
    signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
  });
  const payload = parseSlackJsonBody({
    method: input.method,
    status: response.status,
    body: await response.text(),
    schema: input.schema,
  });
  const slackPayload = slackApiBaseSchema.safeParse(payload);
  const isSlackOk = slackPayload.success ? slackPayload.data.ok : false;
  const slackError = slackPayload.success ? slackPayload.data.error : undefined;
  if (!response.ok || !isSlackOk) {
    throw new Error(
      formatSlackMethodFailedMessage({ method: input.method, detail: slackError ?? String(response.status) }),
    );
  }

  return payload;
}

function hasRequiredUserScopes(userScope: string | undefined): boolean {
  const scopes = new Set((userScope ?? "").split(","));

  return SLACK_USER_SCOPES.every((scope) => scopes.has(scope));
}

function hasUsersReadEmailBotScope(scope: string): boolean {
  return scope.split(",").includes(SLACK_USERS_READ_EMAIL_SCOPE);
}

export function slackRequiresReconnect(tokens: SlackTokenSet): boolean {
  const userAccessToken = tokens.userAccessToken;
  const authedUserId = tokens.authedUserId;

  return (
    userAccessToken === undefined ||
    userAccessToken === "" ||
    authedUserId === "" ||
    !hasRequiredUserScopes(tokens.userScope) ||
    !hasUsersReadEmailBotScope(tokens.scope)
  );
}

export function requireSlackUserToken(tokens: SlackTokenSet): string {
  const token = tokens.userAccessToken;
  if (slackRequiresReconnect(tokens) || token === undefined || token === "") {
    throw new Error(MESSAGE_SLACK_RECONNECT_TO_SEND);
  }

  return token;
}

function requireSlackConfig(): SlackOAuthConfig {
  const clientId = readNonEmptyString(apiEnv().SLACK_CLIENT_ID);
  const clientSecret = readNonEmptyString(apiEnv().SLACK_CLIENT_SECRET);
  const redirectUri = readNonEmptyString(apiEnv().SLACK_REDIRECT_URI);
  if (clientId === null || clientSecret === null || redirectUri === null) {
    throw new Error(MESSAGE_SLACK_OAUTH_NOT_CONFIGURED);
  }

  return { clientId, clientSecret, redirectUri };
}

export function buildSlackAuthorizationUrl(input: { state: string }): string {
  const config = requireSlackConfig();
  const url = new URL(SLACK_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", SLACK_BOT_SCOPES);
  url.searchParams.set("user_scope", SLACK_USER_SCOPES.join(","));
  url.searchParams.set("state", input.state);

  return url.toString();
}

function resolveAuthedUserDisplayName(input: {
  profile: z.infer<typeof slackUsersInfoResponseSchema>;
  fallbackUserId: string;
}): string {
  const user = input.profile.user;
  const displayName = readNonEmptyString(user?.profile?.display_name);
  if (displayName !== null) {
    return displayName;
  }
  const profileRealName = readNonEmptyString(user?.profile?.real_name);
  if (profileRealName !== null) {
    return profileRealName;
  }
  const realName = readNonEmptyString(user?.real_name);
  if (realName !== null) {
    return realName;
  }
  const name = readNonEmptyString(user?.name);
  if (name !== null) {
    return name;
  }

  return input.fallbackUserId;
}

async function fetchAuthedUserDisplayName(tokens: SlackTokenSet): Promise<string> {
  const profile = await slackApi({
    token: tokens.accessToken,
    method: "users.info",
    params: { user: tokens.authedUserId },
    schema: slackUsersInfoResponseSchema,
  });

  return resolveAuthedUserDisplayName({ profile, fallbackUserId: tokens.authedUserId });
}

function buildSlackTokenSetFromOAuth(payload: z.infer<typeof slackOAuthAccessSchema>): SlackTokenSet {
  const accessToken = readNonEmptyString(payload.access_token);
  if (accessToken === null) {
    throw new Error(formatSlackTokenExchangeFailedMessage(payload.error ?? MESSAGE_SLACK_MISSING_ACCESS_TOKEN));
  }

  return {
    accessToken,
    teamId: payload.team?.id ?? "",
    teamName: payload.team?.name ?? "",
    botUserId: payload.bot_user_id ?? "",
    authedUserId: payload.authed_user?.id ?? "",
    scope: payload.scope ?? "",
    userAccessToken: payload.authed_user?.access_token,
    userScope: payload.authed_user?.scope,
  };
}

function assertSlackUserOAuthGranted(payload: z.infer<typeof slackOAuthAccessSchema>): void {
  if (payload.authed_user?.token_type !== SLACK_OAUTH_USER_TOKEN_TYPE) {
    throw new Error(MESSAGE_SLACK_USER_ACCOUNT_NOT_AUTHORIZED);
  }
}

async function fetchSlackOAuthAccessPayload(code: string): Promise<z.infer<typeof slackOAuthAccessSchema>> {
  const config = requireSlackConfig();
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  const response = await fetch(`${SLACK_API_URL}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = parseSlackJsonBody({
    method: "oauth.v2.access",
    status: response.status,
    body: await response.text(),
    schema: slackOAuthAccessSchema,
  });
  const accessToken = readNonEmptyString(payload.access_token);
  if (!response.ok || !payload.ok || accessToken === null) {
    throw new Error(formatSlackTokenExchangeFailedMessage(payload.error ?? response.status));
  }

  return payload;
}

export async function exchangeSlackCode(code: string): Promise<SlackTokenSet> {
  const payload = await fetchSlackOAuthAccessPayload(code);
  assertSlackUserOAuthGranted(payload);
  const tokens = buildSlackTokenSetFromOAuth(payload);
  await verifySlackSender(tokens);
  const authedUserName = await fetchAuthedUserDisplayName(tokens);

  return { ...tokens, authedUserName };
}

export async function verifySlackSender(tokens: SlackTokenSet): Promise<void> {
  const identity = await slackApi({
    token: requireSlackUserToken(tokens),
    method: "auth.test",
    schema: slackAuthTestResponseSchema,
  });
  if (identity.user_id !== tokens.authedUserId || identity.team_id !== tokens.teamId) {
    throw new Error(MESSAGE_SLACK_ACCOUNT_CHANGED);
  }
}

async function verifySlackSenderChannelNamed(input: { tokens: SlackTokenSet; channelId: string }): Promise<void> {
  const result = await slackApi({
    token: requireSlackUserToken(input.tokens),
    method: "conversations.info",
    params: { channel: input.channelId },
    schema: slackConversationInfoResponseSchema,
  });
  const channel = result.channel;
  if (channel === undefined || channel.is_member !== true || channel.is_archived === true) {
    throw new Error(MESSAGE_SLACK_JOIN_CHANNEL_BEFORE_SEND);
  }
}

export async function verifySlackSenderChannel(...args: [tokens: SlackTokenSet, channelId: string]): Promise<void> {
  return verifySlackSenderChannelNamed({ tokens: args[0], channelId: args[1] });
}

function toChannel(conversation: z.infer<typeof slackConversationSchema>): SlackChannel | null {
  const id = readNonEmptyString(conversation.id);
  const name = readNonEmptyString(conversation.name);
  if (id === null || name === null) {
    return null;
  }

  return {
    id,
    name,
    isPrivate: conversation.is_private === true,
  };
}

type SlackChannelPage = {
  channels: SlackChannel[];
  cursor: string | undefined;
  isComplete: boolean;
};

export async function listSlackChannels(token: string): Promise<SlackChannel[]> {
  const initialPage: Promise<SlackChannelPage> = Promise.resolve({
    channels: [],
    cursor: undefined,
    isComplete: false,
  });
  // Cap pagination: pathological workspaces should not hang the settings modal.
  const listed = await Array.from({ length: SLACK_CHANNEL_PAGE_LIMIT }, (_, page) => page).reduce(
    async (previous, page) => {
      const state = await previous;
      if (state.isComplete || page < 0) {
        return state;
      }
      const payload = await slackApi({
        token,
        method: "conversations.list",
        params: {
          types: "public_channel,private_channel",
          /** @external slack conversations.list exclude_archived */
          exclude_archived: true,
          limit: SLACK_CONVERSATIONS_LIST_PAGE_LIMIT,
          ...(state.cursor !== undefined && state.cursor !== "" ? { cursor: state.cursor } : {}),
        },
        schema: slackConversationsListResponseSchema,
      });
      const channels = (payload.channels ?? []).flatMap((conversation) => {
        const channel = toChannel(conversation);

        return channel !== null ? [channel] : [];
      });
      const nextCursor = payload.response_metadata?.next_cursor;
      const normalizedCursor = readNonEmptyString(nextCursor) ?? undefined;

      return {
        channels: state.channels.concat(channels),
        cursor: normalizedCursor,
        isComplete: normalizedCursor === undefined,
      };
    },
    initialPage,
  );

  if (listed.cursor !== undefined && listed.cursor !== "") {
    throw new Error(MESSAGE_SLACK_CHANNEL_LIST_INCOMPLETE);
  }

  return [...listed.channels].sort((a, b) => a.name.localeCompare(b.name));
}

async function createSlackChannelNamed(input: { token: string; name: string }): Promise<SlackChannel> {
  const payload = await slackApi({
    token: input.token,
    method: "conversations.create",
    params: {
      name: input.name,
      /** @external slack conversations.create is_private */
      is_private: false,
    },
    schema: slackConversationsCreateResponseSchema,
  });
  const channel = payload.channel !== undefined ? toChannel(payload.channel) : null;
  if (channel === null) {
    throw new Error(MESSAGE_SLACK_CONVERSATIONS_CREATE_EMPTY);
  }

  return channel;
}

export async function createSlackChannel(...args: [token: string, name: string]): Promise<SlackChannel> {
  return createSlackChannelNamed({ token: args[0], name: args[1] });
}

async function inviteSlackUserToChannelNamed(input: {
  token: string;
  channelId: string;
  userId: string;
}): Promise<void> {
  if (input.userId.trim().length === 0) {
    return;
  }
  await slackApi({
    token: input.token,
    method: "conversations.invite",
    params: {
      channel: input.channelId,
      users: input.userId,
    },
    schema: slackApiBaseSchema,
  });
}

export async function inviteSlackUserToChannel(
  ...args: [token: string, channelId: string, userId: string]
): Promise<void> {
  return inviteSlackUserToChannelNamed({ token: args[0], channelId: args[1], userId: args[2] });
}

export async function revokeSlackToken(token: string): Promise<void> {
  await slackApi({
    token,
    method: "auth.revoke",
    params: { /** @external slack auth.revoke test */ test: false },
    schema: slackApiBaseSchema,
  });
}

export async function postSlackMessage(input: {
  token: string;
  channelId: string;
  text: string;
  blocks: unknown[];
  clientMsgId?: string;
}): Promise<{ messageTs: string | null }> {
  const clientMsgId = input.clientMsgId;
  const payload = await slackApi({
    token: input.token,
    method: "chat.postMessage",
    params: {
      channel: input.channelId,
      text: input.text,
      blocks: input.blocks,
      ...(clientMsgId !== undefined && clientMsgId !== ""
        ? { /** @external slack chat.postMessage client_msg_id */ client_msg_id: clientMsgId }
        : {}),
      /** @external slack chat.postMessage unfurl_links */
      unfurl_links: false,
      /** @external slack chat.postMessage unfurl_media */
      unfurl_media: false,
    },
    schema: slackChatPostMessageResponseSchema,
  });

  return { messageTs: payload.ts ?? null };
}

function isSlackEmailLookupUserMatch(input: {
  user: z.infer<typeof slackUsersLookupByEmailResponseSchema>["user"];
  normalizedEmail: string;
}): boolean {
  const userId = readNonEmptyString(input.user?.id);
  const profileEmail = input.user?.profile?.email?.trim().toLowerCase();

  return (
    userId !== null &&
    input.user?.deleted !== true &&
    input.user?.is_bot !== true &&
    profileEmail === input.normalizedEmail
  );
}

function slackEmailLookupUserResult(input: {
  user: z.infer<typeof slackUsersLookupByEmailResponseSchema>["user"];
  normalizedEmail: string;
  fallbackEmail: string;
}): { id: string; name: string } | null {
  if (!isSlackEmailLookupUserMatch({ user: input.user, normalizedEmail: input.normalizedEmail })) {
    return null;
  }
  const userId = readNonEmptyString(input.user?.id);
  if (userId === null) {
    return null;
  }
  const displayName = readNonEmptyString(input.user?.profile?.real_name);

  return { id: userId, name: displayName ?? input.fallbackEmail };
}

async function lookupSlackUserByEmailNamed(input: {
  token: string;
  email: string;
}): Promise<{ id: string; name: string } | null> {
  // This read method accepts query parameters, not a JSON POST body.
  const url = new URL(`${SLACK_API_URL}/users.lookupByEmail`);
  url.searchParams.set("email", input.email);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${input.token}` },
    signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
  });
  const payload = parseSlackJsonBody({
    method: "users.lookupByEmail",
    status: response.status,
    body: await response.text(),
    schema: slackUsersLookupByEmailResponseSchema,
  });
  if (response.ok && payload.error === SLACK_ERROR_USERS_NOT_FOUND) {
    return null;
  }
  if (!response.ok || !payload.ok) {
    throw new Error(formatSlackEmailLookupFailedMessage(payload.error ?? response.status));
  }

  return slackEmailLookupUserResult({
    user: payload.user,
    normalizedEmail: input.email.trim().toLowerCase(),
    fallbackEmail: input.email,
  });
}

export async function lookupSlackUserByEmail(
  ...args: [token: string, email: string]
): Promise<{ id: string; name: string } | null> {
  return lookupSlackUserByEmailNamed({ token: args[0], email: args[1] });
}

async function openSlackDirectMessageNamed(input: { token: string; userId: string }): Promise<string> {
  const payload = await slackApi({
    token: input.token,
    method: "conversations.open",
    params: {
      users: input.userId,
      /** @external slack conversations.open return_im */
      return_im: true,
    },
    schema: slackConversationsOpenResponseSchema,
  });
  const channelId = readNonEmptyString(payload.channel?.id);
  const isIm = payload.channel?.is_im === true;
  if (channelId === null || !isIm) {
    throw new Error(MESSAGE_SLACK_DM_NOT_RETURNED);
  }

  return channelId;
}

export async function openSlackDirectMessage(...args: [token: string, userId: string]): Promise<string> {
  return openSlackDirectMessageNamed({ token: args[0], userId: args[1] });
}
