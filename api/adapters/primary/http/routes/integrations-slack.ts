import {
  slackChannelsResponseSchema,
  slackConnectRequestSchema,
  slackConnectResponseSchema,
  slackCreateChannelRequestSchema,
  slackCreateChannelResponseSchema,
  slackDeliverySettingsResponseSchema,
  slackDeliverySettingsUpdateRequestSchema,
  slackDisconnectResponseSchema,
} from "@readymeet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { apiEnv } from "../../../../composition/env";
import { repositories } from "../../../../ports/repository-runtime";
import { encryptJsonSecret } from "../../../secondary/node/secret-crypto";
import {
  buildSlackAuthorizationUrl,
  createSlackChannel,
  exchangeSlackCode,
  inviteSlackUserToChannel,
  listSlackChannels,
  revokeSlackToken,
  slackRequiresReconnect,
} from "../../../secondary/slack/slack-client";
import {
  ensureSalesChannel,
  getConnectedSlackForUser,
  getSlackDeliveryConfig,
} from "../../../secondary/slack/slack-connection";
import { requireAuth } from "../plugins/auth";
import { signOAuthState, verifyOAuthState } from "../support/auth";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const SLACK_CALLBACK_REDIRECT_DELAY_MS = 500;
const MESSAGE_UNAUTHORIZED = "Unauthorized";
const MESSAGE_UNABLE_TO_START_SLACK_OAUTH = "Unable to start Slack OAuth";
const MESSAGE_MISSING_SLACK_OAUTH_CODE_OR_STATE = "Missing Slack OAuth code or state";
const MESSAGE_CONNECT_SLACK_FIRST = "Connect Slack first.";
const MESSAGE_COULD_NOT_LOAD_SLACK_CHANNELS = "Could not load Slack channels. Try again.";
const MESSAGE_ENTER_CHANNEL_NAME = "Enter a channel name.";
const MESSAGE_CHANNEL_NAME_TAKEN = "A channel with that name already exists.";
const MESSAGE_COULD_NOT_CREATE_SLACK_CHANNEL = "Could not create the Slack channel. Try again.";
const MESSAGE_COULD_NOT_PREPARE_SALES_CHANNEL = "Could not prepare the sales channel.";
const MESSAGE_INVALID_SLACK_DELIVERY_SETTINGS = "Invalid Slack delivery settings.";
const MESSAGE_CHOOSE_AVAILABLE_SALES_CHANNEL = "Choose an available sales channel.";

const slackOAuthStateSchema = z.object({
  sub: z.string(),
  email: z.string(),
  displayName: z.string(),
  returnTo: z.string().optional(),
});
const slackOAuthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

type SlackOAuthState = z.infer<typeof slackOAuthStateSchema>;

function signSlackState(input: { state: SlackOAuthState }) {
  return signOAuthState({ provider: "slack", state: input.state });
}

function verifySlackState(input: { state: string }) {
  const verified = verifyOAuthState({ provider: "slack", token: input.state });

  return slackOAuthStateSchema.parse(verified);
}

function safeVerifySlackState(input: { state: string }) {
  try {
    return verifySlackState(input);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return null;
  }
}

function normalizeReturnTo(input: { returnTo: string | undefined }) {
  if (input.returnTo === undefined || input.returnTo.length === 0) {
    return undefined;
  }
  try {
    const target = new URL(input.returnTo, apiEnv.NEXT_PUBLIC_WEB_URL);
    const webOrigin = new URL(apiEnv.NEXT_PUBLIC_WEB_URL).origin;

    return target.origin === webOrigin ? target.toString() : undefined;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return undefined;
  }
}

function withSlackStatus(input: { returnTo: string; status: "connected" | "error" }) {
  const target = new URL(input.returnTo, apiEnv.NEXT_PUBLIC_WEB_URL);
  target.searchParams.set("slack", input.status);

  return target.toString();
}

function renderSlackCallbackPage(input: { status: "connected" | "error"; returnTo: string }) {
  const targetOrigin = new URL(apiEnv.NEXT_PUBLIC_WEB_URL).origin;
  const returnTo = withSlackStatus({ returnTo: input.returnTo, status: input.status });
  const messageType = input.status === "connected" ? "readymeet.slack.connected" : "readymeet.slack.error";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Slack connected</title>
  </head>
  <body>
    <p>${input.status === "connected" ? "Slack connected. You can close this window." : "Slack connection failed. You can close this window."}</p>
    <script>
      (function () {
        var message = ${JSON.stringify({ type: messageType })};
        var targetOrigin = ${JSON.stringify(targetOrigin)};
        var returnTo = ${JSON.stringify(returnTo)};
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(message, targetOrigin);
          window.close();
          window.setTimeout(function () {
            window.location.replace(returnTo);
          }, ${SLACK_CALLBACK_REDIRECT_DELAY_MS});
          return;
        }
        window.location.replace(returnTo);
      })();
    </script>
  </body>
