"use client";

import type { CalendarAccount, CalendarProvider, ProviderAccountKind } from "@readymeet/shared";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { listCalendarEvents } from "../../composition/api";
import {
  connectCalendar,
  connectLinear,
  connectSlack,
  deleteCalendarAccountData,
  deleteReadyAccount,
  deleteWorkspace,
  disconnectLinear,
  disconnectSlack,
  getApiErrorCode,
  getApiErrorMessage,
  getMyAgentSettings,
  getMyWorkspace,
  listCalendarAccounts,
  logoutAllDevices,
  updateCalendarAccount,
  updateUserProfile,
} from "../../composition/api";
import { setCachedCalendarConnectionProviders } from "../../composition/calendar-connection-store";
import { webEnv } from "../../composition/env";
import { syncActiveWorkspaceSession } from "../../composition/workspace-session-sync";
import {
  calendarAccountStatusCopy,
  isCurrentProviderAccountLoad,
  type ProviderAccountLoadScope,
  providerAccountsForUser,
} from "../../domain/calendar-account-settings";
import { calendarEventsQueryKey } from "../../domain/query-keys";
import { workspaceSettingsPermissions } from "../../domain/workspace-permissions";
import { readWorkspaceReturnLocation } from "../../domain/workspace-return-location";

import { AshbyConnectorRow } from "./ashby-connector";
import { useAuth } from "./auth-provider";
import { BillingPanel } from "./billing-panel";
import { GoogleCalendarLogo } from "./google-calendar-logo";
import { MeetingIntelligenceSettingsPanel } from "./meeting-intelligence-settings-panel";
import { SettingsDropdown, type SettingsDropdownOption } from "./settings-dropdown";
import { SlackConnectorSettingsModal } from "./slack-connector-settings-modal";
import { SlackLogo } from "./slack-logo";
import { useTheme } from "./theme-provider";
import { useToast } from "./toast-provider";
import { WorkspaceAdminMembersPanel, WorkspaceAdminWorkspacePanel } from "./workspace-admin-settings";
import { OutlookCalendarLogo } from "./workspace-home";
import { MemorySettingsPanel } from "./workspace-memory";
import { CalendarStackIcon } from "./workspace-shell";

import "./settings-page.css";

const MAX_WORKSPACE_AVATAR_INITIALS = 2;
const CONNECTOR_RETRY_POLL_INTERVAL_MS = 600;

function ignoreCaughtFailure(error: unknown) {
  if (error instanceof Error || typeof error === "string" || (typeof error === "object" && error !== null)) {
    return;
  }
  throw error;
}

async function runWithoutReject({
  operation,
  onError,
}: {
  operation: () => Promise<unknown>;
  onError?: (error: unknown) => void;
}) {
  try {
    await operation();
  } catch (error) {
    if (onError !== undefined) {
      onError(error);

      return;
    }
    ignoreCaughtFailure(error);
  }
}

type SettingsTab =
  | "meeting-intelligence"
  | "memory"
  | "account"
  | "calendars"
  | "connectors"
  | "billing"
  | "workspace"
  | "members";
type AgentConnectorInfo = Awaited<ReturnType<typeof getMyAgentSettings>>["connectors"][number];
type DeleteTarget =
  | { kind: "calendar"; account: CalendarAccount }
  | { kind: "account"; email: string }
  | { kind: "workspace"; id: string; name: string };
type CalendarEventsCache = Awaited<ReturnType<typeof listCalendarEvents>>;

const CALENDAR_DISCLOSURE =
  "Connect Google Calendar or Outlook so Ready can understand your schedule, prepare for upcoming meetings, find availability, and help manage events you approve. Ready only stores the calendar information needed to support these features, including event details, attendees, availability, sync data, and meeting prep it creates for you. You can delete a connected calendar and its saved data anytime.";
const CALENDAR_CONNECT_PROVIDERS = [
  "google_calendar",
  "outlook_calendar",
] as const satisfies readonly CalendarProvider[];
const SETTINGS_TABS = [
  "meeting-intelligence",
  "memory",
  "account",
  "calendars",
  "connectors",
  "billing",
  "workspace",
  "members",
] as const satisfies readonly SettingsTab[];
const LINEAR_OAUTH_POPUP_NAME = "readymeet-linear-oauth";
const LINEAR_OAUTH_CHANNEL = "readymeet.linear.oauth";
const SLACK_OAUTH_POPUP_NAME = "readymeet-slack-oauth";
const SLACK_OAUTH_CHANNEL = "readymeet.slack.oauth";
const CONNECTORS_DISCLOSURE =
  "Connect the tools your team uses. Ready brings relevant context into meetings and sends follow-ups where work happens.";
const CALENDAR_ACCOUNT_KIND_OPTIONS = [
  {
    value: "work",
    title: "Work",
    description: "Use for company calendars and meetings tied to your job.",
  },
  {
    value: "personal",
    title: "Personal",
    description: "Use for personal schedules outside your work calendar.",
  },
] as const satisfies readonly SettingsDropdownOption<ProviderAccountKind>[];
const THEME_OPTIONS = [
  {
    value: "light",
    title: "Light",
  },
  {
    value: "dark",
    title: "Dark",
  },
] as const satisfies readonly SettingsDropdownOption<"light" | "dark">[];

const SETTINGS_PAGE_COPY = {
  deleteDialogTypeToConfirm: "Type ",
  deleteDialogTypeToConfirmSuffix: " to confirm",
  cancelLabel: "Cancel",
  linearSettingsTitle: "Linear settings",
  linearSettingsConnectedPrefix: "Linear is connected",
  linearSettingsConnectedToPrefix: " to ",
  linearSettingsConnectedSuffix: ". Ready can find relevant issues and projects, then draft updates for your review.",
  linearSettingsDisconnect: "Disconnect",
  linearSettingsDone: "Done",
  slackConnectedTitle: "Slack connected",
  slackConnectedMessage: "Choose which channels get your meeting notes.",
  slackConnectionFailedTitle: "Slack connection failed",
  slackConnectionFailedMessage: "Try connecting again.",
  linearConnectedTitle: "Linear connected",
  linearConnectedMessage: "The Ready assistant can now use Linear in your meetings.",
  linearConnectionFailedTitle: "Linear connection failed",
  linearConnectionFailedMessage: "Try connecting again.",
  calendarConnectedTitle: "Calendar connected",
  calendarConnectionFailedTitle: "Calendar connection failed",
  calendarConnectionFailedMessage: "Try connecting again.",
  calendarUpdatedTitle: "Calendar updated",
  calendarUpdatedMessage: "Account type saved.",
  calendarDeletedTitle: "Calendar deleted",
  calendarDeletedMessage: "Saved calendar data was deleted from Ready.",
  calendarDeleteFailedTitle: "Calendar delete failed",
  calendarDeleteFailedMessage: "The calendar was restored in Settings.",
  workspaceDeletedSessionSyncMessage:
    "Workspace deleted, but your session could not switch to another workspace. Refresh Ready before continuing.",
  workspaceDeletedTitle: "Workspace deleted",
  workspaceDeletedSwitchedMessage: "You are now using another workspace.",
  workspaceDeleteCancelBillingTitle: "Cancel billing first",
  workspaceDeleteFailedTitle: "Workspace delete failed",
  accountDeleteTransferTitle: "Transfer workspace ownership",
  accountDeleteBillingTitle: "Resolve billing before deleting",
  accountDeleteFailedTitle: "Account delete failed",
  slackSettingsSavedTitle: "Slack settings saved",
  slackSettingsSavedMessage: "Sales summaries will use your chosen channel after you confirm.",
  backToApp: "Back to app",
  accountTab: "Account",
  calendarsTab: "Calendars",
  connectedAppsTab: "Connected apps",
  memoryTab: "Privacy",
  featuresHeading: "Features",
  meetingIntelligenceTab: "Meeting intelligence",
  workspaceTab: "Workspace",
  membersTab: "Members",
  billingTab: "Billing",
  profileImageLabel: "Profile image",
  emailLabel: "Email",
  unknownEmail: "Unknown email",
  fullNameLabel: "Full name",
  themeLabel: "Theme",
  logoutAllDevicesLabel: "Log out of all devices",
  logoutThisDeviceLabel: "Log out of this device",
  loggingOutLabel: "Logging out...",
  logoutLabel: "Log out",
  deleteAccountDescription: "Delete your Ready account and private account data.",
  deletingLabel: "Deleting...",
  deleteAccountLabel: "Delete account",
  calendarsTitle: "Calendars",
  unknownAccount: "Unknown account",
  reconnectLabel: "Reconnect",
  openingLabel: "Opening...",
  deleteLabel: "Delete",
  connectNewCalendar: "Connect new calendar",
  connectedAppsTitle: "Connected apps",
  linearName: "Linear",
  linearDescription: "Turn meeting follow-ups into Linear issues.",
  manageLabel: "Manage",
  connectLabel: "Connect",
  slackName: "Slack",
  slackDescription: "Send meeting summaries from your Slack account.",
  billingTitle: "Billing",
  billingDescription: "Manage your plan, credits, and current included balance.",
  workspaceAccessDenied: "Only workspace owners and admins can access Workspace settings.",
  membersSignInRequired: "Sign in to view workspace members.",
  deleteDialogAccountTitle: "Delete Ready account?",
  deleteDialogWorkspaceTitle: "Delete workspace?",
  deleteDialogCalendarTitle: "Delete calendar?",
  deleteDialogAccountBody:
    "This revokes Ready sessions, deletes connected provider data, and anonymizes your Ready account.",
  deleteDialogWorkspaceBodyPrefix: "This deletes ",
  deleteDialogWorkspaceBodySuffix:
    ", including its meetings, notes, tasks, members, invitations, and workspace settings.",
  deleteDialogDisconnectPrefix: "This disconnects ",
  deleteDialogDisconnectCalendarSuffix: " and deletes saved calendar data from Ready.",
  deleteDialogDeleteAccountAction: "Delete account",
  deleteDialogDeleteWorkspaceAction: "Delete workspace",
  deleteDialogDeleteAction: "Delete",
  calendarDeleteTooltip: "Removes access and deletes saved calendar data from Ready.",
  calendarConnectedMessageSuffix: " is ready.",
  chooseCalendarProvider: "Choose calendar provider",
  defaultAvatarInitial: "R",
  modalCloseIcon: "×",
  linearSettingsCloseAriaLabel: "Close Linear settings",
};

type ConnectorOAuthStatus = "connected" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab === value);
}

function isCalendarProviderValue(value: unknown): value is CalendarProvider {
  return value === "google_calendar" || value === "outlook_calendar";
}

function readConnectorOAuthStatus(data: unknown): ConnectorOAuthStatus | null {
  if (!isRecord(data)) {
    return null;
  }
  const status = data.status;
  if (status === "connected" || status === "error") {
    return status;
  }

  return null;
}

function readMessageEventType(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }

  return typeof data.type === "string" ? data.type : undefined;
}

function buildDeleteDialogExpectedValue(target: DeleteTarget | null): string | null {
  if (target === null) {
    return null;
  }
  if (target.kind === "account") {
    return target.email;
  }
  if (target.kind === "workspace") {
    return target.name;
  }

  return accountEmail(target.account);
}

function buildDeleteDialogTitle(target: DeleteTarget): string {
  if (target.kind === "account") {
    return SETTINGS_PAGE_COPY.deleteDialogAccountTitle;
  }
  if (target.kind === "workspace") {
    return SETTINGS_PAGE_COPY.deleteDialogWorkspaceTitle;
  }

  return SETTINGS_PAGE_COPY.deleteDialogCalendarTitle;
}

function buildDeleteDialogBody(input: { target: DeleteTarget; expectedValue: string }): string {
  const { target, expectedValue } = input;
  if (target.kind === "account") {
    return SETTINGS_PAGE_COPY.deleteDialogAccountBody;
  }
  if (target.kind === "workspace") {
    return (
      SETTINGS_PAGE_COPY.deleteDialogWorkspaceBodyPrefix +
      target.name +
      SETTINGS_PAGE_COPY.deleteDialogWorkspaceBodySuffix
    );
  }

  return (
    SETTINGS_PAGE_COPY.deleteDialogDisconnectPrefix +
    expectedValue +
    SETTINGS_PAGE_COPY.deleteDialogDisconnectCalendarSuffix
  );
}

