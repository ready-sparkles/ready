import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { SlackChannel, SlackDeliveryConfig } from "@readymeet/shared";
import { DEFAULT_SLACK_DELIVERY_CONFIG, slackDeliveryConfigSchema, slackMeetingCategoryKeys } from "@readymeet/shared";
import { z } from "zod";

import { decryptStoredJsonSecret, isStoredJsonObject } from "../../../ports/gate-secret-crypto";
import { repositories } from "../../../ports/repository-runtime";

import type { SlackTokenSet } from "./slack-client";

const slackMeetingCategoryKeySet = new Set<string>(slackMeetingCategoryKeys);

const SLACK_CONNECTION_MESSAGES = {
  connectSlackFirst: "Connect Slack first.",
  salesChannelExistsNoAccess: "The sales-meetings channel exists but is not accessible. Ask a Slack admin for access.",
} as const;

const SLACK_ERROR_FRAGMENTS = {
  nameTaken: "name_taken",
  alreadyInChannel: "already_in_channel",
} as const;

const PREFERRED_SALES_CHANNEL_NAMES = ["sales-meetings", "sales-updates", "sales-calls", "sales"] as const;
const DEFAULT_SALES_CHANNEL_NAME = "sales-meetings";

type ConnectedSlackForUser = {
  connector: NonNullable<Awaited<ReturnType<RepositoryPort["getAgentConnectorForUser"]>>>;
  tokens: SlackTokenSet;
};

export async function getConnectedSlackForUser(userId: string): Promise<ConnectedSlackForUser | null> {
  const connector = await repositories().getAgentConnectorForUser({ userId, provider: "slack" });
  if (connector === null || connector.status !== "connected") {
    return null;
  }

  const secret = await repositories().getLatestAgentConnectorSecret(connector.id);
  if (secret === null) {
    return null;
  }

  return {
    connector,
    tokens: decryptStoredJsonSecret({
      secretRef: secret.secretRef,
      schema: z.custom<SlackTokenSet>(isStoredJsonObject),
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterKnownSlackRoutes(routes: unknown): Record<string, unknown> {
  if (!isRecord(routes)) {
    return {};
  }

  return Object.fromEntries(Object.entries(routes).filter(([key]) => slackMeetingCategoryKeySet.has(key)));
}

/** Reads the stored routing config, tolerating rows written by older builds. */
export async function getSlackDeliveryConfig(userId: string): Promise<SlackDeliveryConfig> {
  const row = await repositories().getSlackDeliveryConfigForUser(userId);
  if (row === null) {
    return DEFAULT_SLACK_DELIVERY_CONFIG;
  }

  const parsed = slackDeliveryConfigSchema.safeParse({
    routes: filterKnownSlackRoutes(row.routes),
  });

  return parsed.success ? parsed.data : DEFAULT_SLACK_DELIVERY_CONFIG;
}

/** Channel names are hints only; the destination is always shown before sending. */
export function suggestSalesChannel(channels: SlackChannel[]): SlackChannel | null {
  const preferredMatch = PREFERRED_SALES_CHANNEL_NAMES.map((name) =>
    channels.find((channel) => channel.name.toLowerCase() === name),
  ).find((channel) => channel !== undefined);

  if (preferredMatch !== undefined) {
    return preferredMatch;
  }

  return channels.find((channel) => /(^|[-_])sales([-_]|$)/i.test(channel.name)) ?? null;
}

export async function ensureSalesChannel(userId: string): Promise<SlackChannel> {
  const { listSlackChannels, createSlackChannel, inviteSlackUserToChannel } = await import("./slack-client");
  const connected = await getConnectedSlackForUser(userId);
  if (connected === null) {
    throw new Error(SLACK_CONNECTION_MESSAGES.connectSlackFirst);
  }
  const channels = await listSlackChannels(connected.tokens.accessToken);
  const config = await getSlackDeliveryConfig(userId);
  const saved = channels.find((channel) => channel.id === config.routes.sales?.channelId);
  const channelState = {
    channel: saved ?? suggestSalesChannel(channels),
  };
  if (channelState.channel === null) {
    try {
      channelState.channel = await createSlackChannel(connected.tokens.accessToken, DEFAULT_SALES_CHANNEL_NAME);
    } catch (error) {
      // Another setup may have created it concurrently. Do not invent a new name.
      if (!(error instanceof Error) || !error.message.includes(SLACK_ERROR_FRAGMENTS.nameTaken)) {
        throw error;
      }
      channelState.channel =
        (await listSlackChannels(connected.tokens.accessToken)).find(
          (candidate) => candidate.name === DEFAULT_SALES_CHANNEL_NAME,
        ) ?? null;
      if (channelState.channel === null) {
        throw new Error(SLACK_CONNECTION_MESSAGES.salesChannelExistsNoAccess);
      }
    }
    try {
      await inviteSlackUserToChannel(
        connected.tokens.accessToken,
        channelState.channel.id,
        connected.tokens.authedUserId,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(SLACK_ERROR_FRAGMENTS.alreadyInChannel)) {
        throw error;
      }
    }
  }
  await repositories().upsertSlackDeliveryConfig({
    userId,
    routes: { sales: { channelId: channelState.channel.id, channelName: channelState.channel.name } },
  });

  return channelState.channel;
}