</html>`;
}

type SlackOAuthCallbackQuery = z.infer<typeof slackOAuthCallbackQuerySchema>;

function slackOAuthCallbackReturnToForError(query: SlackOAuthCallbackQuery) {
  const state =
    query.state !== undefined && query.state.length > 0 ? safeVerifySlackState({ state: query.state }) : null;

  return state?.returnTo ?? apiEnv.NEXT_PUBLIC_WEB_URL;
}

async function persistSlackOAuthConnection(input: { code: string; state: SlackOAuthState }) {
  const tokens = await exchangeSlackCode(input.code);
  const profile = await repositories().ensureDefaultAgentProfileForUser({
    userId: input.state.sub,
    displayName: input.state.displayName,
    voiceId: null,
    llmModel: null,
  });

  await repositories().upsertAgentConnector({
    userId: input.state.sub,
    agentProfileId: profile.id,
    provider: "slack",
    providerAccountId: tokens.teamId.length > 0 ? tokens.teamId : null,
    providerTenantId: tokens.teamId.length > 0 ? tokens.teamId : null,
    status: "connected",
    scope: "private",
    externalAccountEmail: tokens.teamName.length > 0 ? tokens.teamName : null,
    scopes: tokens.scope.length > 0 ? tokens.scope.split(",") : [],
    secretRef: encryptJsonSecret(tokens),
  });
}

async function handleSlackOAuthCallback(request: FastifyRequest, reply: FastifyReply) {
  const query = slackOAuthCallbackQuerySchema.parse(request.query);
  if (query.error !== undefined && query.error.length > 0) {
    return reply.type("text/html").send(
      renderSlackCallbackPage({
        status: "error",
        returnTo: slackOAuthCallbackReturnToForError(query),
      }),
    );
  }
  if (query.code === undefined || query.code.length === 0 || query.state === undefined || query.state.length === 0) {
    return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_MISSING_SLACK_OAUTH_CODE_OR_STATE });
  }

  try {
    const state = verifySlackState({ state: query.state });
    await persistSlackOAuthConnection({ code: query.code, state });

    return await reply.type("text/html").send(
      renderSlackCallbackPage({
        status: "connected",
        returnTo: state.returnTo ?? apiEnv.NEXT_PUBLIC_WEB_URL,
      }),
    );
  } catch (error) {
    request.log.error({ error }, "Slack OAuth callback failed");

    return reply.type("text/html").send(
      renderSlackCallbackPage({
        status: "error",
        returnTo: apiEnv.NEXT_PUBLIC_WEB_URL,
      }),
    );
  }
}

function registerSlackConnectRoute(app: FastifyInstance): void {
  app.post("/integrations/slack/connect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }
    const parsed = slackConnectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: parsed.error.message });
    }

    try {
      const state = signSlackState({
        state: {
          sub: user.id,
          email: user.email,
          displayName: user.displayName,
          returnTo: normalizeReturnTo({ returnTo: parsed.data.returnTo }),
        },
      });

      return slackConnectResponseSchema.parse({
        authorizationUrl: buildSlackAuthorizationUrl({ state }),
      });
    } catch (error) {
      return reply.code(HTTP_BAD_REQUEST).send({
        message: error instanceof Error ? error.message : MESSAGE_UNABLE_TO_START_SLACK_OAUTH,
      });
    }
  });
}

function registerSlackCallbackRoute(app: FastifyInstance): void {
  app.get("/integrations/slack/callback", handleSlackOAuthCallback);
}

function registerSlackDisconnectRoute(app: FastifyInstance): void {
  app.post("/integrations/slack/disconnect", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      return reply.code(HTTP_UNAUTHORIZED).send({ message: MESSAGE_UNAUTHORIZED });
    }

    const slackConnection = await getConnectedSlackForUser(user.id);
    if (slackConnection !== null) {
      // A bot token can be shared by multiple installers in the same workspace.
      // Revoke only this user's grant when the connection supports user sending.
      await [slackConnection.tokens.userAccessToken ?? slackConnection.tokens.accessToken].reduce(
        async (previous, token) => {
          await previous;
          try {
            await revokeSlackToken(token);
          } catch (revokeError) {
            request.log.warn({ error: revokeError }, "Slack token revoke failed during disconnect");
          }
        },
        Promise.resolve(),
      );
    }
    const profile = await repositories().ensureDefaultAgentProfileForUser({
      userId: user.id,
      displayName: user.displayName,
      voiceId: null,
      llmModel: null,
    });
    await repositories().upsertAgentConnector({
      userId: user.id,
      agentProfileId: profile.id,
      provider: "slack",
      providerAccountId: slackConnection?.connector.providerAccountId ?? null,
      status: "disconnected",
      scope: "private",
      externalAccountEmail: null,
    });

    return slackDisconnectResponseSchema.parse({
      /** @external slack disconnect ok wire field */
      ok: true,
    });
  });
}

function registerSlackChannelsRoutes(app: FastifyInstance): void {
  app.get("/integrations/slack/channels", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      throw new Error(MESSAGE_UNAUTHORIZED);
    }
    const slackConnection = await getConnectedSlackForUser(user.id);
    if (slackConnection === null) {
      return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_CONNECT_SLACK_FIRST });
    }

    try {
      const channels = await listSlackChannels(slackConnection.tokens.accessToken);

      return slackChannelsResponseSchema.parse({ channels });
    } catch (error) {
      request.log.error({ error }, "Slack channel listing failed");

      return reply.code(HTTP_BAD_GATEWAY).send({ message: MESSAGE_COULD_NOT_LOAD_SLACK_CHANNELS });
    }
  });

  app.post("/integrations/slack/channels", { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user;
    if (user === undefined) {
      throw new Error(MESSAGE_UNAUTHORIZED);
    }
    const slackConnection = await getConnectedSlackForUser(user.id);
    if (slackConnection === null) {
      return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_CONNECT_SLACK_FIRST });
    }
    const parsed = slackCreateChannelRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_ENTER_CHANNEL_NAME });
    }

    try {
      const channel = await createSlackChannel(slackConnection.tokens.accessToken, parsed.data.name);
      try {
        await inviteSlackUserToChannel(
          slackConnection.tokens.accessToken,
          channel.id,
          slackConnection.tokens.authedUserId,
        );
      } catch (inviteError) {
        request.log.warn(
          { error: inviteError, channelId: channel.id },
          "Slack channel created but authorizing user invite failed",
        );
      }

      return slackCreateChannelResponseSchema.parse({ channel });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("name_taken")) {
        return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_CHANNEL_NAME_TAKEN });
      }
      request.log.error({ error }, "Slack channel creation failed");

      return reply.code(HTTP_BAD_GATEWAY).send({ message: MESSAGE_COULD_NOT_CREATE_SLACK_CHANNEL });
    }
  });
}

function registerSlackSalesChannelRoute(app: FastifyInstance): void {
  app.post("/integrations/slack/sales-channel", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const user = request.user;
      if (user === undefined) {
        throw new Error(MESSAGE_UNAUTHORIZED);
      }

      return slackCreateChannelResponseSchema.parse({ channel: await ensureSalesChannel(user.id) });
    } catch (error) {
      return reply
        .code(HTTP_CONFLICT)
        .send({ message: error instanceof Error ? error.message : MESSAGE_COULD_NOT_PREPARE_SALES_CHANNEL });
    }
  });
}

function registerSlackDeliveryRoutes(app: FastifyInstance): void {
  app.get("/me/slack-delivery", { preHandler: requireAuth }, async (request) => {
    const user = request.user;
    if (user === undefined) {
      throw new Error(MESSAGE_UNAUTHORIZED);
    }
    const userId = user.id;
    const [slackConnection, config] = await Promise.all([
      getConnectedSlackForUser(userId),
      getSlackDeliveryConfig(userId),
    ]);
    const isSlackConnected = slackConnection !== null;

    return slackDeliverySettingsResponseSchema.parse({
      slack: {
        /** @external slack delivery connected wire field */
        connected: isSlackConnected,
        teamName: slackConnection?.tokens.teamName ?? null,
        /** @external slack delivery requires reconnect wire field */
        requiresReconnect: slackConnection !== null && slackRequiresReconnect(slackConnection.tokens),
        config,
      },
    });
  });

  app.put("/me/slack-delivery", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = slackDeliverySettingsUpdateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_INVALID_SLACK_DELIVERY_SETTINGS });
    }

    const user = request.user;
    if (user === undefined) {
      throw new Error(MESSAGE_UNAUTHORIZED);
    }
    const userId = user.id;
    const slackConnection = await getConnectedSlackForUser(userId);
    if (slackConnection === null) {
      return reply.code(HTTP_CONFLICT).send({ message: MESSAGE_CONNECT_SLACK_FIRST });
    }
    const requested = parsed.data.config.routes.sales;
    const channel =
      requested !== undefined && requested !== null
        ? (await listSlackChannels(slackConnection.tokens.accessToken)).find(
            (candidate) => candidate.id === requested.channelId,
          )
        : undefined;
    if (channel === undefined) {
      return reply.code(HTTP_BAD_REQUEST).send({ message: MESSAGE_CHOOSE_AVAILABLE_SALES_CHANNEL });
    }
    await repositories().upsertSlackDeliveryConfig({
      userId,
      routes: { sales: { channelId: channel.id, channelName: channel.name } },
    });

    return slackDeliverySettingsResponseSchema.parse({
      slack: {
        /** @external slack delivery connected wire field */
        connected: true,
        teamName: slackConnection.tokens.teamName,
        config: await getSlackDeliveryConfig(userId),
      },
    });
  });
}

export async function slackIntegrationRoutes(app: FastifyInstance): Promise<void> {
  registerSlackConnectRoute(app);
  registerSlackCallbackRoute(app);
  registerSlackDisconnectRoute(app);
  registerSlackChannelsRoutes(app);
  registerSlackSalesChannelRoute(app);
  registerSlackDeliveryRoutes(app);
}