function buildDeleteDialogActionLabel(target: DeleteTarget): string {
  if (target.kind === "account") {
    return SETTINGS_PAGE_COPY.deleteDialogDeleteAccountAction;
  }
  if (target.kind === "workspace") {
    return SETTINGS_PAGE_COPY.deleteDialogDeleteWorkspaceAction;
  }

  return SETTINGS_PAGE_COPY.deleteDialogDeleteAction;
}

function buildCalendarConnectedToastMessage(provider: CalendarProvider): string {
  return calendarProviderLabel(provider) + SETTINGS_PAGE_COPY.calendarConnectedMessageSuffix;
}

function AccountNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18.4984 19.1511C17.3377 17.4018 15.2947 16.2009 12.9313 16.0569L11.9984 16C11.6652 16.0083 11.3547 16.0194 11.0617 16.0325C8.71722 16.1376 6.66598 17.3796 5.5 19.1511" />
      <path d="M14.9961 10C14.9961 11.6569 13.6529 13 11.9961 13C10.3392 13 8.99609 11.6569 8.99609 10C8.99609 8.34315 10.3392 7 11.9961 7C13.6529 7 14.9961 8.34315 14.9961 10Z" />
      <path d="M22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12Z" />
    </svg>
  );
}

function BillingNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <path
        d="M2 12C2 8.46252 2 6.69377 3.0528 5.5129C3.22119 5.32403 3.40678 5.14935 3.60746 4.99087C4.86213 4 6.74142 4 10.5 4H13.5C17.2586 4 19.1379 4 20.3925 4.99087C20.5932 5.14935 20.7788 5.32403 20.9472 5.5129C22 6.69377 22 8.46252 22 12C22 15.5375 22 17.3062 20.9472 18.4871C20.7788 18.676 20.5932 18.8506 20.3925 19.0091C19.1379 20 17.2586 20 13.5 20H10.5C6.74142 20 4.86213 20 3.60746 19.0091C3.40678 18.8506 3.22119 18.676 3.0528 18.4871C2 17.3062 2 15.5375 2 12Z"
        strokeLinecap="round"
      />
      <path d="M10 16H11.5" strokeMiterlimit="10" strokeLinecap="round" />
      <path d="M14.5 16L18 16" strokeMiterlimit="10" strokeLinecap="round" />
      <path d="M2 9H22" />
    </svg>
  );
}

function ConnectorsNavIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-nav-icon" fill="none">
      <path
        d="M6 4h4a2 2 0 0 1 2 2v5a1 1 0 0 0 1 1h5a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm-2 8h8v8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="15" y="1" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function WorkspaceNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path
        d="M6.50153 4.88815L9.50153 3.67269C11.9917 2.66381 13.2368 2.15936 14.1184 2.75565C15 3.35194 15 4.6985 15 7.39161V21.5H4V8.60707C4 7.29651 4 6.64122 4.34192 6.13291C4.68384 5.62459 5.28973 5.37911 6.50153 4.88815Z"
        strokeLinejoin="round"
      />
      <path
        d="M15 8.5H16C17.8856 8.5 18.8284 8.5 19.4142 9.08579C20 9.67157 20 10.6144 20 12.5V21.5H15"
        strokeLinejoin="round"
      />
      <path d="M2 21.5H22" />
      <path d="M8 8.5H11" strokeLinejoin="round" />
      <path d="M8 12.5H11" strokeLinejoin="round" />
      <path d="M8 16.5H11" strokeLinejoin="round" />
    </svg>
  );
}

function MeetingIntelligenceNavIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      className="workspace-nav-icon"
      aria-hidden="true"
      color="currentColor"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path
        d="M18.8284 18.8284C17.6569 20 15.7712 20 12 20C8.22876 20 6.34315 20 5.17157 18.8284C4 17.6569 4 15.7712 4 12C4 8.22876 4 6.34315 5.17157 5.17157C6.34315 4 8.22876 4 12 4C15.7712 4 17.6569 4 18.8284 5.17157C20 6.34315 20 8.22876 20 12C20 15.7712 20 17.6569 18.8284 18.8284Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 2V4M16 2V4M12 2V4M8 20V22M12 20V22M16 20V22M22 16H20M4 8H2M4 16H2M4 12H2M22 8H20M22 12H20"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11.4802 7.86193C11.6587 7.37936 12.3413 7.37936 12.5198 7.86193L13.3202 10.0248C13.4325 10.3283 13.6717 10.5675 13.9752 10.6798L16.1381 11.4802C16.6206 11.6587 16.6206 12.3413 16.1381 12.5198L13.9752 13.3202C13.6717 13.4325 13.4325 13.6717 13.3202 13.9752L12.5198 16.1381C12.3413 16.6206 11.6587 16.6206 11.4802 16.1381L10.6798 13.9752C10.5675 13.6717 10.3283 13.4325 10.0248 13.3202L7.86193 12.5198C7.37936 12.3413 7.37936 11.6587 7.86193 11.4802L10.0248 10.6798C10.3283 10.5675 10.5675 10.3283 10.6798 10.0248L11.4802 7.86193Z" />
    </svg>
  );
}

function PrivacySettingsNavIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      className="workspace-nav-icon"
      color="currentColor"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18.7088 3.49534C16.8165 2.55382 14.5009 2 12 2C9.4991 2 7.1835 2.55382 5.29116 3.49534C4.36318 3.95706 3.89919 4.18792 3.4496 4.91378C3 5.63965 3 6.34248 3 7.74814V11.2371C3 16.9205 7.54236 20.0804 10.173 21.4338C10.9067 21.8113 11.2735 22 12 22C12.7265 22 13.0933 21.8113 13.8269 21.4338C16.4576 20.0804 21 16.9205 21 11.2371L21 7.74814C21 6.34249 21 5.63966 20.5504 4.91378C20.1008 4.18791 19.6368 3.95706 18.7088 3.49534Z" />
      <path d="M8.5 14.4984C8.5 12.5654 10.067 10.9984 12 10.9984C13.933 10.9984 15.5 12.5654 15.5 14.4984M14 9C14 10.1046 13.1046 11 12 11C10.8954 11 10 10.1046 10 9C10 7.89543 10.8954 7 12 7C13.1046 7 14 7.89543 14 9Z" />
    </svg>
  );
}

function MembersNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.50012 3.70802C8.19389 3.57422 7.85567 3.5 7.50012 3.5C6.11941 3.5 5.00012 4.61929 5.00012 6C5.00012 6.8178 5.39279 7.54389 5.99988 8" />
      <path d="M3.37512 16.5C2.61573 16.5 2.00012 15.8588 2.00012 15.0677C2.00012 13.4585 3.66656 11.8492 6.50012 11.5402" />
      <path d="M15.4999 3.70753C15.8061 3.57374 16.1443 3.49951 16.4999 3.49951C17.8806 3.49951 18.9999 4.6188 18.9999 5.99951C18.9999 6.81731 18.6072 7.5434 18.0001 7.99951" />
      <path d="M20.6249 16.4995C21.3843 16.4995 21.9999 15.8582 21.9999 15.0672C21.9999 13.458 20.3335 11.8488 17.5001 11.5397" />
      <circle cx="12.0001" cy="8.5" r="3" />
      <path d="M12.0001 14.5C8.25012 14.5 6.00012 16.6429 6.00012 18.7857C6.00012 19.7325 6.67169 20.5 7.50012 20.5H16.5001C17.3285 20.5 18.0001 19.7325 18.0001 18.7857C18.0001 16.6429 15.7501 14.5 12.0001 14.5Z" />
    </svg>
  );
}

function LinearLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 100 100" width="20" height="20" fill="#5E6AD2">
      <path d="M1.225 61.523c-.222-.949.908-1.546 1.597-.857l36.512 36.512c.689.689.092 1.819-.857 1.597-18.425-4.323-32.93-18.827-37.252-37.252ZM.002 46.889a.99.99 0 0 0 .29.76L52.35 99.71a.99.99 0 0 0 .76.29c2.03-.132 4.023-.403 5.969-.805a.981.981 0 0 0 .466-1.655L2.462 40.454a.981.981 0 0 0-1.655.466 49.62 49.62 0 0 0-.805 5.969ZM4.21 29.705a.988.988 0 0 0 .185 1.145l64.755 64.755c.302.302.76.375 1.145.185a49.727 49.727 0 0 0 4.7-2.638.984.984 0 0 0 .16-1.528L8.376 24.845a.984.984 0 0 0-1.528.16 49.727 49.727 0 0 0-2.638 4.7ZM12.612 18.062a.99.99 0 0 1-.076-1.42C21.616 6.732 34.464.99 48.671.99 76.005.99 99.01 24.005 99.01 51.339c0 14.207-5.742 27.055-15.652 36.135a.99.99 0 0 1-1.42-.076L12.612 18.062Z" />
    </svg>
  );
}

function BackToAppIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-nav-icon settings-back-icon" fill="none">
      <path
        d="M15.75 19.5 8.25 12l7.5-7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function calendarProviderLabel(provider: CalendarProvider) {
  return provider === "google_calendar" ? "Google Calendar" : "Outlook Calendar";
}

function calendarConnectProviderLabel(provider: CalendarProvider) {
  return calendarProviderLabel(provider);
}

function CalendarProviderLogo({ provider }: { provider: CalendarProvider }) {
  if (provider === "google_calendar") {
    return <GoogleCalendarLogo className="workspace-calendar-provider-logo is-google-calendar-logo" />;
  }

  return <OutlookCalendarLogo />;
}

function accountEmail(account: CalendarAccount): string | null {
  if ("providerEmail" in account) {
    const providerEmail = account.providerEmail;
    if (typeof providerEmail === "string" && providerEmail.length > 0) {
      return providerEmail;
    }
  }
  if ("externalAccountEmail" in account) {
    const externalAccountEmail = account.externalAccountEmail;
    if (typeof externalAccountEmail === "string" && externalAccountEmail.length > 0) {
      return externalAccountEmail;
    }
  }

  return null;
}

function buildWorkspaceSettingsAvatarInitials(input: {
  displayNameDraft: string;
  sessionDisplayName: string | undefined;
  sessionEmail: string | undefined;
}): string {
  const source =
    input.displayNameDraft.length > 0
      ? input.displayNameDraft
      : input.sessionDisplayName !== undefined && input.sessionDisplayName.length > 0
        ? input.sessionDisplayName
        : input.sessionEmail !== undefined && input.sessionEmail.length > 0
          ? input.sessionEmail
          : SETTINGS_PAGE_COPY.defaultAvatarInitial;

  const initials = source
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, MAX_WORKSPACE_AVATAR_INITIALS)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials.length > 0 ? initials : SETTINGS_PAGE_COPY.defaultAvatarInitial;
}

function connectedCalendarProvidersFromAccounts(accounts: CalendarAccount[]) {
  return Array.from(
    new Set(accounts.filter((account) => account.status === "connected").map((account) => account.provider)),
  );
}

function settingsTabFromSearch(search: string): SettingsTab | null {
  const tab = new URLSearchParams(search).get("tab");
  // The billing tab was previously named 'usage'; keep old links working.
  if (tab === "usage") {
    return "billing";
  }
  if (tab === null || tab.length === 0) {
    return null;
  }

  return isSettingsTab(tab) ? tab : null;
}

