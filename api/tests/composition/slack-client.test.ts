import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  buildSlackAuthorizationUrl,
  listSlackChannels,
  postSlackMessage,
} from "../../adapters/secondary/slack/slack-client";
import { apiEnv } from "../../composition/env";

const originalFetch = globalThis.fetch;

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_GATEWAY = 502;

const SLACK_POST_MESSAGE_FIXTURE_TEXT = "Meeting notes";
const SLACK_ERROR_USERS_NOT_FOUND = "users_not_found";

const slackChatPostMessageBodySchema = z.object({
  client_msg_id: z.string(),
});

function readRequestInitBody(params: { init?: RequestInit }) {
  const body = params.init?.body;
  if (typeof body === "string") {
    return body;
  }
  if (body === undefined || body === null) {
    return "";
  }

  return JSON.stringify(body);
}

function parseSlackChatPostMessageBody(params: { init?: RequestInit }) {
  return slackChatPostMessageBodySchema.parse(JSON.parse(readRequestInitBody(params)));
}

function readFetchAddress(params: { url: string | URL | Request }) {
  const { url } = params;
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.href;
  }

  return url.url;
}

void test("Slack OAuth requests the prerequisite for reading participant emails", (t) => {
  const original = {
    SLACK_CLIENT_ID: apiEnv.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: apiEnv.SLACK_CLIENT_SECRET,
    SLACK_REDIRECT_URI: apiEnv.SLACK_REDIRECT_URI,
  };
  Object.assign(apiEnv, {
    SLACK_CLIENT_ID: "test-client",
    SLACK_CLIENT_SECRET: "test-secret",
    SLACK_REDIRECT_URI: "https://example.com/slack/callback",
  });
  t.after(() => Object.assign(apiEnv, original));
  const url = new URL(buildSlackAuthorizationUrl({ state: "test-state" }));
  const scopes = new Set(url.searchParams.get("scope")?.split(","));
  assert.ok(scopes.has("users:read.email"));
  assert.ok(scopes.has("users:read"), "Slack rejects email access without the accompanying users:read scope");
  assert.ok(scopes.has("im:write"));
  assert.equal(url.searchParams.get("state"), "test-state");
});

void test("postSlackMessage forwards a deterministic Slack client message id", async () => {
  const captured: { clientMsgId?: string } = {};
  globalThis.fetch = async (_input, init) => {
    const parsed = parseSlackChatPostMessageBody({ init });
    captured.clientMsgId = parsed.client_msg_id;

    return new Response(
      JSON.stringify({
        /** @external slack api ok wire field */
        ok: true,
        ts: "123.456",
      }),
      {
        status: HTTP_STATUS_OK,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const result = await postSlackMessage({
      token: "xoxb-test",
      channelId: "C123",
      text: SLACK_POST_MESSAGE_FIXTURE_TEXT,
      blocks: [],
      clientMsgId: "11111111-1111-4111-8111-111111111111",
    });

    assert.equal(result.messageTs, "123.456");
    assert.equal(captured.clientMsgId, "11111111-1111-4111-8111-111111111111");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("Slack client reports HTTP status when Slack returns non-JSON", async () => {
  globalThis.fetch = async () =>
    new Response("<html>bad gateway</html>", {
      status: HTTP_STATUS_BAD_GATEWAY,
      headers: { "content-type": "text/html" },
    });

  try {
    await assert.rejects(
      () => listSlackChannels("xoxb-test"),
      /Slack conversations\.list failed: invalid JSON response \(502\)/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("email matching ignores mismatches, bots, and deleted accounts; DM opening must return a personal DM", async (t) => {
  const { lookupSlackUserByEmail, openSlackDirectMessage } =
    await import("../../adapters/secondary/slack/slack-client");
  const mock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: true,
      user: { id: "U1", profile: { email: "wrong@example.com" } },
    }),
  );
  assert.equal(await lookupSlackUserByEmail("fixture", "personaa@example.com"), null);
  mock.mock.mockImplementation(async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: true,
      user: { id: "U1", is_bot: true, profile: { email: "personaa@example.com" } },
    }),
  );
  assert.equal(await lookupSlackUserByEmail("fixture", "personaa@example.com"), null);
  mock.mock.mockImplementation(async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: true,
      user: {
        id: "U1",
        /** @external slack user deleted wire field */
        deleted: true,
        profile: { email: "personaa@example.com" },
      },
    }),
  );
  assert.equal(await lookupSlackUserByEmail("fixture", "personaa@example.com"), null);
  mock.mock.mockImplementation(async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: false,
      error: SLACK_ERROR_USERS_NOT_FOUND,
    }),
  );
  assert.equal(await lookupSlackUserByEmail("fixture", "personaa@example.com"), null);
  mock.mock.mockImplementation(async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: true,
      channel: { id: "C1", is_im: false },
    }),
  );
  await assert.rejects(openSlackDirectMessage("fixture", "U1"), /personal DM/);
});

