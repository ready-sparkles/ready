"use client";

import { ASHBY_REQUIRED_PERMISSIONS, type AshbyIntegrationStatusResponse } from "@readymeet/shared";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import {
  connectAshby,
  disconnectAshby,
  getApiErrorMessage,
  getAshbyIntegration,
  removeAshbyKey,
  saveAshbyKey,
} from "../../composition/api";

import { useToast } from "./toast-provider";

type Modal = "setup" | "admin-only" | "manage" | null;

const ASHBY_CONNECTOR_COPY = {
  rowDescription: "See candidate details and approve hiring stage changes.",
  whatItDoes:
    "See candidate details in meetings and Ashby profile links in your memory. After meetings, review suggested stage changes. Ready updates Ashby only after you approve. Details and suggestions are private to each person who connects.",
  modalCloseGlyph: "×",
  setupTitleReplace: "Replace Ashby key",
  setupTitleInitial: "Set up Ashby",
  setupSubtitleReplace: "Everyone in this workspace keeps using Ashby with the new key.",
  setupSubtitleInitial:
    "Connect Ashby to this workspace so everyone can turn it on without setting up their own API key.",
  keyHelpHeading: "In Ashby",
  keyHelpSteps: "Go to Admin → Integrations → API Keys, create a new key, and enable:",
  keyHelpWriteBeforeCodes: "For confirmed post-meeting stage changes, also enable ",
  keyHelpWriteBetweenCodes: " and ",
  keyHelpWriteAfterCodes: ". Candidate cards only require read access.",
  candidatesWriteCode: "candidatesWrite",
  interviewsReadCode: "interviewsRead",
  apiKeyLabel: "API key",
  apiKeyPlaceholder: "Paste API key",
  cancel: "Cancel",
  replaceKeyPending: "Replacing…",
  replaceKey: "Replace key",
  connectPending: "Connecting…",
  connectAshby: "Connect Ashby",
  manageTitle: "Ashby",
  manageConnectedSubtitle: "Connected for you.",
  manageNotConnectedSubtitle: "Not connected for you.",
  manageDetails:
    "See candidate context in meetings and Ashby links in memory. Review stage changes after calls—nothing updates without your approval.",
  managePrivacy: "Candidate details and suggestions are private to you. Stage changes require API write access.",
  turnOffPending: "Turning off…",
  turnOffForMe: "Turn off for me",
  connect: "Connect",
  workspaceKeyHeading: "Workspace key",
  workspaceKeyMembersNote: "Members opt in individually. The key stays hidden.",
  workspaceKeyRemoveWarning: "Removing this key disconnects Ashby for everyone in this workspace.",
  keepKey: "Keep key",
  removeKeyPending: "Removing…",
  removeKey: "Remove key",
  replaceKeyAction: "Replace key",
  adminOnlyTitle: "Ashby isn't set up yet",
  adminOnlyWithAdminsPrefix: "A workspace admin needs to add an Ashby API key first. Ask ",
  adminOnlyNoAdmins: "A workspace admin needs to add an Ashby API key first.",
  ok: "OK",
  ashbyLabel: "Ashby",
  setUp: "Set up",
  manage: "Manage",
  toastConnectedTitle: "Ashby connected",
  toastConnectedMessage: "Candidate context is on. Stage changes require your approval and API write access.",
  toastTitle: "Ashby",
} as const;

const ASHBY_CONNECTOR_ERRORS = {
  loadFailed: "Could not load Ashby.",
  generic: "Something went wrong.",
  saveKeyFailed: "Could not save the key.",
} as const;

export function AshbyLogo({ className }: { className?: string } = {}) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 50 50"
      width="20"
      height="20"
      fill="none"
      style={{ borderRadius: "4px", overflow: "hidden" }}
    >
      <rect width="50" height="50" fill="#473BCE" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M18.5752 39.7875V41H9V39.7875C11.4806 39.7875 12.4729 39.2076 13.3659 36.6771L22.693 9H27.1085L37.3783 36.6771C38.3705 39.2603 38.8667 39.7875 41 39.7875V41H25.9462V39.7875C29.5173 39.7875 29.8186 39.4457 28.7457 36.6771L26.0171 29.0857H17.7318L15.3008 36.5189C14.5908 39.0336 14.746 39.7875 18.5752 39.7875ZM21.6512 17.0659L18.2775 27.4514H25.4217L21.6512 17.0659Z"
        fill="white"
      />
    </svg>
  );
}