function SettingsDeleteDialog({
  target,
  isPending,
  error,
  onCancel,
  onConfirm,
}: {
  target: DeleteTarget | null;
  isPending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (confirmationValue: string) => void;
}) {
  const [confirmationValue, setConfirmationValue] = useState("");
  const expectedValue = buildDeleteDialogExpectedValue(target);

  useEffect(() => {
    setConfirmationValue("");
  }, [target]);

  if (target === null || expectedValue === null || expectedValue.length === 0) {
    return null;
  }

  const title = buildDeleteDialogTitle(target);
  const body = buildDeleteDialogBody({ target, expectedValue });
  const actionLabel = buildDeleteDialogActionLabel(target);
  const isMatch =
    target.kind === "workspace"
      ? confirmationValue.trim() === expectedValue
      : confirmationValue.trim().toLowerCase() === expectedValue.toLowerCase();

  return (
    <div
      className="settings-confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPending) {
          onCancel();
        }
      }}
    >
      <section className="settings-confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <p>{body}</p>
        <label className="settings-confirm-label">
          <span>
            {SETTINGS_PAGE_COPY.deleteDialogTypeToConfirm}
            {expectedValue}
            {SETTINGS_PAGE_COPY.deleteDialogTypeToConfirmSuffix}
          </span>
          <input
            value={confirmationValue}
            disabled={isPending}
            onChange={(event) => setConfirmationValue(event.target.value)}
          />
        </label>
        {error !== null && error.length > 0 ? <p className="settings-error">{error}</p> : null}
        <div className="settings-confirm-actions">
          <button type="button" className="settings-secondary-button" disabled={isPending} onClick={onCancel}>
            {SETTINGS_PAGE_COPY.cancelLabel}
          </button>
          <button
            type="button"
            className="settings-danger-button"
            disabled={isPending || !isMatch}
            onClick={() => onConfirm(confirmationValue)}
          >
            {actionLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function SettingsTooltipAction({
  label,
  tooltip,
  className,
  isDisabled,
  onClick,
}: {
  label: string;
  tooltip: string;
  className: string;
  isDisabled?: boolean;
  onClick: () => void;
}) {
  const tooltipId = useId();

  return (
    <span className="settings-tooltip-action">
      <button type="button" className={className} aria-describedby={tooltipId} disabled={isDisabled} onClick={onClick}>
        {label}
      </button>
      <span id={tooltipId} role="tooltip" className="settings-tooltip">
        {tooltip}
      </span>
    </span>
  );
}

function CalendarAccountKindDropdown({
  account,
  isOpen,
  isDisabled,
  onOpenChange,
  onSelect,
}: {
  account: CalendarAccount;
  isOpen: boolean;
  isDisabled?: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onSelect: (accountKind: ProviderAccountKind) => void;
}) {
  return (
    <SettingsDropdown
      value={account.accountKind}
      options={CALENDAR_ACCOUNT_KIND_OPTIONS}
      isOpen={isOpen}
      ariaLabel="Calendar account type"
      isDisabled={isDisabled}
      onOpenChange={onOpenChange}
      onSelect={onSelect}
    />
  );
}

function LinearConnectorSettingsModal({
  workspaceName,
  onClose,
  onDisconnect,
}: {
  workspaceName: string | null;
  onClose: () => void;
  onDisconnect: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        className="private-beta-application-backdrop settings-modal-backdrop"
        aria-label={SETTINGS_PAGE_COPY.linearSettingsCloseAriaLabel}
        onClick={onClose}
      />
      <section
        className="slack-settings-modal connected-app-management-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="linear-settings-title"
      >
        <button
          type="button"
          className="workspace-settings-modal-close slack-settings-close"
          aria-label={SETTINGS_PAGE_COPY.linearSettingsCloseAriaLabel}
          onClick={onClose}
        >
          <span>{SETTINGS_PAGE_COPY.modalCloseIcon}</span>
        </button>
        <header className="slack-settings-header">
          <h2 id="linear-settings-title">{SETTINGS_PAGE_COPY.linearSettingsTitle}</h2>
          <p className="slack-settings-subtitle">
            {SETTINGS_PAGE_COPY.linearSettingsConnectedPrefix}
            {workspaceName !== null && workspaceName.length > 0
              ? SETTINGS_PAGE_COPY.linearSettingsConnectedToPrefix + workspaceName
              : ""}
            {SETTINGS_PAGE_COPY.linearSettingsConnectedSuffix}
          </p>
        </header>
        <div className="slack-settings-actions">
          <button type="button" className="settings-secondary-button slack-settings-disconnect" onClick={onDisconnect}>
            {SETTINGS_PAGE_COPY.linearSettingsDisconnect}
          </button>
          <button type="button" className="settings-secondary-button" onClick={onClose}>
            {SETTINGS_PAGE_COPY.linearSettingsDone}
          </button>
        </div>
      </section>
    </>
  );
}

type SettingsDeleteExecutionInput = {
  token: string;
  confirmationValue: string;
  queryClient: ReturnType<typeof useQueryClient>;
  showToast: ReturnType<typeof useToast>["showToast"];
  setError: (message: string | null) => void;
  setDeleteError: (message: string | null) => void;
  setPendingAction: (value: string | null | ((current: string | null) => string | null)) => void;
  setDeleteTarget: (value: DeleteTarget | null) => void;
  setCalendarAccounts: (value: CalendarAccount[] | ((current: CalendarAccount[]) => CalendarAccount[])) => void;
  setMyWorkspace: (
    value:
      | Awaited<ReturnType<typeof getMyWorkspace>>["workspace"]
      | null
      | ((
          current: Awaited<ReturnType<typeof getMyWorkspace>>["workspace"] | null,
        ) => Awaited<ReturnType<typeof getMyWorkspace>>["workspace"] | null),
  ) => void;
  refreshAccounts: () => Promise<void>;
  refreshSession: ReturnType<typeof useAuth>["refreshSession"];
  updateCachedUser: ReturnType<typeof useAuth>["updateCachedUser"];
  logout: () => Promise<void>;
  router: ReturnType<typeof useRouter>;
};

async function confirmSettingsCalendarDelete(input: {
  execution: SettingsDeleteExecutionInput;
  target: Extract<DeleteTarget, { kind: "calendar" }>;
  scopedCalendarAccounts: CalendarAccount[];
  userId: string;
}): Promise<void> {
  const { execution, target, scopedCalendarAccounts, userId } = input;
  const previousCalendarAccounts = scopedCalendarAccounts;
  const calendarEventsKey = calendarEventsQueryKey(userId);
  const previousCalendarEvents = execution.queryClient.getQueryData<CalendarEventsCache>(calendarEventsKey);
  const remainingCalendarAccounts = previousCalendarAccounts.filter((account) => account.id !== target.account.id);
  const remainingProviders = connectedCalendarProvidersFromAccounts(remainingCalendarAccounts);
  const remainingProviderSet = new Set<CalendarProvider>(remainingProviders);
  execution.setDeleteTarget(null);
  execution.setCalendarAccounts(remainingCalendarAccounts);
  setCachedCalendarConnectionProviders(userId, remainingProviders);
  execution.queryClient.setQueryData<CalendarEventsCache>(calendarEventsKey, (current) => {
    const events = (current?.events ?? []).filter(
      (event) => event.calendarAccountId !== target.account.id && remainingProviderSet.has(event.provider),
    );
    const remainingEventIds = new Set(events.map((event) => event.id));

    return {
      events,
      connectedProviders: remainingProviders,
      /** @external calendar events cache wire field */
      needsConnection: remainingProviders.length === 0,
      photoPermissionMissingProviders: (current?.photoPermissionMissingProviders ?? []).filter((provider) =>
        remainingProviderSet.has(provider),
      ),
      prepSummaries: (current?.prepSummaries ?? []).filter((summary) => remainingEventIds.has(summary.calendarEventId)),
    };
  });
  execution.queryClient.removeQueries({ queryKey: ["calendar-event-prep", userId] });
  try {
    await deleteCalendarAccountData({
      token: execution.token,
      accountId: target.account.id,
      input: {
        confirmationEmail: execution.confirmationValue,
      },
    });
    await execution.refreshAccounts();
    void execution.queryClient.invalidateQueries({ queryKey: calendarEventsKey });
    execution.showToast({
      id: "settings-delete-calendar-data",
      title: SETTINGS_PAGE_COPY.calendarDeletedTitle,
      message: SETTINGS_PAGE_COPY.calendarDeletedMessage,
      tone: "success",
    });
  } catch (nextError) {
    execution.setCalendarAccounts(previousCalendarAccounts);
    setCachedCalendarConnectionProviders(userId, connectedCalendarProvidersFromAccounts(previousCalendarAccounts));
    if (previousCalendarEvents !== undefined) {
      execution.queryClient.setQueryData(calendarEventsKey, previousCalendarEvents);
    } else {
      execution.queryClient.removeQueries({ queryKey: calendarEventsKey });
    }
    execution.setError(getApiErrorMessage({ error: nextError, fallback: "Could not delete calendar data." }));
    execution.showToast({
      id: "settings-delete-calendar-data-error",
      title: SETTINGS_PAGE_COPY.calendarDeleteFailedTitle,
      message: SETTINGS_PAGE_COPY.calendarDeleteFailedMessage,
      tone: "warning",
    });
  }
}

async function confirmSettingsWorkspaceDelete(input: {
  execution: SettingsDeleteExecutionInput;
  target: Extract<DeleteTarget, { kind: "workspace" }>;
}): Promise<void> {
  const { execution, target } = input;
  execution.setPendingAction("delete-target");
  execution.setDeleteTarget(null);
  try {
    const result = await deleteWorkspace({
      token: execution.token,
      workspaceId: target.id,
      input: {
        confirmationName: execution.confirmationValue,
      },
    });
    const nextSession = await syncActiveWorkspaceSession({
      token: execution.token,
      workspaceId: result.activeWorkspaceId,
      refreshSession: execution.refreshSession,
      updateCachedUser: execution.updateCachedUser,
    });
    if (nextSession === null) {
      const message = SETTINGS_PAGE_COPY.workspaceDeletedSessionSyncMessage;
      execution.setMyWorkspace(null);
      void execution.queryClient.invalidateQueries();
      execution.setError(message);
      execution.showToast({
        id: "settings-delete-workspace-session-sync-error",
        title: SETTINGS_PAGE_COPY.workspaceDeletedTitle,
        message,
        tone: "warning",
      });

      return;
    }
    execution.setMyWorkspace(null);
    void execution.queryClient.invalidateQueries();
    execution.showToast({
      id: "settings-delete-workspace",
      title: SETTINGS_PAGE_COPY.workspaceDeletedTitle,
      message: SETTINGS_PAGE_COPY.workspaceDeletedSwitchedMessage,
      tone: "success",
    });
    execution.router.push("/workspace");
  } catch (nextError) {
    const code = getApiErrorCode(nextError);
    const message = getApiErrorMessage({ error: nextError, fallback: "Could not delete workspace." });
    execution.setError(message);
    execution.showToast({
      id: "settings-delete-workspace-error",
      title:
        code === "workspace_subscription_active"
          ? SETTINGS_PAGE_COPY.workspaceDeleteCancelBillingTitle
          : SETTINGS_PAGE_COPY.workspaceDeleteFailedTitle,
      message,
      tone: "warning",
    });
  } finally {
    execution.setPendingAction(null);
  }
}

async function confirmSettingsReadyAccountDelete(input: { execution: SettingsDeleteExecutionInput }): Promise<void> {
  const { execution } = input;
  execution.setPendingAction("delete-target");
  execution.setDeleteTarget(null);
  try {
    await deleteReadyAccount({ token: execution.token, input: { confirmationEmail: execution.confirmationValue } });
    await execution.logout();
  } catch (nextError) {
    const code = getApiErrorCode(nextError);
    const message = getApiErrorMessage({ error: nextError, fallback: "Could not delete account." });
    execution.showToast({
      id: "settings-delete-account-error",
      title:
        code === "workspace_owner_transfer_required"
          ? SETTINGS_PAGE_COPY.accountDeleteTransferTitle
          : code === "account_subscription_active" || code === "account_checkout_pending"
            ? SETTINGS_PAGE_COPY.accountDeleteBillingTitle
            : SETTINGS_PAGE_COPY.accountDeleteFailedTitle,
      message,
      tone: "warning",
    });
  } finally {
    execution.setPendingAction(null);
  }
}

type WorkspaceSettingsOAuthEffectsInput = {
  pendingAction: string | null;
  linearPopupRef: { current: Window | null };
  setPendingAction: (value: string | null | ((current: string | null) => string | null)) => void;
  refreshConnectors: () => Promise<void>;
  showToast: ReturnType<typeof useToast>["showToast"];
  setError: (message: string | null) => void;
  completeSlackOAuth: (status: ConnectorOAuthStatus) => void;
  isCalendarProviderPickerOpen: boolean;
  calendarProviderPickerRef: { current: HTMLDivElement | null };
  setIsCalendarProviderPickerOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  refreshAccounts: () => Promise<void>;
};

function useWorkspaceSettingsLinearMessageEffect(input: WorkspaceSettingsOAuthEffectsInput) {
  const { refreshConnectors, setError, setPendingAction, showToast } = input;

  useEffect(() => {
    function handleLinearMessage(event: MessageEvent) {
      const apiOrigin = new URL(webEnv.NEXT_PUBLIC_API_BASE_URL).origin;
      if (event.origin !== apiOrigin) {
        return;
      }

      if (!isRecord(event.data)) {
        return;
      }
      const messageType = readMessageEventType(event.data);
      if (messageType === "readymeet.linear.connected") {
        setPendingAction(null);
        void runWithoutReject({
          operation: () => refreshConnectors(),
          onError: (nextError) => {
            setError(getApiErrorMessage({ error: nextError, fallback: "Could not load connectors." }));
          },
        });
        showToast({
          id: "settings-linear-connected",
          title: SETTINGS_PAGE_COPY.linearConnectedTitle,
          message: SETTINGS_PAGE_COPY.linearConnectedMessage,
          tone: "success",
        });
      } else if (messageType === "readymeet.linear.error") {
        setPendingAction(null);
        showToast({
          id: "settings-linear-error",
          title: SETTINGS_PAGE_COPY.linearConnectionFailedTitle,
          message: SETTINGS_PAGE_COPY.linearConnectionFailedMessage,
          tone: "warning",
        });
      }
    }

    window.addEventListener("message", handleLinearMessage);

    return () => {
      window.removeEventListener("message", handleLinearMessage);
    };
  }, [refreshConnectors, setError, setPendingAction, showToast]);
}

function useWorkspaceSettingsLinearSlackOAuthEffects(input: WorkspaceSettingsOAuthEffectsInput) {
  const { pendingAction, linearPopupRef, setPendingAction, refreshConnectors, showToast, setError } = input;

  useEffect(() => {
    if (pendingAction !== "linear-connect") {
      return;
    }

    const intervalId = window.setInterval(() => {
      const popup = linearPopupRef.current;
      const isClosed = (() => {
        try {
          return popup === null || popup.closed;
        } catch (error) {
          ignoreCaughtFailure(error);

          return true;
        }
      })();
      if (isClosed) {
        linearPopupRef.current = null;
        setPendingAction((current) => (current === "linear-connect" ? null : current));
        void runWithoutReject({ operation: () => refreshConnectors() });
      }
    }, CONNECTOR_RETRY_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [linearPopupRef, pendingAction, refreshConnectors, setPendingAction]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const url = new URL(window.location.href);
    const linearStatus = url.searchParams.get("linear");
    if (linearStatus !== "connected" && linearStatus !== "error") {
      return;
    }

    url.searchParams.delete("linear");
    window.history.replaceState(null, "", url);

    if (window.name === LINEAR_OAUTH_POPUP_NAME) {
      try {
        const channel = new BroadcastChannel(LINEAR_OAUTH_CHANNEL);
        channel.postMessage({ type: "linear-oauth", status: linearStatus });
        channel.close();
      } catch (error) {
        ignoreCaughtFailure(error);
      }
      window.close();

      return;
    }

    setPendingAction((current) => (current === "linear-connect" ? null : current));
    void runWithoutReject({ operation: () => refreshConnectors() });
  }, [refreshConnectors, setPendingAction]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return;
    }

    const channel = new BroadcastChannel(LINEAR_OAUTH_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const status = readConnectorOAuthStatus(event.data);
      if (status === null) {
        return;
      }
      setPendingAction((current) => (current === "linear-connect" ? null : current));
      if (status === "connected") {
        void runWithoutReject({
          operation: () => refreshConnectors(),
          onError: (nextError) => {
            setError(getApiErrorMessage({ error: nextError, fallback: "Could not load connectors." }));
          },
        });
        showToast({
          id: "settings-linear-connected",
          title: SETTINGS_PAGE_COPY.linearConnectedTitle,
          message: SETTINGS_PAGE_COPY.linearConnectedMessage,
          tone: "success",
        });
      } else {
        showToast({
          id: "settings-linear-error",
          title: SETTINGS_PAGE_COPY.linearConnectionFailedTitle,
          message: SETTINGS_PAGE_COPY.linearConnectionFailedMessage,
          tone: "warning",
        });
      }
    };

    return () => {
      channel.close();
    };
  }, [refreshConnectors, setError, setPendingAction, showToast]);
}

