"use client";

import type { SlackChannel } from "@readymeet/shared";
import { useEffect, useState } from "react";

import {
  getApiErrorMessage,
  getSlackDeliverySettings,
  listSlackChannels,
  prepareSlackSalesChannel,
  updateSlackDeliverySettings,
} from "../../composition/api";

import { SettingsDropdown } from "./settings-dropdown";

const SLACK_SETTINGS_CLOSE_LABEL = "Close Slack settings";
const SLACK_SETTINGS_CLOSE_SYMBOL = "×";
const SLACK_SETTINGS_TITLE = "Slack settings";
const SLACK_SETTINGS_RECONNECT_COPY = "Reconnect Slack to send meeting summaries from your Slack account. ";
const SLACK_SETTINGS_RECONNECT_BUTTON = "Reconnect Slack";
const SLACK_SETTINGS_SALES_UPDATES_HEADING = "Sales updates";
const SLACK_SETTINGS_SALES_CHANNEL_ARIA = "Sales updates channel";
const SLACK_SETTINGS_PRIVATE_CHANNEL = "Private channel";
const SLACK_SETTINGS_FINDING_CHANNEL = "Finding a sales channel…";
const SLACK_SETTINGS_CHANNEL_UNAVAILABLE = "Channel unavailable";
const SLACK_SETTINGS_DELIVERY_COPY =
  "Only clear sales calls without sensitive topics can go to a channel. Other meetings can be sent privately to participants who have a matching Slack account.";
const SLACK_SETTINGS_DISCONNECT = "Disconnect";
const SLACK_SETTINGS_CANCEL = "Cancel";
const SLACK_SETTINGS_PREPARING = "Preparing…";
const SLACK_SETTINGS_SAVE = "Save settings";
const SLACK_SETTINGS_ERROR_PREPARE = "Could not prepare a sales channel.";
const SLACK_SETTINGS_ERROR_SAVE = "Could not save Slack settings.";

function slackSettingsSubtitle(teamName: string | null): string {
  const teamSuffix = teamName !== null && teamName.length > 0 ? ` in ${teamName}` : "";

  return `Choose a channel for sales meeting summaries${teamSuffix}. You’ll review every message before it’s sent.`;
}

function buildSalesChannelDropdownOptions(input: { channels: SlackChannel[]; isBusy: boolean }) {
  if (input.channels.length !== 0) {
    return input.channels.map((channel) => ({
      value: channel.id,
      title: `#${channel.name}`,
      ...(channel.isPrivate ? { description: SLACK_SETTINGS_PRIVATE_CHANNEL } : {}),
    }));
  }

  return [{ value: "", title: input.isBusy ? SLACK_SETTINGS_FINDING_CHANNEL : SLACK_SETTINGS_CHANNEL_UNAVAILABLE }];
}

function useSlackConnectorSettingsModalState({
  token,
  onClose,
  onSaved,
}: {
  token: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [isChannelMenuOpen, setIsChannelMenuOpen] = useState(false);
  const [shouldReconnect, setShouldReconnect] = useState(false);
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [channelId, setChannelId] = useState("");
  const [isBusy, setIsBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lifecycle = { isCancelled: false };
    void (async () => {
      try {
        const settings = await getSlackDeliverySettings(token);
        if (!lifecycle.isCancelled) {
          setShouldReconnect(settings.requiresReconnect);
        }
        const channel = await prepareSlackSalesChannel(token);
        const available = await listSlackChannels(token);
        if (!lifecycle.isCancelled) {
          setChannels(available.some((c) => c.id === channel.id) ? available : [channel, ...available]);
          setChannelId(channel.id);
        }
      } catch (loadError) {
        if (!lifecycle.isCancelled) {
          setError(getApiErrorMessage({ error: loadError, fallback: SLACK_SETTINGS_ERROR_PREPARE }));
        }
      } finally {
        if (!lifecycle.isCancelled) {
          setIsBusy(false);
        }
      }
    })();

    return () => {
      lifecycle.isCancelled = true;
    };
  }, [token]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isChannelMenuOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", escape);

    return () => window.removeEventListener("keydown", escape);
  }, [isChannelMenuOpen, onClose]);

  async function save() {
    const channel = channels.find((c) => c.id === channelId);
    if (!channel || isBusy) {
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      await updateSlackDeliverySettings({
        token,
        config: {
          routes: { sales: { channelId: channel.id, channelName: channel.name } },
        },
      });
      onSaved();
      onClose();
    } catch (saveError) {
      setError(getApiErrorMessage({ error: saveError, fallback: SLACK_SETTINGS_ERROR_SAVE }));
    } finally {
      setIsBusy(false);
    }
  }

  const hasError = error !== null && error.length > 0;

  return {
    isChannelMenuOpen,
    setIsChannelMenuOpen,
    shouldReconnect,
    channels,
    channelId,
    setChannelId,
    isBusy,
    error,
    hasError,
    save,
  };
}