function ModalShell({
  title,
  subtitle,
  labelId,
  onClose,
  children,
}: {
  title: string;
  subtitle: ReactNode;
  labelId: string;
  onClose: () => void;
  children: ReactNode;
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
        aria-label={`Close ${title}`}
        onClick={onClose}
      />
      <section
        className="slack-settings-modal connected-app-management-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        <button
          type="button"
          className="workspace-settings-modal-close slack-settings-close"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <span>{ASHBY_CONNECTOR_COPY.modalCloseGlyph}</span>
        </button>
        <header className="slack-settings-header">
          <h2 id={labelId}>{title}</h2>
          <p className="slack-settings-subtitle">{subtitle}</p>
        </header>
        {children}
      </section>
    </>
  );
}

function SetupKeyModal({
  isReplacing,
  isPending,
  error,
  onSave,
  onClose,
}: {
  isReplacing: boolean;
  isPending: boolean;
  error: string | null;
  onSave: (apiKey: string) => void;
  onClose: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const trimmedApiKey = apiKey.trim();
  const hasApiKey = trimmedApiKey !== "";
  const submitLabel = isReplacing
    ? isPending
      ? ASHBY_CONNECTOR_COPY.replaceKeyPending
      : ASHBY_CONNECTOR_COPY.replaceKey
    : isPending
      ? ASHBY_CONNECTOR_COPY.connectPending
      : ASHBY_CONNECTOR_COPY.connectAshby;

  return (
    <ModalShell
      title={isReplacing ? ASHBY_CONNECTOR_COPY.setupTitleReplace : ASHBY_CONNECTOR_COPY.setupTitleInitial}
      labelId="ashby-setup-title"
      onClose={onClose}
      subtitle={isReplacing ? ASHBY_CONNECTOR_COPY.setupSubtitleReplace : ASHBY_CONNECTOR_COPY.setupSubtitleInitial}
    >
      {isReplacing ? null : <p className="slack-settings-subtitle">{ASHBY_CONNECTOR_COPY.whatItDoes}</p>}
      <div className="ashby-key-help">
        <h3>{ASHBY_CONNECTOR_COPY.keyHelpHeading}</h3>
        <p>{ASHBY_CONNECTOR_COPY.keyHelpSteps}</p>
        <ul>
          {ASHBY_REQUIRED_PERMISSIONS.map((permission) => (
            <li key={permission}>
              <code>{permission}</code>
            </li>
          ))}
        </ul>
        <p>
          {ASHBY_CONNECTOR_COPY.keyHelpWriteBeforeCodes}
          <code>{ASHBY_CONNECTOR_COPY.candidatesWriteCode}</code>
          {ASHBY_CONNECTOR_COPY.keyHelpWriteBetweenCodes}
          <code>{ASHBY_CONNECTOR_COPY.interviewsReadCode}</code>
          {ASHBY_CONNECTOR_COPY.keyHelpWriteAfterCodes}
        </p>
      </div>
      <form
        className="ashby-key-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (hasApiKey) {
            onSave(trimmedApiKey);
          }
        }}
      >
        <label className="members-invite-label" htmlFor="ashby-api-key">
          {ASHBY_CONNECTOR_COPY.apiKeyLabel}
        </label>
        <input
          id="ashby-api-key"
          className="settings-profile-name-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={ASHBY_CONNECTOR_COPY.apiKeyPlaceholder}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={isPending}
          autoFocus
        />
        {error !== null ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="slack-settings-actions">
          <button type="button" className="settings-secondary-button" onClick={onClose} disabled={isPending}>
            {ASHBY_CONNECTOR_COPY.cancel}
          </button>
          <button type="submit" className="slack-settings-save" disabled={isPending || !hasApiKey}>
            {submitLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ashbyWorkspaceKeyConfiguredLine(status: AshbyIntegrationStatusResponse) {
  const configuredOn = status.configuredAt !== null ? new Date(status.configuredAt).toLocaleDateString() : null;

  if (status.configuredBy === null) {
    return "";
  }

  const dateSuffix = configuredOn !== null ? ` on ${configuredOn}` : "";

  return `Added by ${status.configuredBy.displayName}${dateSuffix}. `;
}

function AshbyWorkspaceKeySection({
  status,
  pendingAction,
  onReplaceKey,
  onRemoveKey,
}: {
  status: AshbyIntegrationStatusResponse;
  pendingAction: string | null;
  onReplaceKey: () => void;
  onRemoveKey: () => void;
}) {
  const [isConfirmRemove, setIsConfirmRemove] = useState(false);
  const isActionPending = pendingAction !== null;
  const configuredLine = ashbyWorkspaceKeyConfiguredLine(status);

  return (
    <div className="ashby-admin-section">
      <h3>{ASHBY_CONNECTOR_COPY.workspaceKeyHeading}</h3>
      <p className="slack-settings-subtitle">
        {configuredLine}
        {ASHBY_CONNECTOR_COPY.workspaceKeyMembersNote}
      </p>
      {isConfirmRemove ? (
        <>
          <p className="settings-error" role="alert">
            {ASHBY_CONNECTOR_COPY.workspaceKeyRemoveWarning}
          </p>
          <div className="slack-settings-actions">
            <button type="button" className="settings-secondary-button" onClick={() => setIsConfirmRemove(false)}>
              {ASHBY_CONNECTOR_COPY.keepKey}
            </button>
            <button
              type="button"
              className="settings-secondary-button slack-settings-disconnect"
              onClick={onRemoveKey}
              disabled={isActionPending}
            >
              {pendingAction === "remove" ? ASHBY_CONNECTOR_COPY.removeKeyPending : ASHBY_CONNECTOR_COPY.removeKey}
            </button>
          </div>
        </>
      ) : (
        <div className="slack-settings-actions">
          <button
            type="button"
            className="settings-secondary-button slack-settings-disconnect"
            onClick={() => setIsConfirmRemove(true)}
          >
            {ASHBY_CONNECTOR_COPY.removeKey}
          </button>
          <button type="button" className="settings-secondary-button" onClick={onReplaceKey}>
            {ASHBY_CONNECTOR_COPY.replaceKeyAction}
          </button>
        </div>
      )}
    </div>
  );
}

function ManageModal({
  status,
  pending,
  error,
  onConnect,
  onDisconnect,
  onReplaceKey,
  onRemoveKey,
  onClose,
}: {
  status: AshbyIntegrationStatusResponse;
  pending: string | null;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onReplaceKey: () => void;
  onRemoveKey: () => void;
  onClose: () => void;
}) {
  const isActionPending = pending !== null;
  /** @external Ashby integration status payload */
  const isConnected = status.connected;

  return (
    <ModalShell
      title={ASHBY_CONNECTOR_COPY.manageTitle}
      labelId="ashby-manage-title"
      onClose={onClose}
      subtitle={
        isConnected ? ASHBY_CONNECTOR_COPY.manageConnectedSubtitle : ASHBY_CONNECTOR_COPY.manageNotConnectedSubtitle
      }
    >
      <p className="slack-settings-subtitle">{ASHBY_CONNECTOR_COPY.manageDetails}</p>
      <p className="slack-settings-subtitle">{ASHBY_CONNECTOR_COPY.managePrivacy}</p>
      <div className="slack-settings-actions">
        {isConnected ? (
          <button
            type="button"
            className="settings-secondary-button slack-settings-disconnect"
            onClick={onDisconnect}
            disabled={isActionPending}
          >
            {pending === "disconnect" ? ASHBY_CONNECTOR_COPY.turnOffPending : ASHBY_CONNECTOR_COPY.turnOffForMe}
          </button>
        ) : (
          <button type="button" className="slack-settings-save" onClick={onConnect} disabled={isActionPending}>
            {pending === "connect" ? ASHBY_CONNECTOR_COPY.connectPending : ASHBY_CONNECTOR_COPY.connect}
          </button>
        )}
      </div>
      {error !== null ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}

      {status.canManage ? (
        <AshbyWorkspaceKeySection
          status={status}
          pendingAction={pending}
          onReplaceKey={onReplaceKey}
          onRemoveKey={onRemoveKey}
        />
      ) : null}
    </ModalShell>
  );
}

type AshbyConnectorRowAction = {
  label: string;
  onClick: () => void;
  isDisabled?: boolean;
  isPrimary: boolean;
};

function ashbyAdminOnlySubtitle(status: AshbyIntegrationStatusResponse) {
  if (status.admins.length === 0) {
    return ASHBY_CONNECTOR_COPY.adminOnlyNoAdmins;
  }
  const adminNames = status.admins.map((admin) => admin.displayName).join(", ");

  return `${ASHBY_CONNECTOR_COPY.adminOnlyWithAdminsPrefix}${adminNames}.`;
}

function shouldShowAshbyManageShortcut(status: AshbyIntegrationStatusResponse) {
  /** @external Ashby integration status payload */
  const isConfigured = status.configured;
  /** @external Ashby integration status payload */
  const canManage = status.canManage;
  /** @external Ashby integration status payload */
  const isConnected = status.connected;

  return isConfigured && canManage && !isConnected;
}

function buildAshbyConnectorRowAction(input: {
  status: AshbyIntegrationStatusResponse | null;
  pendingAction: string | null;
  onOpenSetup: () => void;
  onOpenAdminOnly: () => void;
  onOpenManage: () => void;
  onConnect: () => void;
}): AshbyConnectorRowAction {
  const { status, pendingAction, onOpenSetup, onOpenAdminOnly, onOpenManage, onConnect } = input;
  if (status === null) {
    return {
      label: ASHBY_CONNECTOR_COPY.connect,
      onClick: () => {},
      isDisabled: true,
      isPrimary: true,
    };
  }
  /** @external Ashby integration status payload */
  const isConfigured = status.configured;
  if (!isConfigured) {
    /** @external Ashby integration status payload */
    const canManage = status.canManage;
    if (canManage) {
      return { label: ASHBY_CONNECTOR_COPY.setUp, onClick: onOpenSetup, isPrimary: true };
    }

    return { label: ASHBY_CONNECTOR_COPY.connect, onClick: onOpenAdminOnly, isPrimary: true };
  }

  /** @external Ashby integration status payload */
  const isConnected = status.connected;

  if (isConnected) {
    return { label: ASHBY_CONNECTOR_COPY.manage, onClick: onOpenManage, isPrimary: false };
  }
  const isActionPending = pendingAction !== null;

  return {
    label: pendingAction === "connect" ? ASHBY_CONNECTOR_COPY.connectPending : ASHBY_CONNECTOR_COPY.connect,
    onClick: onConnect,
    isDisabled: isActionPending,
    isPrimary: true,
  };
}

function AshbyConnectorModals({
  modal,
  status,
  pendingAction,
  keyError,
  actionError,
  onSaveKey,
  onCloseSetup,
  onCloseModal,
  onConnect,
  onDisconnect,
  onOpenReplaceKey,
  onRemoveKey,
}: {
  modal: Modal;
  status: AshbyIntegrationStatusResponse | null;
  pendingAction: string | null;
  keyError: string | null;
  actionError: string | null;
  onSaveKey: (apiKey: string) => void;
  onCloseSetup: () => void;
  onCloseModal: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenReplaceKey: () => void;
  onRemoveKey: () => void;
}) {
  if (status === null) {
    return null;
  }

  if (modal === "setup") {
    /** @external Ashby integration status payload */
    const isConfigured = status.configured;

    return (
      <SetupKeyModal
        isReplacing={isConfigured}
        isPending={pendingAction === "save"}
        error={keyError}
        onSave={onSaveKey}
        onClose={onCloseSetup}
      />
    );
  }

  if (modal === "admin-only") {
    return (
      <ModalShell
        title={ASHBY_CONNECTOR_COPY.adminOnlyTitle}
        labelId="ashby-admin-only-title"
        onClose={onCloseModal}
        subtitle={ashbyAdminOnlySubtitle(status)}
      >
        <div className="slack-settings-actions">
          <button type="button" className="settings-secondary-button" onClick={onCloseModal}>
            {ASHBY_CONNECTOR_COPY.ok}
          </button>
        </div>
      </ModalShell>
    );
  }

  if (modal === "manage") {
    return (
      <ManageModal
        status={status}
        pending={pendingAction}
        error={actionError}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onReplaceKey={onOpenReplaceKey}
        onRemoveKey={onRemoveKey}
        onClose={onCloseModal}
      />
    );
  }

  return null;
}

async function runAshbyIntegrationAction(input: {
  runInput: {
    action: string;
    operation: () => Promise<AshbyIntegrationStatusResponse>;
    onDone?: () => void;
  };
  modal: Modal;
  setPending: (value: string | null) => void;
  setActionError: (value: string | null) => void;
  setStatus: (value: AshbyIntegrationStatusResponse | null) => void;
  refresh: () => Promise<void>;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  const { runInput, modal, setPending, setActionError, setStatus, refresh, showToast } = input;

  setPending(runInput.action);
  setActionError(null);
  try {
    setStatus(await runInput.operation());
    runInput.onDone?.();
  } catch (error) {
    const message = getApiErrorMessage({ error, fallback: ASHBY_CONNECTOR_ERRORS.generic });

    if (modal !== null) {
      setActionError(message);
    } else {
      showToast({
        id: `ashby-${runInput.action}-error`,
        title: ASHBY_CONNECTOR_COPY.toastTitle,
        message,
        tone: "warning",
      });
    }
    await refresh();
  } finally {
    setPending(null);
  }
}

async function performAshbySaveKey(input: {
  token: string;
  workspaceId: string;
  apiKey: string;
  isReplacing: boolean;
  setPending: (value: string | null) => void;
  setKeyError: (value: string | null) => void;
  setStatus: (value: AshbyIntegrationStatusResponse | null) => void;
  setModal: (value: Modal) => void;
  showConnectedToast: () => void;
}) {
  const { token, workspaceId, apiKey, isReplacing, setPending, setKeyError, setStatus, setModal, showConnectedToast } =
    input;

  setPending("save");
  setKeyError(null);
  try {
    setStatus(await saveAshbyKey({ token, workspaceId, apiKey }));
    setModal(isReplacing ? "manage" : null);
    if (!isReplacing) {
      showConnectedToast();
    }
  } catch (error) {
    setKeyError(getApiErrorMessage({ error, fallback: ASHBY_CONNECTOR_ERRORS.saveKeyFailed }));
  } finally {
    setPending(null);
  }
}

function showAshbyConnectedToast(showToast: ReturnType<typeof useToast>["showToast"]) {
  showToast({
    id: "ashby-connected",
    title: ASHBY_CONNECTOR_COPY.toastConnectedTitle,
    message: ASHBY_CONNECTOR_COPY.toastConnectedMessage,
    tone: "success",
  });
}

function createAshbyConnectorMutationCallbacks(input: {
  token: string;
  workspaceId: string;
  status: AshbyIntegrationStatusResponse | null;
  modal: Modal;
  setStatus: (value: AshbyIntegrationStatusResponse | null) => void;
  setModal: (value: Modal) => void;
  setPending: (value: string | null) => void;
  setKeyError: (value: string | null) => void;
  setActionError: (value: string | null) => void;
  refresh: () => Promise<void>;
  showToast: ReturnType<typeof useToast>["showToast"];
}) {
  const showConnectedToast = () => showAshbyConnectedToast(input.showToast);
  const runMutation =
    (runInput: { action: string; operation: () => Promise<AshbyIntegrationStatusResponse>; onDone?: () => void }) =>
    () =>
      void runAshbyIntegrationAction({
        runInput,
        modal: input.modal,
        setPending: input.setPending,
        setActionError: input.setActionError,
        setStatus: input.setStatus,
        refresh: input.refresh,
        showToast: input.showToast,
      });

  return {
    connect: runMutation({
      action: "connect",
      operation: () => connectAshby({ token: input.token, workspaceId: input.workspaceId }),
      onDone: () => {
        input.setModal(null);
        showConnectedToast();
      },
    }),
    disconnect: runMutation({
      action: "disconnect",
      operation: () => disconnectAshby({ token: input.token, workspaceId: input.workspaceId }),
      onDone: () => input.setModal(null),
    }),
    removeKey: runMutation({
      action: "remove",
      operation: () => removeAshbyKey({ token: input.token, workspaceId: input.workspaceId }),
      onDone: () => input.setModal(null),
    }),
    saveKey: async (apiKey: string) => {
      /** @external Ashby integration status payload */
      const isReplacing = input.status?.configured === true;

      await performAshbySaveKey({
        token: input.token,
        workspaceId: input.workspaceId,
        apiKey,
        isReplacing,
        setPending: input.setPending,
        setKeyError: input.setKeyError,
        setStatus: input.setStatus,
        setModal: input.setModal,
        showConnectedToast,
      });
    },
  };
}

function useAshbyConnectorRow({ token, workspaceId }: { token: string; workspaceId: string }) {
  const { showToast } = useToast();
  const [status, setStatus] = useState<AshbyIntegrationStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  // Errors from actions inside a dialog show in the dialog; toasts render beneath it.
  const [actionError, setActionError] = useState<string | null>(null);
  const openModal = (next: Modal) => {
    setActionError(null);
    setModal(next);
  };

  const refresh = useCallback(async () => {
    try {
      setStatus(await getAshbyIntegration({ token, workspaceId }));
      setLoadError(null);
    } catch (error) {
      setLoadError(getApiErrorMessage({ error, fallback: ASHBY_CONNECTOR_ERRORS.loadFailed }));
    }
  }, [token, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { connect, disconnect, removeKey, saveKey } = useMemo(
    () =>
      createAshbyConnectorMutationCallbacks({
        token,
        workspaceId,
        status,
        modal,
        setStatus,
        setModal,
        setPending,
        setKeyError,
        setActionError,
        refresh,
        showToast,
      }),
    [modal, refresh, showToast, status, token, workspaceId],
  );

  const openSetup = useCallback(() => {
    setKeyError(null);
    openModal("setup");
  }, []);

  const openAdminOnly = useCallback(() => {
    openModal("admin-only");
  }, []);

  const openManage = useCallback(() => {
    openModal("manage");
  }, []);

  const rowAction = buildAshbyConnectorRowAction({
    status,
    pendingAction: pending,
    onOpenSetup: openSetup,
    onOpenAdminOnly: openAdminOnly,
    onOpenManage: openManage,
    onConnect: connect,
  });

  const closeModal = useCallback(() => {
    setModal(null);
  }, []);

  const closeSetupModal = useCallback(() => {
    if (status === null) {
      setModal(null);

      return;
    }

    /** @external Ashby integration status payload */
    const isConfigured = status.configured;
    setModal(isConfigured ? "manage" : null);
  }, [status]);

  const hasLoadError = loadError !== null;
  const statusRowDescription = hasLoadError ? loadError : ASHBY_CONNECTOR_COPY.rowDescription;

  return {
    modal,
    status,
    pending,
    keyError,
    actionError,
    rowAction,
    hasLoadError,
    statusRowDescription,
    openManage,
    connect,
    disconnect,
    removeKey,
    saveKey,
    closeSetupModal,
    closeModal,
    openSetup,
  };
}

export function AshbyConnectorRow({ token, workspaceId }: { token: string; workspaceId: string }) {
  const row = useAshbyConnectorRow({ token, workspaceId });

  return (
    <div className="settings-calendar-account-row">
      <div className="settings-calendar-account-label">
        <span
          className="settings-calendar-account-logo"
          aria-label={ASHBY_CONNECTOR_COPY.ashbyLabel}
          title={ASHBY_CONNECTOR_COPY.ashbyLabel}
        >
          <AshbyLogo />
        </span>
        <div className="settings-calendar-account-copy">
          <strong>{ASHBY_CONNECTOR_COPY.ashbyLabel}</strong>
          <p
            className={`settings-connector-status${row.hasLoadError ? "" : " settings-connector-status-single-line"}`}
            title={row.hasLoadError ? undefined : ASHBY_CONNECTOR_COPY.rowDescription}
          >
            {row.statusRowDescription}
          </p>
        </div>
      </div>
      <div className="settings-calendar-account-controls">
        {row.status !== null && shouldShowAshbyManageShortcut(row.status) ? (
          <button type="button" className="settings-row-secondary-button" onClick={row.openManage}>
            {ASHBY_CONNECTOR_COPY.manage}
          </button>
        ) : null}
        <button
          type="button"
          className={
            row.rowAction.isPrimary
              ? "workspace-setup-action settings-calendar-connect-button"
              : "settings-row-secondary-button"
          }
          disabled={row.rowAction.isDisabled}
          onClick={row.rowAction.onClick}
        >
          {row.rowAction.label}
        </button>
      </div>

      <AshbyConnectorModals
        modal={row.modal}
        status={row.status}
        pendingAction={row.pending}
        keyError={row.keyError}
        actionError={row.actionError}
        onSaveKey={(apiKey) => void row.saveKey(apiKey)}
        onCloseSetup={row.closeSetupModal}
        onCloseModal={row.closeModal}
        onConnect={row.connect}
        onDisconnect={row.disconnect}
        onOpenReplaceKey={row.openSetup}
        onRemoveKey={row.removeKey}
      />
    </div>
  );
}