function useWorkspaceSettingsSlackOAuthEffects(input: WorkspaceSettingsOAuthEffectsInput) {
  const { completeSlackOAuth } = input;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const url = new URL(window.location.href);
    const slackStatus = url.searchParams.get("slack");
    if (slackStatus !== "connected" && slackStatus !== "error") {
      return;
    }

    url.searchParams.delete("slack");
    window.history.replaceState(null, "", url);

    if (window.name === SLACK_OAUTH_POPUP_NAME) {
      try {
        const channel = new BroadcastChannel(SLACK_OAUTH_CHANNEL);
        channel.postMessage({ type: "slack-oauth", status: slackStatus });
        channel.close();
      } catch (error) {
        ignoreCaughtFailure(error);
      }
      window.close();

      return;
    }

    completeSlackOAuth(slackStatus);
  }, [completeSlackOAuth]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return;
    }

    const channel = new BroadcastChannel(SLACK_OAUTH_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const status = readConnectorOAuthStatus(event.data);
      if (status === null) {
        return;
      }
      completeSlackOAuth(status);
    };

    return () => {
      channel.close();
    };
  }, [completeSlackOAuth]);

  useEffect(() => {
    function handleSlackMessage(event: MessageEvent) {
      const apiOrigin = new URL(webEnv.NEXT_PUBLIC_API_BASE_URL).origin;
      if (event.origin !== apiOrigin) {
        return;
      }

      const messageType = readMessageEventType(event.data);
      if (messageType === "readymeet.slack.connected") {
        completeSlackOAuth("connected");
      } else if (messageType === "readymeet.slack.error") {
        completeSlackOAuth("error");
      }
    }

    window.addEventListener("message", handleSlackMessage);

    return () => {
      window.removeEventListener("message", handleSlackMessage);
    };
  }, [completeSlackOAuth]);
}

function useWorkspaceSettingsProviderPickerEffects(input: WorkspaceSettingsOAuthEffectsInput) {
  const { isCalendarProviderPickerOpen, calendarProviderPickerRef, setIsCalendarProviderPickerOpen } = input;

  useEffect(() => {
    if (!isCalendarProviderPickerOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Node) || calendarProviderPickerRef.current?.contains(event.target) === true) {
        return;
      }
      setIsCalendarProviderPickerOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [calendarProviderPickerRef, isCalendarProviderPickerOpen, setIsCalendarProviderPickerOpen]);
}

function useWorkspaceSettingsCalendarOAuthMessageEffect(input: WorkspaceSettingsOAuthEffectsInput) {
  const { refreshAccounts, setError, setIsCalendarProviderPickerOpen, setPendingAction, showToast } = input;

  useEffect(() => {
    function handleCalendarMessage(event: MessageEvent) {
      const apiOrigin = new URL(webEnv.NEXT_PUBLIC_API_BASE_URL).origin;
      if (event.origin !== apiOrigin) {
        return;
      }

      if (!isRecord(event.data)) {
        return;
      }
      const messageType = readMessageEventType(event.data);
      const messageProvider = isCalendarProviderValue(event.data.provider) ? event.data.provider : undefined;
      if (messageType === "readymeet.calendar.connected") {
        setPendingAction(null);
        setIsCalendarProviderPickerOpen(false);
        void runWithoutReject({
          operation: () => refreshAccounts(),
          onError: (nextError) => {
            setError(getApiErrorMessage({ error: nextError, fallback: "Could not load connected accounts." }));
          },
        });
        const connectedProvider = messageProvider ?? "google_calendar";
        showToast({
          id: `settings-calendar-connected:${messageProvider ?? "calendar"}`,
          title: SETTINGS_PAGE_COPY.calendarConnectedTitle,
          message: buildCalendarConnectedToastMessage(connectedProvider),
          tone: "success",
        });
      } else if (messageType === "readymeet.calendar.error") {
        setPendingAction(null);
        showToast({
          id: `settings-calendar-error:${messageProvider ?? "calendar"}`,
          title: SETTINGS_PAGE_COPY.calendarConnectionFailedTitle,
          message: SETTINGS_PAGE_COPY.calendarConnectionFailedMessage,
          tone: "warning",
        });
      }
    }

    window.addEventListener("message", handleCalendarMessage);

    return () => {
      window.removeEventListener("message", handleCalendarMessage);
    };
  }, [refreshAccounts, setError, setIsCalendarProviderPickerOpen, setPendingAction, showToast]);
}

function useWorkspaceSettingsOAuthEffects(input: WorkspaceSettingsOAuthEffectsInput) {
  useWorkspaceSettingsLinearSlackOAuthEffects(input);
  useWorkspaceSettingsLinearMessageEffect(input);
  useWorkspaceSettingsSlackOAuthEffects(input);
  useWorkspaceSettingsProviderPickerEffects(input);
  useWorkspaceSettingsCalendarOAuthMessageEffect(input);
}

type WorkspaceSettingsPageHandlersInput = {
  session: ReturnType<typeof useAuth>["session"];
  linearPopupRef: { current: Window | null };
  linearConnector: AgentConnectorInfo | null;
  slackConnector: AgentConnectorInfo | null;
  /** @external ref wire */
  slackOAuthCompletionHandledGuard: {
    /** @external ref wire */
    current: boolean;
  };
  setLinearConnector: (value: AgentConnectorInfo | null) => void;
  setSlackConnector: (value: AgentConnectorInfo | null) => void;
  setIsLinearSettingsOpen: (value: boolean) => void;
  setIsSlackSettingsOpen: (value: boolean) => void;
  setPendingAction: (value: string | null | ((current: string | null) => string | null)) => void;
  setError: (message: string | null) => void;
  refreshConnectors: () => Promise<void>;
  refreshAccounts: () => Promise<void>;
  showToast: ReturnType<typeof useToast>["showToast"];
  setIsCalendarProviderPickerOpen: (value: boolean) => void;
  setOpenCalendarKindAccountId: (value: string | null) => void;
  setCalendarAccounts: (value: CalendarAccount[] | ((current: CalendarAccount[]) => CalendarAccount[])) => void;
  deleteTarget: DeleteTarget | null;
  setDeleteTarget: (value: DeleteTarget | null) => void;
  setDeleteError: (message: string | null) => void;
  scopedCalendarAccounts: CalendarAccount[];
  setMyWorkspace: (
    value:
      | Awaited<ReturnType<typeof getMyWorkspace>>["workspace"]
      | null
      | ((
          current: Awaited<ReturnType<typeof getMyWorkspace>>["workspace"] | null,
        ) => Awaited<ReturnType<typeof getMyWorkspace>>["workspace"] | null),
  ) => void;
  queryClient: ReturnType<typeof useQueryClient>;
  refreshSession: ReturnType<typeof useAuth>["refreshSession"];
  updateCachedUser: ReturnType<typeof useAuth>["updateCachedUser"];
  logout: () => Promise<void>;
  router: ReturnType<typeof useRouter>;
};

function useWorkspaceSettingsPageLinearConnectorHandlers(
  input: Pick<
    WorkspaceSettingsPageHandlersInput,
    | "session"
    | "linearPopupRef"
    | "linearConnector"
    | "setLinearConnector"
    | "setIsLinearSettingsOpen"
    | "setPendingAction"
    | "setError"
    | "refreshConnectors"
  >,
) {
  const {
    session,
    linearPopupRef,
    linearConnector,
    setLinearConnector,
    setIsLinearSettingsOpen,
    setPendingAction,
    setError,
    refreshConnectors,
  } = input;

  const startLinearConnect = async () => {
    const token = session?.token;
    if (token === undefined || token.length === 0) {
      return;
    }
    setPendingAction("linear-connect");
    setError(null);
    const popup = window.open(
      "about:blank",
      LINEAR_OAUTH_POPUP_NAME,
      "popup=yes,width=620,height=760,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes",
    );
    linearPopupRef.current = popup;
    try {
      const authorizationUrl = await connectLinear({
        token,
        input: {
          returnTo: window.location.href,
        },
      });
      if (!popup) {
        window.location.assign(authorizationUrl);

        return;
      }
      popup.location.href = authorizationUrl;
      popup.focus();
    } catch (nextError) {
      popup?.close();
      linearPopupRef.current = null;
      setError(getApiErrorMessage({ error: nextError, fallback: "Could not start Linear connection." }));
      setPendingAction(null);
    }
  };

  const handleLinearDisconnect = async () => {
    const token = session?.token;
    if (token === undefined || token.length === 0) {
      return;
    }
    const previousConnector = linearConnector;
    setLinearConnector(null);
    setIsLinearSettingsOpen(false);
    setError(null);
    try {
      await disconnectLinear(token);
      void runWithoutReject({ operation: () => refreshConnectors() });
    } catch (nextError) {
      setLinearConnector(previousConnector);
      setError(getApiErrorMessage({ error: nextError, fallback: "Could not disconnect Linear." }));
    }
  };

  return { startLinearConnect, handleLinearDisconnect };
}