void test("OAuth separates user message permissions from bot setup permissions", (t) => {
  const old = {
    SLACK_CLIENT_ID: apiEnv.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: apiEnv.SLACK_CLIENT_SECRET,
    SLACK_REDIRECT_URI: apiEnv.SLACK_REDIRECT_URI,
  };
  Object.assign(apiEnv, {
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_REDIRECT_URI: "https://example.com/callback",
  });
  t.after(() => Object.assign(apiEnv, old));
  const url = new URL(buildSlackAuthorizationUrl({ state: "state" }));
  assert.deepEqual(
    new Set(url.searchParams.get("user_scope")?.split(",")),
    new Set(["chat:write", "im:write", "channels:read", "groups:read"]),
  );
});

void test("bot-only grants require reconnect and cannot be used as a sender", async () => {
  const { requireSlackUserToken, slackRequiresReconnect } = await import("../../adapters/secondary/slack/slack-client");
  const legacy = {
    accessToken: "bot",
    scope: "users:read.email,im:write",
    authedUserId: "U1",
    botUserId: "B1",
    teamId: "T1",
    teamName: "Test",
  };
  assert.equal(slackRequiresReconnect(legacy), true);
  assert.throws(() => requireSlackUserToken(legacy), /Reconnect Slack/);
  assert.throws(
    () => requireSlackUserToken({ ...legacy, userAccessToken: "user", userScope: "chat:write" }),
    /Reconnect Slack/,
  );
});

void test("sender checks reject the wrong Slack identity and inaccessible channels", async (t) => {
  const { verifySlackSender, verifySlackSenderChannel } = await import("../../adapters/secondary/slack/slack-client");
  const tokens = {
    accessToken: "bot",
    scope: "users:read.email",
    authedUserId: "U1",
    botUserId: "B1",
    teamId: "T1",
    teamName: "Test",
    userAccessToken: "user",
    userScope: "chat:write,im:write,channels:read,groups:read",
  };
  const mock = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user");

    return Response.json({
      /** @external slack api ok wire field */
      ok: true,
      user_id: "U2",
      team_id: "T1",
    });
  });
  await assert.rejects(verifySlackSender(tokens), /account changed/);
  mock.mock.mockImplementation(async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: true,
      user_id: "U1",
      team_id: "T2",
    }),
  );
  await assert.rejects(verifySlackSender(tokens), /account changed/);
  mock.mock.mockImplementation(async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: true,
      user_id: "U1",
      team_id: "T1",
    }),
  );
  await verifySlackSender(tokens);
  mock.mock.mockImplementation(async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: true,
      channel: { is_member: false },
    }),
  );
  await assert.rejects(verifySlackSenderChannel(tokens, "C1"), /Join the selected/);
  mock.mock.mockImplementation(async () =>
    Response.json({
      /** @external slack api ok wire field */
      ok: true,
      channel: { is_member: true, is_archived: true },
    }),
  );
  await assert.rejects(verifySlackSenderChannel(tokens, "C1"), /Join the selected/);
});

void test("OAuth stores the authorized user token separately and verifies its owner", async (t) => {
  const { exchangeSlackCode } = await import("../../adapters/secondary/slack/slack-client");
  const old = {
    SLACK_CLIENT_ID: apiEnv.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: apiEnv.SLACK_CLIENT_SECRET,
    SLACK_REDIRECT_URI: apiEnv.SLACK_REDIRECT_URI,
  };
  Object.assign(apiEnv, {
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_REDIRECT_URI: "https://example.com/callback",
  });
  t.after(() => Object.assign(apiEnv, old));
  const grant = { shouldOmitUserGrant: false };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(readFetchAddress({ url: input }));
    if (url.pathname.endsWith("oauth.v2.access")) {
      return Response.json({
        /** @external slack api ok wire field */
        ok: true,
        access_token: "bot-token",
        scope: "users:read,users:read.email",
        bot_user_id: "B1",
        team: { id: "T1", name: "Team" },
        authed_user: grant.shouldOmitUserGrant
          ? { id: "U1" }
          : {
              id: "U1",
              access_token: "user-token",
              token_type: "user",
              scope: "chat:write,im:write,channels:read,groups:read",
            },
      });
    }
    if (url.pathname.endsWith("auth.test")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer user-token");

      return Response.json({
        /** @external slack api ok wire field */
        ok: true,
        user_id: "U1",
        team_id: "T1",
      });
    }
    assert.ok(url.pathname.endsWith("users.info"));
    assert.equal(url.searchParams.get("user"), "U1");
    assert.equal(init?.method, "GET");

    return Response.json({
      /** @external slack api ok wire field */
      ok: true,
      user: { profile: { display_name: "Personbr" } },
    });
  });
  const tokens = await exchangeSlackCode("code");
  assert.equal(tokens.accessToken, "bot-token");
  assert.equal(tokens.userAccessToken, "user-token");
  assert.equal(tokens.authedUserId, "U1");
  assert.equal(tokens.authedUserName, "Personbr");
  grant.shouldOmitUserGrant = true;
  await assert.rejects(exchangeSlackCode("code"), /authorize a user account/);
});