function SlackConnectorSettingsModalView({
  teamName,
  onClose,
  onDisconnect,
  onReconnect,
  isChannelMenuOpen,
  setIsChannelMenuOpen,
  shouldReconnect,
  channels,
  channelId,
  setChannelId,
  isBusy,
  error,
  hasError,
  save,
}: {
  teamName: string | null;
  onClose: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  isChannelMenuOpen: boolean;
  setIsChannelMenuOpen: (isOpen: boolean) => void;
  shouldReconnect: boolean;
  channels: SlackChannel[];
  channelId: string;
  setChannelId: (id: string) => void;
  isBusy: boolean;
  error: string | null;
  hasError: boolean;
  save: () => Promise<void>;
}) {
  return (
    <>
      <button
        type="button"
        className="private-beta-application-backdrop settings-modal-backdrop"
        aria-label={SLACK_SETTINGS_CLOSE_LABEL}
        onClick={onClose}
      />
      <section
        className="slack-settings-modal connected-app-management-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="slack-settings-title"
      >
        <button
          type="button"
          className="workspace-settings-modal-close slack-settings-close"
          aria-label={SLACK_SETTINGS_CLOSE_LABEL}
          onClick={onClose}
        >
          <span>{SLACK_SETTINGS_CLOSE_SYMBOL}</span>
        </button>
        <header className="slack-settings-header">
          <h2 id="slack-settings-title">{SLACK_SETTINGS_TITLE}</h2>
          <p className="slack-settings-subtitle">{slackSettingsSubtitle(teamName)}</p>
        </header>
        {shouldReconnect ? (
          <p className="slack-settings-subtitle">
            {SLACK_SETTINGS_RECONNECT_COPY}
            <button type="button" className="settings-secondary-button" onClick={onReconnect}>
              {SLACK_SETTINGS_RECONNECT_BUTTON}
            </button>
          </p>
        ) : null}
        <div className="slack-settings-category-copy">
          <strong>{SLACK_SETTINGS_SALES_UPDATES_HEADING}</strong>
        </div>
        <SettingsDropdown
          className="slack-settings-sales-dropdown"
          ariaLabel={SLACK_SETTINGS_SALES_CHANNEL_ARIA}
          value={channelId}
          options={buildSalesChannelDropdownOptions({ channels, isBusy })}
          isDisabled={isBusy || channels.length === 0}
          isOpen={isChannelMenuOpen}
          onOpenChange={setIsChannelMenuOpen}
          onSelect={setChannelId}
        />
        <p className="slack-settings-subtitle">{SLACK_SETTINGS_DELIVERY_COPY}</p>
        {hasError ? (
          <p role="alert" className="settings-error">
            {error}
          </p>
        ) : null}
        <SlackConnectorSettingsModalActions
          isBusy={isBusy}
          channelId={channelId}
          onDisconnect={onDisconnect}
          onClose={onClose}
          onSave={() => void save()}
        />
      </section>
    </>
  );
}

function SlackConnectorSettingsModalActions({
  isBusy,
  channelId,
  onDisconnect,
  onClose,
  onSave,
}: {
  isBusy: boolean;
  channelId: string;
  onDisconnect: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <div className="slack-settings-actions">
      <button type="button" className="settings-secondary-button slack-settings-disconnect" onClick={onDisconnect}>
        {SLACK_SETTINGS_DISCONNECT}
      </button>
      <button type="button" className="settings-secondary-button" onClick={onClose}>
        {SLACK_SETTINGS_CANCEL}
      </button>
      <button type="button" className="slack-settings-save" disabled={isBusy || channelId === ""} onClick={onSave}>
        {isBusy ? SLACK_SETTINGS_PREPARING : SLACK_SETTINGS_SAVE}
      </button>
    </div>
  );
}

export function SlackConnectorSettingsModal({
  token,
  teamName,
  onClose,
  onDisconnect,
  onSaved,
  onReconnect,
}: {
  token: string;
  teamName: string | null;
  onClose: () => void;
  onDisconnect: () => void;
  onSaved: () => void;
  onReconnect: () => void;
}) {
  const state = useSlackConnectorSettingsModalState({ token, onClose, onSaved });

  return (
    <SlackConnectorSettingsModalView
      teamName={teamName}
      onClose={onClose}
      onDisconnect={onDisconnect}
      onReconnect={onReconnect}
      {...state}
    />
  );
}