function useWorkspaceSettingsPageSlackConnectorHandlers(
  input: Pick<
    WorkspaceSettingsPageHandlersInput,
    | "session"
    | "slackConnector"
    | "slackOAuthCompletionHandledGuard"
    | "setSlackConnector"
    | "setIsSlackSettingsOpen"
    | "setPendingAction"
    | "setError"
    | "refreshConnectors"
  >,
) {
  const {
    session,
    slackConnector,
    slackOAuthCompletionHandledGuard,
    setSlackConnector,
    setIsSlackSettingsOpen,
    setPendingAction,
    setError,
    refreshConnectors,
  } = input;

  const startSlackConnect = async () => {
    const token = session?.token;
    if (token === undefined || token.length === 0) {
      return;
    }
    slackOAuthCompletionHandledGuard.current = false;
    setPendingAction("slack-connect");
    setError(null);
    const popup = window.open(
      "about:blank",
      SLACK_OAUTH_POPUP_NAME,
      "popup=yes,width=620,height=760,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes",
    );
    try {
      const authorizationUrl = await connectSlack({
        token,
        input: {
          returnTo: window.location.href,
        },
      });
      if (!popup) {
        window.location.assign(authorizationUrl);

        return;
      }
      popup.location.href = authorizationUrl;
      popup.focus();
    } catch (nextError) {
      popup?.close();
      setError(getApiErrorMessage({ error: nextError, fallback: "Could not start Slack connection." }));
      setPendingAction(null);
    }
  };

  const handleSlackDisconnect = async () => {
    const token = session?.token;
    if (token === undefined || token.length === 0) {
      return;
    }
    const previousConnector = slackConnector;
    setSlackConnector(null);
    setIsSlackSettingsOpen(false);
    setError(null);
    try {
      await disconnectSlack(token);
      void runWithoutReject({ operation: () => refreshConnectors() });
    } catch (nextError) {
      setSlackConnector(previousConnector);
      setError(getApiErrorMessage({ error: nextError, fallback: "Could not disconnect Slack." }));
    }
  };

  return { startSlackConnect, handleSlackDisconnect };
}

function useWorkspaceSettingsPageConnectorHandlers(input: WorkspaceSettingsPageHandlersInput) {
  const linearHandlers = useWorkspaceSettingsPageLinearConnectorHandlers(input);
  const slackHandlers = useWorkspaceSettingsPageSlackConnectorHandlers(input);

  return { ...linearHandlers, ...slackHandlers };
}

function useWorkspaceSettingsPageCalendarActionHandlers(
  input: Pick<
    WorkspaceSettingsPageHandlersInput,
    | "session"
    | "setPendingAction"
    | "setError"
    | "setIsCalendarProviderPickerOpen"
    | "setOpenCalendarKindAccountId"
    | "setCalendarAccounts"
    | "showToast"
  >,
) {
  const {
    session,
    setPendingAction,
    setError,
    setIsCalendarProviderPickerOpen,
    setOpenCalendarKindAccountId,
    setCalendarAccounts,
    showToast,
  } = input;

  const startCalendarConnect = async (provider: CalendarProvider) => {
    const token = session?.token;
    if (token === undefined || token.length === 0) {
      return;
    }
    setIsCalendarProviderPickerOpen(false);
    setPendingAction(`calendar-connect:${provider}`);
    setError(null);
    const popup = window.open(
      "about:blank",
      `readymeet-calendar-oauth-${provider}`,
      "popup=yes,width=620,height=760,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes",
    );
    try {
      const authorizationUrl = await connectCalendar({
        token,
        input: {
          provider,
          returnTo: window.location.href,
        },
      });
      if (!popup) {
        window.location.assign(authorizationUrl);

        return;
      }
      popup.location.href = authorizationUrl;
      popup.focus();
    } catch (nextError) {
      popup?.close();
      setError(getApiErrorMessage({ error: nextError, fallback: "Could not start calendar connection." }));
      setPendingAction(null);
    }
  };

  const handleCalendarKindChange = async (kindInput: {
    account: CalendarAccount;
    accountKind: ProviderAccountKind;
  }) => {
    const token = session?.token;
    if (token === undefined || token.length === 0) {
      return;
    }
    const { account, accountKind } = kindInput;
    setOpenCalendarKindAccountId(null);
    setPendingAction(`calendar-kind:${account.id}`);
    setError(null);
    try {
      const updated = await updateCalendarAccount({
        token,
        accountId: account.id,
        input: { accountKind },
      });
      setCalendarAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      showToast({
        id: `calendar-kind:${account.id}`,
        title: SETTINGS_PAGE_COPY.calendarUpdatedTitle,
        message: SETTINGS_PAGE_COPY.calendarUpdatedMessage,
        tone: "success",
      });
    } catch (nextError) {
      setError(getApiErrorMessage({ error: nextError, fallback: "Could not update calendar account." }));
    } finally {
      setPendingAction(null);
    }
  };

  return { startCalendarConnect, handleCalendarKindChange };
}

function useWorkspaceSettingsPageProviderActionHandlers(input: WorkspaceSettingsPageHandlersInput) {
  return useWorkspaceSettingsPageCalendarActionHandlers(input);
}

function useWorkspaceSettingsPageAccountDeletionHandlers(input: WorkspaceSettingsPageHandlersInput) {
  const {
    session,
    setPendingAction,
    setError,
    deleteTarget,
    setDeleteTarget,
    setDeleteError,
    scopedCalendarAccounts,
    setCalendarAccounts,
    setMyWorkspace,
    queryClient,
    showToast,
    refreshAccounts,
    refreshSession,
    updateCachedUser,
    logout,
    router,
  } = input;

  const handleLogoutAllDevices = async () => {
    const token = session?.token;
    if (token === undefined || token.length === 0) {
      return;
    }
    setPendingAction("logout-all");
    setError(null);
    try {
      await logoutAllDevices(token);
      await logout();
    } catch (nextError) {
      setError(getApiErrorMessage({ error: nextError, fallback: "Could not log out all devices." }));
      setPendingAction(null);
    }
  };

  const confirmDelete = async (confirmationValue: string) => {
    const token = session?.token;
    if (session === null || token === undefined || token.length === 0 || deleteTarget === null) {
      return;
    }
    const currentTarget = deleteTarget;
    setDeleteError(null);
    const execution: SettingsDeleteExecutionInput = {
      token,
      confirmationValue,
      queryClient,
      showToast,
      setError,
      setDeleteError,
      setPendingAction,
      setDeleteTarget,
      setCalendarAccounts,
      setMyWorkspace,
      refreshAccounts,
      refreshSession,
      updateCachedUser,
      logout,
      router,
    };

    if (currentTarget.kind === "calendar") {
      await confirmSettingsCalendarDelete({
        execution,
        target: currentTarget,
        scopedCalendarAccounts,
        userId: session.user.id,
      });

      return;
    }

    if (currentTarget.kind === "workspace") {
      await confirmSettingsWorkspaceDelete({
        execution,
        target: currentTarget,
      });

      return;
    }

    await confirmSettingsReadyAccountDelete({ execution });
  };

  // Ends only this browser's session; other devices and tabs stay signed in.
  const handleLogout = async () => {
    setPendingAction("logout");
    await logout();
  };

  return {
    handleLogout,
    handleLogoutAllDevices,
    confirmDelete,
  };
}

function useWorkspaceSettingsPageHandlers(input: WorkspaceSettingsPageHandlersInput) {
  return {
    ...useWorkspaceSettingsPageConnectorHandlers(input),
    ...useWorkspaceSettingsPageProviderActionHandlers(input),
    ...useWorkspaceSettingsPageAccountDeletionHandlers(input),
  };
}

function useWorkspaceSettingsPageProviderIntegrationState(session: ReturnType<typeof useAuth>["session"]) {
  const [calendarAccounts, setCalendarAccounts] = useState<CalendarAccount[]>([]);
  const [providerAccountsUserId, setProviderAccountsUserId] = useState<string | null>(null);
  const [linearConnector, setLinearConnector] = useState<AgentConnectorInfo | null>(null);
  const [slackConnector, setSlackConnector] = useState<AgentConnectorInfo | null>(null);
  const [isLinearSettingsOpen, setIsLinearSettingsOpen] = useState(false);
  const [isSlackSettingsOpen, setIsSlackSettingsOpen] = useState(false);
  const [isCalendarProviderPickerOpen, setIsCalendarProviderPickerOpen] = useState(false);
  const [openCalendarKindAccountId, setOpenCalendarKindAccountId] = useState<string | null>(null);
  const calendarProviderPickerRef = useRef<HTMLDivElement | null>(null);
  const linearPopupRef = useRef<Window | null>(null);
  const slackOAuthCompletionHandledRef = useRef(false);
  const displayNameSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestDisplayNameSaveRef = useRef(0);
  const providerAccountLoadIdRef = useRef(0);
  const providerAccountLoadScopeRef = useRef<ProviderAccountLoadScope | null>(null);
  const providerAccountSessionScope = {
    token: session?.token ?? null,
    userId: session?.user.id ?? null,
  };
  const providerAccountSessionScopeRef = useRef(providerAccountSessionScope);
  useLayoutEffect(() => {
    providerAccountSessionScopeRef.current = providerAccountSessionScope;
  });
  const scopedCalendarAccounts = providerAccountsUserId === session?.user.id ? calendarAccounts : [];

  return {
    calendarAccounts,
    setCalendarAccounts,
    providerAccountsUserId,
    setProviderAccountsUserId,
    linearConnector,
    setLinearConnector,
    slackConnector,
    setSlackConnector,
    isLinearSettingsOpen,
    setIsLinearSettingsOpen,
    isSlackSettingsOpen,
    setIsSlackSettingsOpen,
    isCalendarProviderPickerOpen,
    setIsCalendarProviderPickerOpen,
    openCalendarKindAccountId,
    setOpenCalendarKindAccountId,
    calendarProviderPickerRef,
    linearPopupRef,
    slackOAuthCompletionHandledRef,
    displayNameSaveQueueRef,
    latestDisplayNameSaveRef,
    providerAccountLoadIdRef,
    providerAccountLoadScopeRef,
    providerAccountSessionScopeRef,
    scopedCalendarAccounts,
  };
}

function useWorkspaceSettingsPageSessionState() {
  const { session, logout, refreshSession, updateCachedUser } = useAuth();
  const { showToast } = useToast();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const integration = useWorkspaceSettingsPageProviderIntegrationState(session);
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const [returnLocation, setReturnLocation] = useState({ scope: "", href: "/workspace" });
  const sessionUserId = session?.user.id;
  const sessionWorkspaceId = session?.user.workspaceId;
  const returnScope =
    sessionUserId !== undefined && sessionWorkspaceId !== undefined ? `${sessionUserId}:${sessionWorkspaceId}` : "";
  const [isThemeDropdownOpen, setIsThemeDropdownOpen] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [myWorkspace, setMyWorkspace] = useState<Awaited<ReturnType<typeof getMyWorkspace>>["workspace"] | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const workspacePermissions = myWorkspace
    ? workspaceSettingsPermissions({
        role: myWorkspace.role,
        status: myWorkspace.status,
      })
    : null;
  const isWorkspaceOwner = workspacePermissions?.canManageBilling ?? false;
  const isWorkspaceManager = workspacePermissions?.canManageWorkspace ?? false;

  const avatarInitials = useMemo(
    () =>
      buildWorkspaceSettingsAvatarInitials({
        displayNameDraft,
        sessionDisplayName: session?.user.displayName,
        sessionEmail: session?.user.email,
      }),
    [displayNameDraft, session?.user.displayName, session?.user.email],
  );

  const selectSettingsTab = useCallback((tab: SettingsTab) => {
    setActiveTab(tab);
    if (typeof window === "undefined") {
      return;
    }

    const url = new URL(window.location.href);
    if (tab === "account") {
      url.searchParams.delete("tab");
    } else {
      url.searchParams.set("tab", tab);
    }
    window.history.replaceState(null, "", url);
  }, []);

  const handleViewerWorkspaceRoleChanged = useCallback((role: "owner" | "admin" | "member") => {
    setMyWorkspace((current) => (current ? { ...current, role } : current));
  }, []);

  return {
    ...integration,
    session,
    logout,
    refreshSession,
    updateCachedUser,
    showToast,
    theme,
    setTheme,
    router,
    queryClient,
    activeTab,
    setActiveTab,
    returnLocation,
    setReturnLocation,
    sessionUserId,
    sessionWorkspaceId,
    returnScope,
    isThemeDropdownOpen,
    setIsThemeDropdownOpen,
    displayNameDraft,
    setDisplayNameDraft,
    myWorkspace,
    setMyWorkspace,
    pendingAction,
    setPendingAction,
    error,
    setError,
    deleteTarget,
    setDeleteTarget,
    deleteError,
    setDeleteError,
    isWorkspaceOwner,
    isWorkspaceManager,
    avatarInitials,
    selectSettingsTab,
    handleViewerWorkspaceRoleChanged,
  };
}

function useWorkspaceSettingsPageSessionAccountLifecycle(
  state: ReturnType<typeof useWorkspaceSettingsPageSessionState>,
) {
  const {
    session,
    sessionUserId,
    sessionWorkspaceId,
    returnScope,
    setReturnLocation,
    setDisplayNameDraft,
    providerAccountLoadIdRef,
    providerAccountLoadScopeRef,
    setProviderAccountsUserId,
    setCalendarAccounts,
    setDeleteTarget,
    setOpenCalendarKindAccountId,
    setMyWorkspace,
  } = state;

  useEffect(() => {
    if (sessionUserId === undefined || sessionWorkspaceId === undefined) {
      return;
    }
    const href = (() => {
      try {
        return readWorkspaceReturnLocation({
          storage: window.sessionStorage,
          userId: sessionUserId,
          workspaceId: sessionWorkspaceId,
        });
      } catch (error) {
        ignoreCaughtFailure(error);

        return "/workspace";
      }
    })();
    setReturnLocation({ scope: returnScope, href });
  }, [sessionUserId, sessionWorkspaceId, returnScope, setReturnLocation]);

  useEffect(() => {
    setDisplayNameDraft(session?.user.displayName ?? "");
  }, [session?.user.displayName, session?.user.id, setDisplayNameDraft]);

  useEffect(() => {
    providerAccountLoadIdRef.current += 1;
    providerAccountLoadScopeRef.current = null;
    setProviderAccountsUserId(null);
    setCalendarAccounts([]);
    setDeleteTarget(null);
    setOpenCalendarKindAccountId(null);
  }, [
    session?.user.id,
    providerAccountLoadIdRef,
    providerAccountLoadScopeRef,
    setProviderAccountsUserId,
    setCalendarAccounts,
    setDeleteTarget,
    setOpenCalendarKindAccountId,
  ]);

  useEffect(() => {
    const token = session?.token;
    if (session === null || token === undefined || token.length === 0 || session.user.source === "guest") {
      setMyWorkspace(null);

      return;
    }
    const request = { isCancelled: false };
    void (async () => {
      try {
        const payload = await getMyWorkspace(token);
        if (!request.isCancelled) {
          setMyWorkspace(payload.workspace);
        }
      } catch (error) {
        ignoreCaughtFailure(error);
      }
    })();

    return () => {
      request.isCancelled = true;
    };
  }, [session?.token, session?.user.source, setMyWorkspace]);
}

function useWorkspaceSettingsPageSessionNavigationLifecycle(
  state: ReturnType<typeof useWorkspaceSettingsPageSessionState>,
) {
  const { setActiveTab, activeTab, myWorkspace, isWorkspaceOwner, isWorkspaceManager, selectSettingsTab } = state;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const syncTabFromUrl = () => {
      const nextTab = settingsTabFromSearch(window.location.search);
      if (nextTab !== null) {
        setActiveTab(nextTab);
      }
    };

    syncTabFromUrl();
    window.addEventListener("popstate", syncTabFromUrl);

    return () => window.removeEventListener("popstate", syncTabFromUrl);
  }, [setActiveTab]);

  useEffect(() => {
    if (!myWorkspace) {
      return;
    }
    const isBillingTabRestricted = activeTab === "billing" && !isWorkspaceOwner;
    const isWorkspaceTabRestricted = activeTab === "workspace" && !isWorkspaceManager;
    if (isBillingTabRestricted || isWorkspaceTabRestricted) {
      selectSettingsTab("members");
    }
  }, [activeTab, isWorkspaceManager, isWorkspaceOwner, myWorkspace, selectSettingsTab]);
}

function useWorkspaceSettingsPageSessionLifecycle(state: ReturnType<typeof useWorkspaceSettingsPageSessionState>) {
  useWorkspaceSettingsPageSessionAccountLifecycle(state);
  useWorkspaceSettingsPageSessionNavigationLifecycle(state);
}

function useWorkspaceSettingsPageSessionCore() {
  const state = useWorkspaceSettingsPageSessionState();
  useWorkspaceSettingsPageSessionLifecycle(state);

  return state;
}

function useWorkspaceSettingsPageRemoteRefresh(core: ReturnType<typeof useWorkspaceSettingsPageSessionCore>) {
  const {
    session,
    setCalendarAccounts,
    setLinearConnector,
    setSlackConnector,
    setProviderAccountsUserId,
    providerAccountLoadIdRef,
    providerAccountLoadScopeRef,
    providerAccountSessionScopeRef,
  } = core;

  const refreshAccounts = useCallback(async () => {
    const token = session?.token;
    const userId = session?.user.id;
    if (token === undefined || token.length === 0 || userId === undefined || userId.length === 0) {
      return;
    }
    const request = {
      requestId: providerAccountLoadIdRef.current + 1,
      token,
      userId,
    };
    providerAccountLoadIdRef.current = request.requestId;
    providerAccountLoadScopeRef.current = request;
    const nextCalendarAccounts = await listCalendarAccounts(token);
    const currentSession = providerAccountSessionScopeRef.current;
    if (
      currentSession.token !== request.token ||
      currentSession.userId !== request.userId ||
      !isCurrentProviderAccountLoad({ request, current: providerAccountLoadScopeRef.current })
    ) {
      return;
    }
    setCalendarAccounts(providerAccountsForUser({ accounts: nextCalendarAccounts, userId }));
    setProviderAccountsUserId(userId);
  }, [session?.token, session?.user.id]);

  const refreshConnectors = useCallback(async () => {
    const token = session?.token;
    if (token === undefined || token.length === 0) {
      return;
    }
    const settings = await getMyAgentSettings({ token });
    setLinearConnector(settings.connectors.find((connector) => connector.provider === "linear") ?? null);
    setSlackConnector(settings.connectors.find((connector) => connector.provider === "slack") ?? null);
  }, [session?.token, setLinearConnector, setSlackConnector]);

  return {
    refreshAccounts,
    refreshConnectors,
  };
}

function useWorkspaceSettingsPageSlackOAuthCompletion(input: {
  core: ReturnType<typeof useWorkspaceSettingsPageSessionCore>;
  refreshConnectors: () => Promise<void>;
}) {
  const { core, refreshConnectors } = input;
  const { showToast, setError, setIsSlackSettingsOpen, setPendingAction, slackOAuthCompletionHandledRef } = core;

  return useCallback(
    (status: "connected" | "error") => {
      if (slackOAuthCompletionHandledRef.current) {
        return;
      }
      slackOAuthCompletionHandledRef.current = true;
      setPendingAction((current) => (current === "slack-connect" ? null : current));
      if (status === "connected") {
        void runWithoutReject({
          operation: () => refreshConnectors(),
          onError: (nextError) => {
            setError(getApiErrorMessage({ error: nextError, fallback: "Could not load connectors." }));
          },
        });
        setIsSlackSettingsOpen(true);
        showToast({
          id: "settings-slack-connected",
          title: SETTINGS_PAGE_COPY.slackConnectedTitle,
          message: SETTINGS_PAGE_COPY.slackConnectedMessage,
          tone: "success",
        });
      } else {
        showToast({
          id: "settings-slack-error",
          title: SETTINGS_PAGE_COPY.slackConnectionFailedTitle,
          message: SETTINGS_PAGE_COPY.slackConnectionFailedMessage,
          tone: "warning",
        });
      }
    },
    [refreshConnectors, setError, setIsSlackSettingsOpen, setPendingAction, showToast, slackOAuthCompletionHandledRef],
  );
}

function useWorkspaceSettingsPageDisplayNameSave(core: ReturnType<typeof useWorkspaceSettingsPageSessionCore>) {
  const { session, updateCachedUser, setError, displayNameSaveQueueRef, latestDisplayNameSaveRef } = core;

  return useCallback(
    (nextDisplayName: string) => {
      const displayName = nextDisplayName.trim();
      const token = session?.token;
      if (token === undefined || token.length === 0 || displayName.length === 0) {
        return;
      }

      const saveId = latestDisplayNameSaveRef.current + 1;
      latestDisplayNameSaveRef.current = saveId;
      const previousSave = displayNameSaveQueueRef.current;
      displayNameSaveQueueRef.current = (async () => {
        try {
          await previousSave;
        } catch (previousError) {
          ignoreCaughtFailure(previousError);
        }
        try {
          const updatedUser = await updateUserProfile({ token, input: { displayName } });
          if (saveId === latestDisplayNameSaveRef.current) {
            await updateCachedUser({ user: updatedUser });
          }
        } catch (nextError) {
          if (saveId === latestDisplayNameSaveRef.current) {
            setError(getApiErrorMessage({ error: nextError, fallback: "Could not save full name." }));
          }
        }
      })();
    },
    [session, updateCachedUser, setError, displayNameSaveQueueRef, latestDisplayNameSaveRef],
  );
}

function useWorkspaceSettingsPageRemoteActions(core: ReturnType<typeof useWorkspaceSettingsPageSessionCore>) {
  const refresh = useWorkspaceSettingsPageRemoteRefresh(core);
  const completeSlackOAuth = useWorkspaceSettingsPageSlackOAuthCompletion({
    core,
    refreshConnectors: refresh.refreshConnectors,
  });
  const saveDisplayName = useWorkspaceSettingsPageDisplayNameSave(core);

  return {
    ...refresh,
    completeSlackOAuth,
    saveDisplayName,
  };
}

function useWorkspaceSettingsPageRemoteSync(core: ReturnType<typeof useWorkspaceSettingsPageSessionCore>) {
  const {
    setError,
    linearPopupRef,
    setPendingAction,
    isCalendarProviderPickerOpen,
    calendarProviderPickerRef,
    setIsCalendarProviderPickerOpen,
    pendingAction,
    showToast,
  } = core;
  const remoteActions = useWorkspaceSettingsPageRemoteActions(core);

  useEffect(() => {
    void runWithoutReject({
      operation: () => remoteActions.refreshAccounts(),
      onError: (nextError) => {
        setError(getApiErrorMessage({ error: nextError, fallback: "Could not load connected accounts." }));
      },
    });
  }, [remoteActions.refreshAccounts, setError]);

  useEffect(() => {
    void runWithoutReject({
      operation: () => remoteActions.refreshConnectors(),
      onError: (nextError) => {
        setError(getApiErrorMessage({ error: nextError, fallback: "Could not load connectors." }));
      },
    });
  }, [remoteActions.refreshConnectors, setError]);

  useWorkspaceSettingsOAuthEffects({
    pendingAction,
    linearPopupRef,
    setPendingAction,
    refreshConnectors: remoteActions.refreshConnectors,
    showToast,
    setError,
    completeSlackOAuth: remoteActions.completeSlackOAuth,
    isCalendarProviderPickerOpen,
    calendarProviderPickerRef,
    setIsCalendarProviderPickerOpen,
    refreshAccounts: remoteActions.refreshAccounts,
  });

  return remoteActions;
}

function useWorkspaceSettingsPageModel() {
  const core = useWorkspaceSettingsPageSessionCore();
  const remoteSync = useWorkspaceSettingsPageRemoteSync(core);
  const pageHandlers = useWorkspaceSettingsPageHandlers({
    session: core.session,
    linearPopupRef: core.linearPopupRef,
    linearConnector: core.linearConnector,
    slackConnector: core.slackConnector,
    slackOAuthCompletionHandledGuard: core.slackOAuthCompletionHandledRef,
    setLinearConnector: core.setLinearConnector,
    setSlackConnector: core.setSlackConnector,
    setIsLinearSettingsOpen: core.setIsLinearSettingsOpen,
    setIsSlackSettingsOpen: core.setIsSlackSettingsOpen,
    setPendingAction: core.setPendingAction,
    setError: core.setError,
    refreshConnectors: remoteSync.refreshConnectors,
    refreshAccounts: remoteSync.refreshAccounts,
    showToast: core.showToast,
    setIsCalendarProviderPickerOpen: core.setIsCalendarProviderPickerOpen,
    setOpenCalendarKindAccountId: core.setOpenCalendarKindAccountId,
    setCalendarAccounts: core.setCalendarAccounts,
    deleteTarget: core.deleteTarget,
    setDeleteTarget: core.setDeleteTarget,
    setDeleteError: core.setDeleteError,
    scopedCalendarAccounts: core.scopedCalendarAccounts,
    setMyWorkspace: core.setMyWorkspace,
    queryClient: core.queryClient,
    refreshSession: core.refreshSession,
    updateCachedUser: core.updateCachedUser,
    logout: core.logout,
    router: core.router,
  });

  return {
    ...core,
    ...remoteSync,
    ...pageHandlers,
  };
}

type WorkspaceSettingsPageViewModel = ReturnType<typeof useWorkspaceSettingsPageModel>;

function SettingsAccountLogoutRows({
  pendingAction,
  onLogout,
  onLogoutAllDevices,
}: {
  pendingAction: string | null;
  onLogout: () => Promise<void>;
  onLogoutAllDevices: () => Promise<void>;
}) {
  return (
    <>
      <div className="settings-account-action-row">
        <span className="settings-account-action-label">{SETTINGS_PAGE_COPY.logoutThisDeviceLabel}</span>
        <button
          type="button"
          className="settings-row-secondary-button"
          disabled={pendingAction === "logout"}
          onClick={() => void onLogout()}
        >
          {pendingAction === "logout" ? SETTINGS_PAGE_COPY.loggingOutLabel : SETTINGS_PAGE_COPY.logoutLabel}
        </button>
      </div>
      <div className="settings-account-action-row">
        <span className="settings-account-action-label">{SETTINGS_PAGE_COPY.logoutAllDevicesLabel}</span>
        <button
          type="button"
          className="settings-row-secondary-button"
          disabled={pendingAction === "logout-all"}
          onClick={() => void onLogoutAllDevices()}
        >
          {pendingAction === "logout-all" ? SETTINGS_PAGE_COPY.loggingOutLabel : SETTINGS_PAGE_COPY.logoutLabel}
        </button>
      </div>
    </>
  );
}

function WorkspaceSettingsPageAccountTab(viewModel: WorkspaceSettingsPageViewModel) {
  const {
    session,
    displayNameDraft,
    setDisplayNameDraft,
    saveDisplayName,
    avatarInitials,
    theme,
    isThemeDropdownOpen,
    setIsThemeDropdownOpen,
    setTheme,
    pendingAction,
    handleLogout,
    handleLogoutAllDevices,
    setDeleteTarget,
  } = viewModel;

  return (
    <section className="settings-section settings-account-section">
      <header className="settings-section-header">
        <h1>{SETTINGS_PAGE_COPY.accountTab}</h1>
      </header>
      <div className="settings-profile-panel">
        <div className="settings-profile-row">
          <span className="settings-profile-label">{SETTINGS_PAGE_COPY.profileImageLabel}</span>
          <span className="settings-profile-avatar">
            {typeof session?.user.avatarUrl === "string" && session.user.avatarUrl.length > 0 ? (
              <img src={session.user.avatarUrl} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span>{avatarInitials}</span>
            )}
          </span>
        </div>
        <div className="settings-profile-row">
          <span className="settings-profile-label">{SETTINGS_PAGE_COPY.emailLabel}</span>
          <span className="settings-profile-value">{session?.user.email ?? SETTINGS_PAGE_COPY.unknownEmail}</span>
        </div>
        <label className="settings-profile-row">
          <span className="settings-profile-label">{SETTINGS_PAGE_COPY.fullNameLabel}</span>
          <input
            className="settings-profile-name-input"
            value={displayNameDraft}
            onChange={(event) => {
              const nextDisplayName = event.target.value;
              setDisplayNameDraft(nextDisplayName);
              saveDisplayName(nextDisplayName);
            }}
          />
        </label>
      </div>
      <div className="settings-appearance-panel">
        <span className="settings-profile-label">{SETTINGS_PAGE_COPY.themeLabel}</span>
        <SettingsDropdown
          value={theme}
          options={THEME_OPTIONS}
          isOpen={isThemeDropdownOpen}
          ariaLabel="Theme"
          className="settings-theme-dropdown"
          onOpenChange={setIsThemeDropdownOpen}
          onSelect={setTheme}
        />
      </div>
      <div className="settings-account-action-list">
        <SettingsAccountLogoutRows
          pendingAction={pendingAction}
          onLogout={handleLogout}
          onLogoutAllDevices={handleLogoutAllDevices}
        />
        <div className="settings-account-action-row">
          <span className="settings-account-action-label">{SETTINGS_PAGE_COPY.deleteAccountDescription}</span>
          <button
            type="button"
            className="settings-row-danger-button"
            disabled={pendingAction === "delete-target"}
            onClick={() => {
              const accountEmailValue = session?.user.email;
              if (accountEmailValue !== undefined && accountEmailValue.length > 0) {
                setDeleteTarget({ kind: "account", email: accountEmailValue });
              }
            }}
          >
            {pendingAction === "delete-target"
              ? SETTINGS_PAGE_COPY.deletingLabel
              : SETTINGS_PAGE_COPY.deleteAccountLabel}
          </button>
        </div>
      </div>
    </section>
  );
}

function WorkspaceSettingsPageTabButton(input: {
  activeTab: SettingsTab;
  tab: SettingsTab;
  label: string;
  icon: ReactNode;
  className?: string;
  onSelect: (tab: SettingsTab) => void;
}) {
  return (
    <button
      type="button"
      className={`workspace-category-item settings-tab-button${input.activeTab === input.tab ? " is-active" : ""}${input.className !== undefined && input.className.length > 0 ? ` ${input.className}` : ""}`}
      onClick={() => input.onSelect(input.tab)}
    >
      <span className="workspace-category-item-main">
        {input.icon}
        <span>{input.label}</span>
      </span>
    </button>
  );
}

function WorkspaceSettingsPageSidebar(viewModel: WorkspaceSettingsPageViewModel) {
  const {
    activeTab,
    returnLocation,
    returnScope,
    selectSettingsTab,
    isWorkspaceManager,
    myWorkspace,
    isWorkspaceOwner,
  } = viewModel;

  return (
    <aside className="settings-sidebar">
      <Link
        href={returnLocation.scope === returnScope ? returnLocation.href : "/workspace"}
        className="workspace-category-item settings-back-link"
      >
        <span className="workspace-category-item-main">
          <BackToAppIcon />
          <span>{SETTINGS_PAGE_COPY.backToApp}</span>
        </span>
      </Link>

      <nav className="settings-tabs" aria-label="Settings sections">
        <WorkspaceSettingsPageTabButton
          activeTab={activeTab}
          tab="account"
          label={SETTINGS_PAGE_COPY.accountTab}
          icon={<AccountNavIcon />}
          onSelect={selectSettingsTab}
        />
        <WorkspaceSettingsPageTabButton
          activeTab={activeTab}
          tab="calendars"
          label={SETTINGS_PAGE_COPY.calendarsTab}
          icon={<CalendarStackIcon />}
          onSelect={selectSettingsTab}
        />
        <WorkspaceSettingsPageTabButton
          activeTab={activeTab}
          tab="connectors"
          label={SETTINGS_PAGE_COPY.connectedAppsTab}
          icon={<ConnectorsNavIcon />}
          onSelect={selectSettingsTab}
        />
        <WorkspaceSettingsPageTabButton
          activeTab={activeTab}
          tab="memory"
          label={SETTINGS_PAGE_COPY.memoryTab}
          icon={<PrivacySettingsNavIcon />}
          onSelect={selectSettingsTab}
        />
        {isWorkspaceManager ? (
          <WorkspaceSettingsPageTabButton
            activeTab={activeTab}
            tab="workspace"
            label={SETTINGS_PAGE_COPY.workspaceTab}
            icon={<WorkspaceNavIcon />}
            onSelect={selectSettingsTab}
          />
        ) : null}
        {myWorkspace !== null ? (
          <WorkspaceSettingsPageTabButton
            activeTab={activeTab}
            tab="members"
            label={SETTINGS_PAGE_COPY.membersTab}
            icon={<MembersNavIcon />}
            onSelect={selectSettingsTab}
          />
        ) : null}
        {isWorkspaceOwner ? (
          <WorkspaceSettingsPageTabButton
            activeTab={activeTab}
            tab="billing"
            label={SETTINGS_PAGE_COPY.billingTab}
            icon={<BillingNavIcon />}
            onSelect={selectSettingsTab}
          />
        ) : null}
        <h2 className="settings-features-heading">{SETTINGS_PAGE_COPY.featuresHeading}</h2>
        <WorkspaceSettingsPageTabButton
          activeTab={activeTab}
          tab="meeting-intelligence"
          label={SETTINGS_PAGE_COPY.meetingIntelligenceTab}
          icon={<MeetingIntelligenceNavIcon />}
          onSelect={selectSettingsTab}
        />
      </nav>
    </aside>
  );
}

function WorkspaceSettingsPageCalendarAccountRow(input: {
  viewModel: WorkspaceSettingsPageViewModel;
  account: CalendarAccount;
}) {
  const {
    pendingAction,
    startCalendarConnect,
    openCalendarKindAccountId,
    setOpenCalendarKindAccountId,
    handleCalendarKindChange,
    setDeleteTarget,
  } = input.viewModel;
  const account = input.account;
  const email = accountEmail(account);

  return (
    <div className="settings-calendar-account-row">
      <div className="settings-calendar-account-label">
        <span
          className="settings-calendar-account-logo"
          aria-label={calendarProviderLabel(account.provider)}
          title={calendarProviderLabel(account.provider)}
        >
          <CalendarProviderLogo provider={account.provider} />
        </span>
        <div className="settings-calendar-account-copy">
          <strong>{email ?? SETTINGS_PAGE_COPY.unknownAccount}</strong>
          <p className={`settings-calendar-account-status is-${account.status}`}>
            {calendarAccountStatusCopy(account.status)}
          </p>
        </div>
      </div>
      <div className="settings-calendar-account-controls">
        {account.status !== "connected" ? (
          <button
            type="button"
            className="settings-card-secondary-button"
            disabled={pendingAction?.startsWith("calendar-connect:") ?? false}
            onClick={() => void startCalendarConnect(account.provider)}
          >
            {pendingAction === `calendar-connect:${account.provider}`
              ? SETTINGS_PAGE_COPY.openingLabel
              : SETTINGS_PAGE_COPY.reconnectLabel}
          </button>
        ) : null}
        <CalendarAccountKindDropdown
          account={account}
          isOpen={openCalendarKindAccountId === account.id}
          isDisabled={pendingAction === `calendar-kind:${account.id}`}
          onOpenChange={(isOpen) => setOpenCalendarKindAccountId(isOpen ? account.id : null)}
          onSelect={(accountKind) => void handleCalendarKindChange({ account, accountKind })}
        />
        <SettingsTooltipAction
          label={SETTINGS_PAGE_COPY.deleteLabel}
          tooltip={SETTINGS_PAGE_COPY.calendarDeleteTooltip}
          className="settings-card-danger-button"
          isDisabled={email === null || email.length === 0}
          onClick={() => setDeleteTarget({ kind: "calendar", account })}
        />
      </div>
    </div>
  );
}

function WorkspaceSettingsPageCalendarProviderPicker(viewModel: WorkspaceSettingsPageViewModel) {
  const {
    pendingAction,
    startCalendarConnect,
    calendarProviderPickerRef,
    isCalendarProviderPickerOpen,
    setIsCalendarProviderPickerOpen,
  } = viewModel;

  return (
    <div className="workspace-calendar-connect settings-calendar-connect" ref={calendarProviderPickerRef}>
      <button
        type="button"
        className="workspace-setup-action settings-calendar-connect-button"
        aria-haspopup="menu"
        aria-expanded={isCalendarProviderPickerOpen}
        disabled={pendingAction?.startsWith("calendar-connect:") ?? false}
        onClick={() => setIsCalendarProviderPickerOpen((isOpen) => !isOpen)}
      >
        {pendingAction?.startsWith("calendar-connect:") === true
          ? SETTINGS_PAGE_COPY.openingLabel
          : SETTINGS_PAGE_COPY.connectNewCalendar}
      </button>
      {isCalendarProviderPickerOpen ? (
        <div
          className="workspace-calendar-provider-picker settings-calendar-provider-picker"
          role="menu"
          aria-label={SETTINGS_PAGE_COPY.chooseCalendarProvider}
        >
          {CALENDAR_CONNECT_PROVIDERS.map((provider) => (
            <button
              key={provider}
              type="button"
              role="menuitem"
              onClick={() => void startCalendarConnect(provider)}
              disabled={pendingAction?.startsWith("calendar-connect:") ?? false}
            >
              <CalendarProviderLogo provider={provider} />
              <span>
                {pendingAction === `calendar-connect:${provider}`
                  ? SETTINGS_PAGE_COPY.openingLabel
                  : calendarConnectProviderLabel(provider)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceSettingsPageCalendarsTab(viewModel: WorkspaceSettingsPageViewModel) {
  const { scopedCalendarAccounts } = viewModel;

  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <div className="settings-section-title">
          <h1>{SETTINGS_PAGE_COPY.calendarsTitle}</h1>
          <p>{CALENDAR_DISCLOSURE}</p>
        </div>
      </header>
      <div className="settings-calendar-account-list">
        {scopedCalendarAccounts.map((account) => (
          <WorkspaceSettingsPageCalendarAccountRow key={account.id} viewModel={viewModel} account={account} />
        ))}
      </div>
      <WorkspaceSettingsPageCalendarProviderPicker {...viewModel} />
    </section>
  );
}

function WorkspaceSettingsPageLinearConnectorRow(viewModel: WorkspaceSettingsPageViewModel) {
  const { pendingAction, linearConnector, setIsLinearSettingsOpen, startLinearConnect } = viewModel;

  return (
    <div className="settings-calendar-account-row">
      <div className="settings-calendar-account-label">
        <span className="settings-calendar-account-logo" aria-label="Linear" title="Linear">
          <LinearLogo />
        </span>
        <div>
          <strong>{SETTINGS_PAGE_COPY.linearName}</strong>
          <p className="settings-connector-status">{SETTINGS_PAGE_COPY.linearDescription}</p>
        </div>
      </div>
      <div className="settings-calendar-account-controls">
        {linearConnector?.status === "connected" ? (
          <button type="button" className="settings-row-secondary-button" onClick={() => setIsLinearSettingsOpen(true)}>
            {SETTINGS_PAGE_COPY.manageLabel}
          </button>
        ) : (
          <button
            type="button"
            className="workspace-setup-action settings-calendar-connect-button"
            disabled={pendingAction === "linear-connect"}
            onClick={() => void startLinearConnect()}
          >
            {pendingAction === "linear-connect" ? SETTINGS_PAGE_COPY.openingLabel : SETTINGS_PAGE_COPY.connectLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function WorkspaceSettingsPageSlackConnectorRow(viewModel: WorkspaceSettingsPageViewModel) {
  const { pendingAction, slackConnector, setIsSlackSettingsOpen, startSlackConnect } = viewModel;

  return (
    <div className="settings-calendar-account-row">
      <div className="settings-calendar-account-label">
        <span className="settings-calendar-account-logo" aria-label="Slack" title="Slack">
          <SlackLogo />
        </span>
        <div>
          <strong>{SETTINGS_PAGE_COPY.slackName}</strong>
          <p className="settings-connector-status">{SETTINGS_PAGE_COPY.slackDescription}</p>
        </div>
      </div>
      <div className="settings-calendar-account-controls">
        {slackConnector?.status === "connected" ? (
          <button type="button" className="settings-row-secondary-button" onClick={() => setIsSlackSettingsOpen(true)}>
            {SETTINGS_PAGE_COPY.manageLabel}
          </button>
        ) : (
          <button
            type="button"
            className="workspace-setup-action settings-calendar-connect-button"
            disabled={pendingAction === "slack-connect"}
            onClick={() => void startSlackConnect()}
          >
            {pendingAction === "slack-connect" ? SETTINGS_PAGE_COPY.openingLabel : SETTINGS_PAGE_COPY.connectLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function WorkspaceSettingsPageConnectorModals(viewModel: WorkspaceSettingsPageViewModel) {
  const {
    session,
    linearConnector,
    slackConnector,
    isLinearSettingsOpen,
    setIsLinearSettingsOpen,
    handleLinearDisconnect,
    isSlackSettingsOpen,
    setIsSlackSettingsOpen,
    handleSlackDisconnect,
    startSlackConnect,
    showToast,
  } = viewModel;

  return (
    <>
      {isLinearSettingsOpen && linearConnector?.status === "connected" ? (
        <LinearConnectorSettingsModal
          workspaceName={linearConnector.externalAccountEmail ?? null}
          onClose={() => setIsLinearSettingsOpen(false)}
          onDisconnect={() => void handleLinearDisconnect()}
        />
      ) : null}

      {isSlackSettingsOpen &&
      session?.token !== undefined &&
      session.token.length > 0 &&
      slackConnector?.status === "connected" ? (
        <SlackConnectorSettingsModal
          onReconnect={() => void startSlackConnect()}
          token={session.token}
          teamName={slackConnector.externalAccountEmail ?? null}
          onClose={() => setIsSlackSettingsOpen(false)}
          onDisconnect={() => void handleSlackDisconnect()}
          onSaved={() =>
            showToast({
              id: "settings-slack-saved",
              title: SETTINGS_PAGE_COPY.slackSettingsSavedTitle,
              message: SETTINGS_PAGE_COPY.slackSettingsSavedMessage,
              tone: "success",
            })
          }
        />
      ) : null}
    </>
  );
}

function WorkspaceSettingsPageConnectorsTab(viewModel: WorkspaceSettingsPageViewModel) {
  const { session, myWorkspace } = viewModel;

  return (
    <section className="settings-section">
      <header className="settings-section-header">
        <div className="settings-section-title">
          <h1>{SETTINGS_PAGE_COPY.connectedAppsTitle}</h1>
          <p>{CONNECTORS_DISCLOSURE}</p>
        </div>
      </header>
      <div className="settings-calendar-account-list">
        <WorkspaceSettingsPageLinearConnectorRow {...viewModel} />
        <WorkspaceSettingsPageSlackConnectorRow {...viewModel} />
        {session?.token !== undefined && session.token.length > 0 && myWorkspace !== null ? (
          <AshbyConnectorRow token={session.token} workspaceId={myWorkspace.id} />
        ) : null}
      </div>
      <WorkspaceSettingsPageConnectorModals {...viewModel} />
    </section>
  );
}

function WorkspaceSettingsPageBillingTab(viewModel: WorkspaceSettingsPageViewModel) {
  const { session, myWorkspace } = viewModel;
  if (myWorkspace === null) {
    return null;
  }

  return (
    <section className="settings-section settings-usage-section">
      <header className="settings-section-header">
        <div className="settings-section-title">
          <h1>{SETTINGS_PAGE_COPY.billingTitle}</h1>
          <p>{SETTINGS_PAGE_COPY.billingDescription}</p>
        </div>
      </header>
      <BillingPanel token={session?.token} workspaceId={myWorkspace.id} />
    </section>
  );
}

function WorkspaceSettingsPageWorkspaceTab(viewModel: WorkspaceSettingsPageViewModel) {
  const { session, myWorkspace, isWorkspaceManager, isWorkspaceOwner, setDeleteTarget } = viewModel;

  if (myWorkspace === null) {
    return null;
  }
  if (!isWorkspaceManager || session === null) {
    return (
      <section className="settings-section">
        <p className="settings-error">{SETTINGS_PAGE_COPY.workspaceAccessDenied}</p>
      </section>
    );
  }

  return (
    <WorkspaceAdminWorkspacePanel
      token={session.token}
      workspaceId={myWorkspace.id}
      canDeleteWorkspace={isWorkspaceOwner}
      onRequestDelete={(workspace) => setDeleteTarget({ kind: "workspace", ...workspace })}
    />
  );
}

function WorkspaceSettingsPageMembersTab(viewModel: WorkspaceSettingsPageViewModel) {
  const { session, myWorkspace, handleViewerWorkspaceRoleChanged } = viewModel;

  if (myWorkspace === null) {
    return null;
  }
  if (session === null) {
    return (
      <section className="settings-section">
        <p className="settings-error">{SETTINGS_PAGE_COPY.membersSignInRequired}</p>
      </section>
    );
  }

  return (
    <WorkspaceAdminMembersPanel
      token={session.token}
      workspaceId={myWorkspace.id}
      onViewerRoleChanged={handleViewerWorkspaceRoleChanged}
    />
  );
}

const SETTINGS_STANDALONE_PANELS: Partial<Record<SettingsTab, () => ReactNode>> = {
  memory: MemorySettingsPanel,
  "meeting-intelligence": MeetingIntelligenceSettingsPanel,
};

function WorkspaceSettingsPagePanelContent(viewModel: WorkspaceSettingsPageViewModel) {
  const { activeTab, error, isWorkspaceOwner, myWorkspace } = viewModel;
  const StandalonePanel = SETTINGS_STANDALONE_PANELS[activeTab];

  return (
    <div className="settings-panel">
      {error !== null && error.length > 0 ? <p className="settings-error">{error}</p> : null}

      {StandalonePanel !== undefined ? <StandalonePanel /> : null}
      {activeTab === "account" ? <WorkspaceSettingsPageAccountTab {...viewModel} /> : null}
      {activeTab === "calendars" ? <WorkspaceSettingsPageCalendarsTab {...viewModel} /> : null}
      {activeTab === "connectors" ? <WorkspaceSettingsPageConnectorsTab {...viewModel} /> : null}
      {activeTab === "billing" && isWorkspaceOwner && myWorkspace !== null ? (
        <WorkspaceSettingsPageBillingTab {...viewModel} />
      ) : null}
      {activeTab === "workspace" && myWorkspace !== null ? <WorkspaceSettingsPageWorkspaceTab {...viewModel} /> : null}
      {activeTab === "members" && myWorkspace !== null ? <WorkspaceSettingsPageMembersTab {...viewModel} /> : null}
    </div>
  );
}

function WorkspaceSettingsPageView(viewModel: WorkspaceSettingsPageViewModel) {
  const { pendingAction, deleteTarget, deleteError, setDeleteTarget, setDeleteError, confirmDelete } = viewModel;

  return (
    <main className="settings-fullscreen">
      <div className="settings-shell">
        <section className="settings-page">
          <WorkspaceSettingsPageSidebar {...viewModel} />
          <WorkspaceSettingsPagePanelContent {...viewModel} />
        </section>
      </div>

      <SettingsDeleteDialog
        target={deleteTarget}
        isPending={pendingAction === "delete-target"}
        error={deleteError}
        onCancel={() => {
          if (pendingAction !== "delete-target") {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
        onConfirm={(confirmationEmail) => void confirmDelete(confirmationEmail)}
      />
    </main>
  );
}

export function WorkspaceSettingsPage() {
  const viewModel = useWorkspaceSettingsPageModel();

  return <WorkspaceSettingsPageView {...viewModel} />;
}
