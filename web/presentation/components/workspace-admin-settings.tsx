"use client";

import type {
  AdminWorkspaceMember,
  WorkspaceInvitation,
  WorkspaceMemberRole,
  WorkspaceMembersResponse,
} from "@readymeet/shared";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  getApiErrorMessage,
  getWorkspaceAdminMembers,
  getWorkspaceSettings,
  inviteWorkspaceMembers,
  removeWorkspaceLogo,
  removeWorkspaceMember,
  resendWorkspaceInvitation,
  restoreWorkspaceMember,
  revokeWorkspaceInvitation,
  suspendWorkspaceMember,
  transferWorkspaceOwnership,
  updateWorkspaceMemberRole,
  updateWorkspaceSettings,
  uploadWorkspaceLogo,
} from "../../composition/api";

import { useToast } from "./toast-provider";

const toastIds = { next: 0 };

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const BYTES_PER_KB = 1024;
const DAYS_IN_MONTH_THRESHOLD = 31;
const MEMBER_INITIALS_MAX_PARTS = 2;
const ROW_MENU_DEFAULT_WIDTH_PX = 220;
const ROW_MENU_VIEWPORT_PADDING_PX = 8;
const ROW_MENU_ANCHOR_OFFSET_PX = 4;
const MEMBERS_TABLE_COLUMN_COUNT = 5;
const WORKSPACE_NAME_MAX_LENGTH = 255;

const WORKSPACE_ADMIN_COPY = {
  lastSeenNever: "Never",
  lastSeenJustNow: "Just now",
  lastSeenOneMinuteAgo: "1 minute ago",
  lastSeenMinutesAgoSuffix: " minutes ago",
  lastSeenOneHourAgo: "1 hour ago",
  lastSeenHoursAgoSuffix: " hours ago",
  lastSeenYesterday: "Yesterday",
  lastSeenDaysAgoSuffix: " days ago",
  joinedDateInvalid: "—",
  statusOwner: "Owner",
  statusAdmin: "Admin",
  statusMember: "Member",
  statusSuspendedPrefix: "Suspended · ",
  invitationExpired: "Invitation expired",
  invitationInvited: "Invited",
  confirmCancel: "Cancel",
  confirmWorking: "Working…",
  fileReadError: "Could not read the image file.",
  loadWorkspaceSettingsError: "Could not load workspace settings.",
  saveWorkspaceNameError: "Could not save the workspace name.",
  logoTypeError: "Logo must be a PNG, JPEG, WebP, or GIF image.",
  logoSizeError: "Logo must be 1 MB or smaller.",
  logoUploadSuccess: "Workspace logo updated.",
  logoUploadError: "Could not upload the logo.",
  logoRemoveSuccess: "Workspace logo removed.",
  logoRemoveError: "Could not remove the logo.",
  workspaceSectionTitle: "Workspace",
  workspaceNameLabel: "Workspace name",
  workspaceLogoLabel: "Workspace logo",
  workspaceLogoAlt: "Workspace logo",
  workspaceLogoPlaceholder: "Workspace",
  replaceLogo: "Replace logo",
  uploadLogo: "Upload logo",
  removeLogo: "Remove",
  logoHint: "PNG, JPEG, WebP, or GIF up to 1 MB.",
  deleteWorkspaceDescription: "Delete this workspace and all shared workspace data.",
  deleteWorkspaceButton: "Delete workspace",
  inviteDialogTitle: "Invite to your workspace",
  inviteEmailLabel: "Email",
  inviteRoleLabel: "Role",
  inviteRoleMember: "Member – Full access with limited permissions",
  inviteRoleAdmin: "Admin – Full access and workspace administration",
  inviteSending: "Sending…",
  inviteSendMultiple: "Send invites",
  inviteSendOne: "Send invites",
  loadMembersError: "Could not load workspace members.",
  rowActionError: "The action could not be completed.",
  inviteSendError: "Invitations could not be sent.",
  membersSectionTitle: "Members",
  membersSelfTag: " (you)",
  pendingInvitation: "Pending invitation",
  invitedPrefix: "Invited ",
  membersEmptySearch: "No members match your search.",
  membersEmpty: "No members yet.",
  membersLoading: "Loading members…",
  membersSearchLabel: "Search members by name or email",
  membersSearchPlaceholder: "Search",
  membersInviteButton: "Invite",
  membersTableName: "Name",
  membersTableStatus: "Status",
  membersTableJoined: "Joined",
  membersTableLastSeen: "Last seen",
  membersTableActions: "Actions",
  membersGroupActive: "Active",
  membersGroupInvited: "Invited",
  membersGroupSuspended: "Suspended",
  failureAlreadyMember: "is already a member",
  failureAlreadyInvited: "already has a pending invitation",
  failureInvalidEmail: "is not a valid email address",
  failureEmailGeneric: "could not be emailed",
} as const;

function workspaceAdminMemberSuspendedMessage(displayName: string) {
  return `${displayName} was suspended.`;
}

function workspaceAdminMemberOwnershipMessage(displayName: string) {
  return `${displayName} is now the workspace owner.`;
}

function workspaceAdminMemberRemovedMessage(displayName: string) {
  return `${displayName} was removed from the workspace.`;
}

function workspaceAdminMemberActivatedMessage(displayName: string) {
  return `${displayName} was activated.`;
}

function workspaceAdminMemberRoleChangedMessage(...args: [displayName: string, role: WorkspaceMemberRole]) {
  const [displayName, role] = args;

  return `${displayName} is now ${role === "admin" ? "an admin" : "a member"}.`;
}

function workspaceAdminInviteFailureMessage(...args: [email: string, reasonLabel: string]) {
  const [email, reasonLabel] = args;

  return `${email} ${reasonLabel}.`;
}

function workspaceAdminInvitationResentMessage(email: string) {
  return `Invitation resent to ${email}.`;
}

function workspaceAdminInvitationRevokedMessage(email: string) {
  return `Invitation to ${email} was revoked.`;
}

function notifyToast(input: {
  showToast: (toast: { id: string; message: string; tone?: "info" | "success" | "warning" }) => void;
  tone: "success" | "error";
  message: string;
}) {
  toastIds.next += 1;
  input.showToast({
    id: `workspace-admin-toast-${toastIds.next}`,
    message: input.message,
    tone: input.tone === "error" ? "warning" : "success",
  });
}

const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const LOGO_MAX_BYTES = BYTES_PER_KB * BYTES_PER_KB;
const LOGO_ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const WORKSPACE_NAME_AUTOSAVE_DELAY_MS = 700;

function formatLastSeenImpl(input: { lastSeenAt: string | null; now: Date }) {
  if (input.lastSeenAt === null || input.lastSeenAt.length === 0) {
    return WORKSPACE_ADMIN_COPY.lastSeenNever;
  }
  const seen = new Date(input.lastSeenAt);
  const diffMs = input.now.getTime() - seen.getTime();
  if (Number.isNaN(seen.getTime()) || diffMs < 0) {
    return WORKSPACE_ADMIN_COPY.lastSeenJustNow;
  }
  const minutes = Math.floor(diffMs / MS_PER_MINUTE);
  if (minutes < 1) {
    return WORKSPACE_ADMIN_COPY.lastSeenJustNow;
  }
  if (minutes < MINUTES_PER_HOUR) {
    return minutes === 1
      ? WORKSPACE_ADMIN_COPY.lastSeenOneMinuteAgo
      : `${minutes}${WORKSPACE_ADMIN_COPY.lastSeenMinutesAgoSuffix}`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return hours === 1
      ? WORKSPACE_ADMIN_COPY.lastSeenOneHourAgo
      : `${hours}${WORKSPACE_ADMIN_COPY.lastSeenHoursAgoSuffix}`;
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  if (days === 1) {
    return WORKSPACE_ADMIN_COPY.lastSeenYesterday;
  }
  if (days < DAYS_IN_MONTH_THRESHOLD) {
    return `${days}${WORKSPACE_ADMIN_COPY.lastSeenDaysAgoSuffix}`;
  }

  return seen.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function formatLastSeen(...args: [lastSeenAt: string | null, now?: Date]) {
  const [lastSeenAt, now = new Date()] = args;

  return formatLastSeenImpl({ lastSeenAt, now });
}

export function formatJoinedDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return WORKSPACE_ADMIN_COPY.joinedDateInvalid;
  }

  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function parseInviteEmails(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0),
    ),
  );
}

function memberInitials(name: string) {
  const parts = name.split(/\s+/).filter((part) => part.length > 0);

  const initials = parts
    .slice(0, MEMBER_INITIALS_MAX_PARTS)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials.length > 0 ? initials : "?";
}

export function memberRoleOptionState(input: {
  viewerRole: WorkspaceMemberRole;
  canTransferOwnership: boolean;
  targetRole: WorkspaceMemberRole;
  targetStatus: "active" | "suspended";
  /** @external existing role menu wire field */
  targetIsSelf: boolean;
  optionRole: WorkspaceMemberRole;
}) {
  const isChecked = input.targetRole === input.optionRole;
  const canViewerManage = input.viewerRole === "owner" || input.viewerRole === "admin";
  const isTargetProtected = input.targetRole === "owner" || input.targetIsSelf;
  const isDisabled =
    input.optionRole === "owner"
      ? !input.canTransferOwnership || input.targetStatus !== "active" || input.targetIsSelf || isChecked
      : !canViewerManage || isTargetProtected || isChecked;

  return {
    /** @external existing role menu wire field */
    checked: isChecked,
    /** @external existing role menu wire field */
    disabled: isDisabled,
  };
}

function MemberAvatar({ name, avatarUrl, isMuted }: { name: string; avatarUrl: string | null; isMuted?: boolean }) {
  if (avatarUrl !== null && avatarUrl.length > 0) {
    return <img className={`members-avatar${isMuted === true ? " is-muted" : ""}`} src={avatarUrl} alt="" />;
  }

  return (
    <span className={`members-avatar members-avatar-initials${isMuted === true ? " is-muted" : ""}`}>
      {memberInitials(name)}
    </span>
  );
}

function memberRoleLabel(role: WorkspaceMemberRole) {
  if (role === "owner") {
    return WORKSPACE_ADMIN_COPY.statusOwner;
  }
  if (role === "admin") {
    return WORKSPACE_ADMIN_COPY.statusAdmin;
  }

  return WORKSPACE_ADMIN_COPY.statusMember;
}

function StatusBadge({ member }: { member: AdminWorkspaceMember }) {
  if (member.status === "suspended") {
    return (
      <span className="members-status members-status-muted">
        {WORKSPACE_ADMIN_COPY.statusSuspendedPrefix}
        {memberRoleLabel(member.role)}
      </span>
    );
  }
  if (member.role === "owner") {
    return <span className="members-status members-status-pill">{WORKSPACE_ADMIN_COPY.statusOwner}</span>;
  }
  if (member.role === "admin") {
    return <span className="members-status members-status-pill">{WORKSPACE_ADMIN_COPY.statusAdmin}</span>;
  }

  return <span className="members-status">{WORKSPACE_ADMIN_COPY.statusMember}</span>;
}

function InvitationBadge({ invitation }: { invitation: WorkspaceInvitation }) {
  return invitation.state === "expired" ? (
    <span className="members-status members-status-muted">{WORKSPACE_ADMIN_COPY.invitationExpired}</span>
  ) : (
    <span className="members-status members-status-pill members-status-invited">
      {WORKSPACE_ADMIN_COPY.invitationInvited}
    </span>
  );
}

type ConfirmState = {
  title: string;
  body: string;
  confirmLabel: string;
  isDanger: boolean;
  action: () => Promise<void>;
};

function ConfirmDialog({
  state,
  isPending,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="settings-confirm-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isPending) {
          onCancel();
        }
      }}
    >
      <section className="settings-confirm-dialog" role="dialog" aria-modal="true" aria-label={state.title}>
        <h3>{state.title}</h3>
        <p>{state.body}</p>
        <div className="settings-confirm-actions">
          <button type="button" className="settings-secondary-button" onClick={onCancel} disabled={isPending}>
            {WORKSPACE_ADMIN_COPY.confirmCancel}
          </button>
          <button
            type="button"
            className={state.isDanger ? "settings-danger-button" : "settings-secondary-button"}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? WORKSPACE_ADMIN_COPY.confirmWorking : state.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function RowMenuTriggerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20.3887 4.09277" className="meeting-actions-icon" fill="none">
      <path
        d="M18.0039 4.07129C19.1318 4.07129 20.0449 3.16895 20.0449 2.04102C20.0449 0.913086 19.1318 0 18.0039 0C16.876 0 15.9629 0.913086 15.9629 2.04102C15.9629 3.16895 16.876 4.07129 18.0039 4.07129Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <path
        d="M10.0225 4.07129C11.1504 4.07129 12.0527 3.16895 12.0527 2.04102C12.0527 0.913086 11.1504 0 10.0225 0C8.89453 0 7.98145 0.913086 7.98145 2.04102C7.98145 3.16895 8.89453 4.07129 10.0225 4.07129Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <path
        d="M2.04102 4.07129C3.16895 4.07129 4.07129 3.16895 4.07129 2.04102C4.07129 0.913086 3.16895 0 2.04102 0C0.913086 0 0 0.913086 0 2.04102C0 3.16895 0.913086 4.07129 2.04102 4.07129Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
    </svg>
  );
}

function useRowMenuOutsideDismiss(input: {
  isOpen: boolean;
  onToggle: () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    if (!input.isOpen) {
      return;
    }
    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) {
        return;
      }
      const target = event.target;
      if (
        input.containerRef.current &&
        !input.containerRef.current.contains(target) &&
        !(input.popoverRef.current?.contains(target) ?? false)
      ) {
        input.onToggle();
      }
    };
    document.addEventListener("mousedown", handleClick);

    return () => document.removeEventListener("mousedown", handleClick);
  }, [input.containerRef, input.isOpen, input.onToggle, input.popoverRef]);
}

function useRowMenuPopoverPosition(input: {
  isOpen: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
}) {
  const [popoverPosition, setPopoverPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!input.isOpen) {
      setPopoverPosition(null);

      return;
    }

    const updatePosition = () => {
      const trigger = input.triggerRef.current;
      if (!trigger) {
        return;
      }
      const triggerRect = trigger.getBoundingClientRect();
      const menuWidth = input.popoverRef.current?.offsetWidth ?? ROW_MENU_DEFAULT_WIDTH_PX;
      const menuHeight = input.popoverRef.current?.offsetHeight ?? 0;
      setPopoverPosition(
        computeRowMenuPopoverPosition({
          triggerRect,
          menuWidth,
          menuHeight,
        }),
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [input.isOpen, input.popoverRef, input.triggerRef]);

  return popoverPosition;
}

function computeRowMenuPopoverPosition(input: { triggerRect: DOMRect; menuWidth: number; menuHeight: number }) {
  const left = Math.max(
    ROW_MENU_VIEWPORT_PADDING_PX,
    Math.min(
      window.innerWidth - input.menuWidth - ROW_MENU_VIEWPORT_PADDING_PX,
      input.triggerRect.right - input.menuWidth,
    ),
  );
  const roomBelow = window.innerHeight - input.triggerRect.bottom - ROW_MENU_VIEWPORT_PADDING_PX;
  const top =
    input.menuHeight > roomBelow && input.triggerRect.top > input.menuHeight + ROW_MENU_VIEWPORT_PADDING_PX
      ? input.triggerRect.top - input.menuHeight - ROW_MENU_ANCHOR_OFFSET_PX
      : input.triggerRect.bottom + ROW_MENU_ANCHOR_OFFSET_PX;

  return { left, top };
}

function RowMenu({
  isOpen,
  onToggle,
  children,
  label,
}: {
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useRowMenuOutsideDismiss({ isOpen, onToggle, containerRef, popoverRef });
  const popoverPosition = useRowMenuPopoverPosition({ isOpen, triggerRef, popoverRef });

  const popover =
    isOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            className="members-row-menu-popover"
            role="menu"
            ref={popoverRef}
            style={
              popoverPosition
                ? { left: popoverPosition.left, top: popoverPosition.top }
                : { left: 0, top: 0, visibility: "hidden" }
            }
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="members-row-menu" ref={containerRef}>
        <button
          ref={triggerRef}
          type="button"
          className={`members-row-menu-trigger${isOpen ? " is-open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-label={label}
          onClick={onToggle}
        >
          <RowMenuTriggerIcon />
        </button>
      </div>
      {popover}
    </>
  );
}

async function readLogoFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);

        return;
      }
      reject(new Error(WORKSPACE_ADMIN_COPY.fileReadError));
    };
    reader.onerror = () => reject(new Error(WORKSPACE_ADMIN_COPY.fileReadError));
    reader.readAsDataURL(file);
  });
}

type WorkspaceNameSaveContext = {
  token: string;
  workspaceId: string;
  showToast: (toast: { id: string; message: string; tone?: "info" | "success" | "warning" }) => void;
  workspaceNameEditVersionRef: RefObject<number>;
  savedWorkspaceNameRef: RefObject<string>;
  setWorkspaceName: (name: string) => void;
};

async function runQueuedWorkspaceNameSave(
  input: WorkspaceNameSaveContext & { name: string; editVersion: number },
): Promise<void> {
  const {
    token,
    workspaceId,
    showToast,
    savedWorkspaceNameRef,
    workspaceNameEditVersionRef,
    setWorkspaceName,
    name,
    editVersion,
  } = input;

  try {
    const workspace = await updateWorkspaceSettings({
      token,
      workspaceId,
      input: { name },
    });
    savedWorkspaceNameRef.current = workspace.name;
    if (editVersion === workspaceNameEditVersionRef.current) {
      setWorkspaceName(workspace.name);
    }
  } catch (error) {
    if (editVersion === workspaceNameEditVersionRef.current) {
      notifyToast({
        showToast,
        tone: "error",
        message: getApiErrorMessage({
          error,
          fallback: WORKSPACE_ADMIN_COPY.saveWorkspaceNameError,
        }),
      });
    }
    if (!(error instanceof Error)) {
      throw error;
    }
  }
}

function useWorkspaceAdminSettingsLoad(input: { token: string; workspaceId: string }) {
  const [workspaceName, setWorkspaceName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const savedWorkspaceNameRef = useRef("");

  useEffect(() => {
    const lifecycle = { isCancelled: false };
    setIsLoaded(false);
    setLoadError(null);
    const loadWorkspace = async () => {
      try {
        const workspace = await getWorkspaceSettings({ token: input.token, workspaceId: input.workspaceId });
        if (lifecycle.isCancelled) {
          return;
        }
        savedWorkspaceNameRef.current = workspace.name;
        setWorkspaceName(workspace.name);
        setLogoUrl(workspace.logoUrl);
        setIsLoaded(true);
      } catch (error) {
        if (!lifecycle.isCancelled) {
          setLoadError(getApiErrorMessage({ error, fallback: WORKSPACE_ADMIN_COPY.loadWorkspaceSettingsError }));
        }
        if (!(error instanceof Error)) {
          throw error;
        }
      }
    };
    void loadWorkspace();

    return () => {
      lifecycle.isCancelled = true;
    };
  }, [input.token, input.workspaceId]);

  return {
    workspaceName,
    setWorkspaceName,
    logoUrl,
    setLogoUrl,
    isLoaded,
    loadError,
    savedWorkspaceNameRef,
  };
}

function useWorkspaceAdminNameAutosave({
  token,
  workspaceId,
  showToast,
  workspaceName,
  setWorkspaceName,
  savedWorkspaceNameRef,
}: {
  token: string;
  workspaceId: string;
  showToast: (toast: { id: string; message: string; tone?: "info" | "success" | "warning" }) => void;
  workspaceName: string;
  setWorkspaceName: (name: string) => void;
  savedWorkspaceNameRef: RefObject<string>;
}) {
  const workspaceNameSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workspaceNameAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceNameEditVersionRef = useRef(0);

  useEffect(() => {
    workspaceNameEditVersionRef.current += 1;
    if (workspaceNameAutosaveTimerRef.current) {
      clearTimeout(workspaceNameAutosaveTimerRef.current);
      workspaceNameAutosaveTimerRef.current = null;
    }
  }, [workspaceId]);

  const saveContext = useMemo(
    (): WorkspaceNameSaveContext => ({
      token,
      workspaceId,
      showToast,
      workspaceNameEditVersionRef,
      savedWorkspaceNameRef,
      setWorkspaceName,
    }),
    [token, workspaceId, showToast, workspaceNameEditVersionRef, savedWorkspaceNameRef, setWorkspaceName],
  );

  const saveWorkspaceName = useCallback(
    (...args: [nextWorkspaceName: string, editVersion?: number]) => {
      const [nextWorkspaceName, editVersion = workspaceNameEditVersionRef.current] = args;
      const name = nextWorkspaceName.trim();
      if (name.length === 0) {
        return;
      }
      if (name === savedWorkspaceNameRef.current) {
        if (editVersion === workspaceNameEditVersionRef.current && nextWorkspaceName !== name) {
          setWorkspaceName(name);
        }

        return;
      }

      const queuedSave = workspaceNameSaveQueueRef.current;
      workspaceNameSaveQueueRef.current = (async () => {
        try {
          await queuedSave;
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
        }
        await runQueuedWorkspaceNameSave({ ...saveContext, name, editVersion });
      })();
    },
    [saveContext, savedWorkspaceNameRef, setWorkspaceName, workspaceNameEditVersionRef],
  );

  const scheduleWorkspaceNameSave = useCallback(
    (scheduleInput: { nextWorkspaceName: string; editVersion: number }) => {
      if (workspaceNameAutosaveTimerRef.current) {
        clearTimeout(workspaceNameAutosaveTimerRef.current);
      }
      workspaceNameAutosaveTimerRef.current = setTimeout(() => {
        workspaceNameAutosaveTimerRef.current = null;
        saveWorkspaceName(scheduleInput.nextWorkspaceName, scheduleInput.editVersion);
      }, WORKSPACE_NAME_AUTOSAVE_DELAY_MS);
    },
    [workspaceNameAutosaveTimerRef, saveWorkspaceName],
  );

  const flushWorkspaceNameSave = useCallback(() => {
    if (workspaceNameAutosaveTimerRef.current) {
      clearTimeout(workspaceNameAutosaveTimerRef.current);
      workspaceNameAutosaveTimerRef.current = null;
    }
    saveWorkspaceName(workspaceName, workspaceNameEditVersionRef.current);
  }, [workspaceName, workspaceNameAutosaveTimerRef, workspaceNameEditVersionRef, saveWorkspaceName]);

  const handleWorkspaceNameChange = useCallback(
    (nextWorkspaceName: string) => {
      workspaceNameEditVersionRef.current += 1;
      const editVersion = workspaceNameEditVersionRef.current;
      setWorkspaceName(nextWorkspaceName);
      scheduleWorkspaceNameSave({ nextWorkspaceName, editVersion });
    },
    [scheduleWorkspaceNameSave, setWorkspaceName, workspaceNameEditVersionRef],
  );

  return { flushWorkspaceNameSave, handleWorkspaceNameChange };
}

function useWorkspaceAdminLogoControls({
  token,
  workspaceId,
  showToast,
  setLogoUrl,
}: {
  token: string;
  workspaceId: string;
  showToast: (toast: { id: string; message: string; tone?: "info" | "success" | "warning" }) => void;
  setLogoUrl: (logoUrl: string | null) => void;
}) {
  const [isLogoBusy, setIsLogoBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleLogoFile = useCallback(
    async (file: File) => {
      if (!LOGO_ALLOWED_TYPES.has(file.type)) {
        notifyToast({ showToast, tone: "error", message: WORKSPACE_ADMIN_COPY.logoTypeError });

        return;
      }
      if (file.size > LOGO_MAX_BYTES) {
        notifyToast({ showToast, tone: "error", message: WORKSPACE_ADMIN_COPY.logoSizeError });

        return;
      }

      const dataUrl = await readLogoFileAsDataUrl(file);

      setIsLogoBusy(true);
      try {
        const workspace = await uploadWorkspaceLogo({ token, workspaceId, dataUrl });
        setLogoUrl(workspace.logoUrl);
        notifyToast({ showToast, tone: "success", message: WORKSPACE_ADMIN_COPY.logoUploadSuccess });
      } catch (error) {
        notifyToast({
          showToast,
          tone: "error",
          message: getApiErrorMessage({ error, fallback: WORKSPACE_ADMIN_COPY.logoUploadError }),
        });
      } finally {
        setIsLogoBusy(false);
      }
    },
    [setLogoUrl, showToast, token, workspaceId],
  );

  const handleLogoRemove = useCallback(async () => {
    setIsLogoBusy(true);
    try {
      await removeWorkspaceLogo({ token, workspaceId });
      setLogoUrl(null);
      notifyToast({ showToast, tone: "success", message: WORKSPACE_ADMIN_COPY.logoRemoveSuccess });
    } catch (error) {
      notifyToast({
        showToast,
        tone: "error",
        message: getApiErrorMessage({ error, fallback: WORKSPACE_ADMIN_COPY.logoRemoveError }),
      });
    } finally {
      setIsLogoBusy(false);
    }
  }, [setLogoUrl, showToast, token, workspaceId]);

  const handleLogoInputChange = useCallback(
    (file: File | undefined) => {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      if (file !== undefined) {
        void handleLogoFile(file);
      }
    },
    [handleLogoFile],
  );

  return { isLogoBusy, fileInputRef, handleLogoInputChange, handleLogoRemove };
}

function useWorkspaceAdminWorkspaceData(input: {
  token: string;
  workspaceId: string;
  showToast: (toast: { id: string; message: string; tone?: "info" | "success" | "warning" }) => void;
}) {
  const loadState = useWorkspaceAdminSettingsLoad({ token: input.token, workspaceId: input.workspaceId });
  const nameState = useWorkspaceAdminNameAutosave({
    token: input.token,
    workspaceId: input.workspaceId,
    showToast: input.showToast,
    workspaceName: loadState.workspaceName,
    setWorkspaceName: loadState.setWorkspaceName,
    savedWorkspaceNameRef: loadState.savedWorkspaceNameRef,
  });
  const logoState = useWorkspaceAdminLogoControls({
    token: input.token,
    workspaceId: input.workspaceId,
    showToast: input.showToast,
    setLogoUrl: loadState.setLogoUrl,
  });

  return {
    workspaceName: loadState.workspaceName,
    logoUrl: loadState.logoUrl,
    isLoaded: loadState.isLoaded,
    loadError: loadState.loadError,
    isLogoBusy: logoState.isLogoBusy,
    fileInputRef: logoState.fileInputRef,
    savedWorkspaceNameRef: loadState.savedWorkspaceNameRef,
    flushWorkspaceNameSave: nameState.flushWorkspaceNameSave,
    handleWorkspaceNameChange: nameState.handleWorkspaceNameChange,
    handleLogoInputChange: logoState.handleLogoInputChange,
    handleLogoRemove: logoState.handleLogoRemove,
  };
}

function WorkspaceAdminLogoField({
  workspaceName,
  logoUrl,
  isLoaded,
  isLogoBusy,
  fileInputRef,
  handleLogoInputChange,
  handleLogoRemove,
}: {
  workspaceName: string;
  logoUrl: string | null;
  isLoaded: boolean;
  isLogoBusy: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleLogoInputChange: (file: File | undefined) => void;
  handleLogoRemove: () => Promise<void>;
}) {
  const trimmedWorkspaceName = workspaceName.trim();
  const hasLogo = logoUrl !== null && logoUrl.length > 0;

  return (
    <div className="settings-workspace-admin-field">
      <span className="settings-workspace-admin-label">{WORKSPACE_ADMIN_COPY.workspaceLogoLabel}</span>
      <div className="settings-workspace-admin-logo-row">
        {hasLogo ? (
          <img className="settings-workspace-admin-logo" src={logoUrl} alt={WORKSPACE_ADMIN_COPY.workspaceLogoAlt} />
        ) : (
          <span className="settings-workspace-admin-logo settings-workspace-admin-logo-placeholder">
            {memberInitials(
              trimmedWorkspaceName.length > 0 ? trimmedWorkspaceName : WORKSPACE_ADMIN_COPY.workspaceLogoPlaceholder,
            )}
          </span>
        )}
        <div className="settings-workspace-admin-logo-actions">
          <button
            type="button"
            className="settings-secondary-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!isLoaded || isLogoBusy}
          >
            {isLogoBusy
              ? WORKSPACE_ADMIN_COPY.confirmWorking
              : hasLogo
                ? WORKSPACE_ADMIN_COPY.replaceLogo
                : WORKSPACE_ADMIN_COPY.uploadLogo}
          </button>
          {hasLogo ? (
            <button
              type="button"
              className="settings-row-danger-button"
              onClick={() => void handleLogoRemove()}
              disabled={isLogoBusy}
            >
              {WORKSPACE_ADMIN_COPY.removeLogo}
            </button>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={LOGO_ACCEPT}
          hidden
          onChange={(event) => handleLogoInputChange(event.target.files?.[0])}
        />
      </div>
      <p className="settings-workspace-admin-hint">{WORKSPACE_ADMIN_COPY.logoHint}</p>
    </div>
  );
}

function WorkspaceAdminWorkspacePanelContent({
  workspaceId,
  canDeleteWorkspace,
  onRequestDelete,
  workspaceName,
  logoUrl,
  isLoaded,
  isLogoBusy,
  fileInputRef,
  savedWorkspaceNameRef,
  flushWorkspaceNameSave,
  handleWorkspaceNameChange,
  handleLogoInputChange,
  handleLogoRemove,
}: {
  workspaceId: string;
  canDeleteWorkspace: boolean;
  onRequestDelete: (workspace: { id: string; name: string }) => void;
  workspaceName: string;
  logoUrl: string | null;
  isLoaded: boolean;
  isLogoBusy: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  savedWorkspaceNameRef: RefObject<string>;
  flushWorkspaceNameSave: () => void;
  handleWorkspaceNameChange: (nextWorkspaceName: string) => void;
  handleLogoInputChange: (file: File | undefined) => void;
  handleLogoRemove: () => Promise<void>;
}) {
  const trimmedWorkspaceName = workspaceName.trim();
  const deleteWorkspaceName =
    savedWorkspaceNameRef.current.length > 0
      ? savedWorkspaceNameRef.current
      : trimmedWorkspaceName.length > 0
        ? trimmedWorkspaceName
        : WORKSPACE_ADMIN_COPY.workspaceLogoPlaceholder;

  return (
    <section className="settings-section settings-workspace-admin-section">
      <header className="settings-section-header">
        <h1>{WORKSPACE_ADMIN_COPY.workspaceSectionTitle}</h1>
      </header>

      <div className="settings-account-row settings-workspace-admin-card">
        <label className="settings-profile-row">
          <span className="settings-profile-label">{WORKSPACE_ADMIN_COPY.workspaceNameLabel}</span>
          <input
            id="workspace-admin-name"
            className="settings-profile-name-input"
            type="text"
            value={workspaceName}
            maxLength={WORKSPACE_NAME_MAX_LENGTH}
            disabled={!isLoaded}
            onChange={(event) => handleWorkspaceNameChange(event.target.value)}
            onBlur={flushWorkspaceNameSave}
          />
        </label>

        <WorkspaceAdminLogoField
          workspaceName={workspaceName}
          logoUrl={logoUrl}
          isLoaded={isLoaded}
          isLogoBusy={isLogoBusy}
          fileInputRef={fileInputRef}
          handleLogoInputChange={handleLogoInputChange}
          handleLogoRemove={handleLogoRemove}
        />
      </div>

      {canDeleteWorkspace ? (
        <div className="settings-account-action-list">
          <div className="settings-account-action-row">
            <span className="settings-account-action-label">{WORKSPACE_ADMIN_COPY.deleteWorkspaceDescription}</span>
            <button
              type="button"
              className="settings-row-danger-button"
              disabled={!isLoaded}
              onClick={() =>
                onRequestDelete({
                  id: workspaceId,
                  name: deleteWorkspaceName,
                })
              }
            >
              {WORKSPACE_ADMIN_COPY.deleteWorkspaceButton}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// --- Workspace settings panel ---

export function WorkspaceAdminWorkspacePanel({
  token,
  workspaceId,
  canDeleteWorkspace,
  onRequestDelete,
}: {
  token: string;
  workspaceId: string;
  canDeleteWorkspace: boolean;
  onRequestDelete: (workspace: { id: string; name: string }) => void;
}) {
  const { showToast } = useToast();
  const workspaceData = useWorkspaceAdminWorkspaceData({ token, workspaceId, showToast });

  if (workspaceData.loadError !== null) {
    return (
      <section className="settings-section">
        <header className="settings-section-header">
          <h1>{WORKSPACE_ADMIN_COPY.workspaceSectionTitle}</h1>
        </header>
        <p className="settings-error">{workspaceData.loadError}</p>
      </section>
    );
  }

  return (
    <WorkspaceAdminWorkspacePanelContent
      workspaceId={workspaceId}
      canDeleteWorkspace={canDeleteWorkspace}
      onRequestDelete={onRequestDelete}
      workspaceName={workspaceData.workspaceName}
      logoUrl={workspaceData.logoUrl}
      isLoaded={workspaceData.isLoaded}
      isLogoBusy={workspaceData.isLogoBusy}
      fileInputRef={workspaceData.fileInputRef}
      savedWorkspaceNameRef={workspaceData.savedWorkspaceNameRef}
      flushWorkspaceNameSave={workspaceData.flushWorkspaceNameSave}
      handleWorkspaceNameChange={workspaceData.handleWorkspaceNameChange}
      handleLogoInputChange={workspaceData.handleLogoInputChange}
      handleLogoRemove={workspaceData.handleLogoRemove}
    />
  );
}

// --- Members panel ---

type MemberFilter = "all" | "owner" | "admin" | "member" | "suspended" | "invited";

const MEMBER_FILTER_OPTIONS = [
  {
    value: "all",
    title: "All",
    description: "Members and invitations.",
  },
  {
    value: "owner",
    title: "Owner",
    description: "Workspace owner.",
  },
  {
    value: "admin",
    title: "Admins",
    description: "Workspace admins.",
  },
  {
    value: "member",
    title: "Members",
    description: "Active members.",
  },
  {
    value: "suspended",
    title: "Suspended",
    description: "Suspended members.",
  },
  {
    value: "invited",
    title: "Invited",
    description: "Pending invitations.",
  },
] as const satisfies readonly {
  value: MemberFilter;
  title: string;
  description: string;
}[];

function MembersFilterDropdown({
  value,
  isOpen,
  shouldShowInvitations,
  onToggle,
  onSelect,
}: {
  value: MemberFilter;
  isOpen: boolean;
  shouldShowInvitations: boolean;
  onToggle: () => void;
  onSelect: (value: MemberFilter) => void;
}) {
  const selectedOption = MEMBER_FILTER_OPTIONS.find((option) => option.value === value) ?? MEMBER_FILTER_OPTIONS[0];

  return (
    <div className="settings-kind-dropdown" data-settings-members-filter-picker>
      <button
        type="button"
        className="settings-kind-dropdown-button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span>{selectedOption.title}</span>
        <svg aria-hidden="true" viewBox="0 0 12 8" className="settings-kind-dropdown-chevron">
          <path
            d="M1.2 1.4L6 6.2L10.8 1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {isOpen ? (
        <div className="settings-kind-dropdown-menu" role="listbox" aria-label="Filter members">
          {MEMBER_FILTER_OPTIONS.filter((option) => shouldShowInvitations || option.value !== "invited").map(
            (option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`settings-kind-dropdown-option${option.value === value ? " is-selected" : ""}`}
                onClick={() => onSelect(option.value)}
              >
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function InviteModal({
  isPending,
  onClose,
  onSubmit,
}: {
  isPending: boolean;
  onClose: () => void;
  onSubmit: (input: { emails: string[]; role: "admin" | "member" }) => void;
}) {
  const [emailsRaw, setEmailsRaw] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const emails = useMemo(() => parseInviteEmails(emailsRaw), [emailsRaw]);

  return (
    <div
      className="settings-confirm-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isPending) {
          onClose();
        }
      }}
    >
      <section
        className="members-invite-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={WORKSPACE_ADMIN_COPY.inviteDialogTitle}
      >
        <header className="members-invite-header">
          <h2>{WORKSPACE_ADMIN_COPY.inviteDialogTitle}</h2>
          <button
            type="button"
            className="members-invite-close"
            aria-label="Close"
            onClick={onClose}
            disabled={isPending}
          >
            ×
          </button>
        </header>

        <label className="members-invite-label" htmlFor="invite-emails">
          {WORKSPACE_ADMIN_COPY.inviteEmailLabel}
        </label>
        <textarea
          id="invite-emails"
          className="members-invite-emails"
          placeholder="email@company.com, email2@company.com…"
          value={emailsRaw}
          rows={3}
          onChange={(event) => setEmailsRaw(event.target.value)}
          disabled={isPending}
        />

        <label className="members-invite-label" htmlFor="invite-role">
          {WORKSPACE_ADMIN_COPY.inviteRoleLabel}
        </label>
        <select
          id="invite-role"
          className="members-invite-role"
          value={role}
          onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
          disabled={isPending}
        >
          <option value="member">{WORKSPACE_ADMIN_COPY.inviteRoleMember}</option>
          <option value="admin">{WORKSPACE_ADMIN_COPY.inviteRoleAdmin}</option>
        </select>

        <div className="members-invite-actions">
          <button
            type="button"
            className="members-invite-submit"
            onClick={() => onSubmit({ emails, role })}
            disabled={isPending || emails.length === 0}
          >
            {isPending
              ? WORKSPACE_ADMIN_COPY.inviteSending
              : emails.length > 1
                ? `Send ${emails.length} invites`
                : WORKSPACE_ADMIN_COPY.inviteSendOne}
          </button>
        </div>
      </section>
    </div>
  );
}

function buildMembersPanelViewModel(input: {
  members: AdminWorkspaceMember[];
  invitations: WorkspaceInvitation[];
  filter: MemberFilter;
  searchNeedle: string;
}) {
  const matchesSearch = (matchInput: { name: string; email: string }) => {
    if (input.searchNeedle.length === 0) {
      return true;
    }

    return (
      matchInput.name.toLowerCase().includes(input.searchNeedle) ||
      matchInput.email.toLowerCase().includes(input.searchNeedle)
    );
  };

  const activeMembers = input.members.filter(
    (member) =>
      member.status === "active" &&
      matchesSearch({ name: member.displayName, email: member.email }) &&
      (input.filter === "all" || input.filter === member.role),
  );
  const suspendedMembers = input.members.filter(
    (member) =>
      member.status === "suspended" &&
      matchesSearch({ name: member.displayName, email: member.email }) &&
      (input.filter === "all" || input.filter === "suspended"),
  );
  const visibleInvitations = input.invitations.filter(
    (invitation) =>
      matchesSearch({ name: invitation.email, email: invitation.email }) &&
      (input.filter === "all" || input.filter === "invited"),
  );

  return {
    activeMembers,
    suspendedMembers,
    visibleInvitations,
    shouldShowActive:
      input.filter === "all" || input.filter === "owner" || input.filter === "admin" || input.filter === "member",
    shouldShowInvited: input.filter === "all" || input.filter === "invited",
    shouldShowSuspended: input.filter === "all" || input.filter === "suspended",
  };
}

type MembersAdminRowActions = {
  token: string;
  workspaceId: string;
  viewerRole: WorkspaceMemberRole;
  capabilities: WorkspaceMembersResponse["capabilities"];
  openMenuKey: string | null;
  setOpenMenuKey: (key: string | null) => void;
  rowBusyKey: string | null;
  runRowAction: (input: { key: string; action: () => Promise<unknown>; successMessage: string }) => void;
  openConfirm: (state: ConfirmState) => void;
  showToast: (toast: { id: string; message: string; tone?: "info" | "success" | "warning" }) => void;
};

function AdminMemberRoleOptions({
  member,
  rowKey,
  isBusy,
  actions,
}: {
  member: AdminWorkspaceMember;
  rowKey: string;
  isBusy: boolean;
  actions: MembersAdminRowActions;
}) {
  return (["owner", "admin", "member"] as const).map((role) => {
    const optionState = memberRoleOptionState({
      viewerRole: actions.viewerRole,
      canTransferOwnership: actions.capabilities.canTransferOwnership,
      targetRole: member.role,
      targetStatus: member.status,
      targetIsSelf: member.isSelf,
      optionRole: role,
    });

    return (
      <button
        key={role}
        type="button"
        role="menuitemradio"
        aria-checked={optionState.checked}
        className="members-role-option"
        disabled={isBusy || optionState.disabled}
        onClick={() => {
          if (role === "owner") {
            actions.openConfirm({
              title: `Make ${member.displayName} the workspace owner?`,
              body: `${member.displayName} will gain billing and workspace-deletion access immediately. You will become an Admin.`,
              confirmLabel: "Transfer ownership",
              isDanger: false,
              action: async () => {
                await transferWorkspaceOwnership({
                  token: actions.token,
                  workspaceId: actions.workspaceId,
                  targetUserId: member.userId,
                });
                notifyToast({
                  showToast: actions.showToast,
                  tone: "success",
                  message: workspaceAdminMemberOwnershipMessage(member.displayName),
                });
              },
            });

            return;
          }
          actions.runRowAction({
            key: rowKey,
            action: () =>
              updateWorkspaceMemberRole({
                token: actions.token,
                workspaceId: actions.workspaceId,
                targetUserId: member.userId,
                role,
              }),
            successMessage: workspaceAdminMemberRoleChangedMessage(member.displayName, role),
          });
        }}
      >
        <span>{memberRoleLabel(role)}</span>
        <span className="members-role-check" aria-hidden="true">
          {optionState.checked ? "✓" : ""}
        </span>
      </button>
    );
  });
}

function AdminMemberStatusMenuItem({
  member,
  rowKey,
  isBusy,
  isProtectedTarget,
  restoreRole,
  actions,
}: {
  member: AdminWorkspaceMember;
  rowKey: string;
  isBusy: boolean;
  isProtectedTarget: boolean;
  restoreRole: "admin" | "member";
  actions: MembersAdminRowActions;
}) {
  if (member.status === "active") {
    return (
      <button
        type="button"
        role="menuitem"
        disabled={isBusy || isProtectedTarget}
        onClick={() =>
          actions.openConfirm({
            title: `Suspend ${member.displayName}?`,
            body: `${member.displayName} will lose access to this workspace until an admin restores them. Their meetings, notes, tasks, and activity are kept.`,
            confirmLabel: "Suspend member",
            isDanger: true,
            action: async () => {
              await suspendWorkspaceMember({
                token: actions.token,
                workspaceId: actions.workspaceId,
                targetUserId: member.userId,
              });
              notifyToast({
                showToast: actions.showToast,
                tone: "success",
                message: workspaceAdminMemberSuspendedMessage(member.displayName),
              });
            },
          })
        }
      >
        Suspend user
      </button>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      disabled={isBusy || isProtectedTarget}
      onClick={() => {
        actions.runRowAction({
          key: rowKey,
          action: () =>
            restoreWorkspaceMember({
              token: actions.token,
              workspaceId: actions.workspaceId,
              targetUserId: member.userId,
              role: restoreRole,
            }),
          successMessage: workspaceAdminMemberActivatedMessage(member.displayName),
        });
      }}
    >
      Activate user
    </button>
  );
}

function AdminMemberTableRow({ member, actions }: { member: AdminWorkspaceMember; actions: MembersAdminRowActions }) {
  const rowKey = `member:${member.userId}`;
  const isMuted = member.status === "suspended";
  const isBusy = actions.rowBusyKey === rowKey;
  const isProtectedTarget = member.role === "owner" || member.isSelf;
  const restoreRole = member.role === "admin" ? "admin" : "member";

  return (
    <tr className={isMuted ? "members-row is-muted" : "members-row"}>
      <td className="members-cell-name">
        <span className="members-cell-name-inner">
          <MemberAvatar name={member.displayName} avatarUrl={member.avatarUrl} isMuted={isMuted} />
          <span className="members-name-text">
            <span className="members-name-primary">
              {member.displayName}
              {member.isSelf ? <span className="members-self-tag">{WORKSPACE_ADMIN_COPY.membersSelfTag}</span> : null}
            </span>
            <span className="members-name-secondary" title={member.email}>
              {member.email}
            </span>
          </span>
        </span>
      </td>
      <td className="members-cell-status">
        <StatusBadge member={member} />
      </td>
      <td className="members-cell-date members-cell-date-joined">{formatJoinedDate(member.joinedAt)}</td>
      <td className="members-cell-date members-cell-date-seen">{formatLastSeen(member.lastSeenAt)}</td>
      <td className="members-cell-actions">
        {actions.capabilities.canManageMembers ? (
          <RowMenu
            isOpen={actions.openMenuKey === rowKey}
            onToggle={() => actions.setOpenMenuKey(actions.openMenuKey === rowKey ? null : rowKey)}
            label={`Actions for ${member.displayName}`}
          >
            <AdminMemberStatusMenuItem
              member={member}
              rowKey={rowKey}
              isBusy={isBusy}
              isProtectedTarget={isProtectedTarget}
              restoreRole={restoreRole}
              actions={actions}
            />

            <div className="members-row-menu-separator" role="separator" />

            <AdminMemberRoleOptions member={member} rowKey={rowKey} isBusy={isBusy} actions={actions} />

            <div className="members-row-menu-separator" role="separator" />

            <button
              type="button"
              role="menuitem"
              className="is-danger"
              disabled={isBusy || isProtectedTarget}
              onClick={() =>
                actions.openConfirm({
                  title: `Remove ${member.displayName} from this workspace?`,
                  body: `${member.displayName} will lose access to this workspace. Their historical meetings, notes, tasks, and activity remain intact.`,
                  confirmLabel: "Remove from workspace",
                  isDanger: true,
                  action: async () => {
                    await removeWorkspaceMember({
                      token: actions.token,
                      workspaceId: actions.workspaceId,
                      targetUserId: member.userId,
                    });
                    notifyToast({
                      showToast: actions.showToast,
                      tone: "success",
                      message: workspaceAdminMemberRemovedMessage(member.displayName),
                    });
                  },
                })
              }
            >
              Remove from workspace
            </button>
          </RowMenu>
        ) : null}
      </td>
    </tr>
  );
}

function AdminInvitationTableRow({
  invitation,
  actions,
}: {
  invitation: WorkspaceInvitation;
  actions: MembersAdminRowActions;
}) {
  const rowKey = `invitation:${invitation.id}`;
  const isBusy = actions.rowBusyKey === rowKey;

  return (
    <tr className="members-row members-row-invited">
      <td className="members-cell-name">
        <span className="members-cell-name-inner">
          <MemberAvatar name={invitation.email} avatarUrl={null} />
          <span className="members-name-text">
            <span className="members-name-primary">{WORKSPACE_ADMIN_COPY.pendingInvitation}</span>
            <span className="members-name-secondary" title={invitation.email}>
              {invitation.email}
            </span>
          </span>
        </span>
      </td>
      <td className="members-cell-status">
        <InvitationBadge invitation={invitation} />
      </td>
      <td className="members-cell-date members-cell-date-joined">
        {WORKSPACE_ADMIN_COPY.invitedPrefix}
        {formatJoinedDate(invitation.invitedAt)}
      </td>
      <td className="members-cell-date members-cell-date-seen">{WORKSPACE_ADMIN_COPY.joinedDateInvalid}</td>
      <td className="members-cell-actions">
        {actions.capabilities.canManageMembers ? (
          <RowMenu
            isOpen={actions.openMenuKey === rowKey}
            onToggle={() => actions.setOpenMenuKey(actions.openMenuKey === rowKey ? null : rowKey)}
            label={`Actions for invitation to ${invitation.email}`}
          >
            <button
              type="button"
              role="menuitem"
              disabled={isBusy}
              onClick={() => {
                actions.runRowAction({
                  key: rowKey,
                  action: () =>
                    resendWorkspaceInvitation({
                      token: actions.token,
                      workspaceId: actions.workspaceId,
                      invitationId: invitation.id,
                    }),
                  successMessage: workspaceAdminInvitationResentMessage(invitation.email),
                });
              }}
            >
              Resend invitation
            </button>
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              disabled={isBusy}
              onClick={() => {
                actions.runRowAction({
                  key: rowKey,
                  action: () =>
                    revokeWorkspaceInvitation({
                      token: actions.token,
                      workspaceId: actions.workspaceId,
                      invitationId: invitation.id,
                    }),
                  successMessage: workspaceAdminInvitationRevokedMessage(invitation.email),
                });
              }}
            >
              Revoke invitation
            </button>
          </RowMenu>
        ) : null}
      </td>
    </tr>
  );
}

function MembersGroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <tr className="members-group-row">
      <td colSpan={MEMBERS_TABLE_COLUMN_COUNT}>
        <span className="members-group-label">{label}</span>
        <span className="members-group-count">{count}</span>
      </td>
    </tr>
  );
}

async function submitWorkspaceMemberInvites(input: {
  token: string;
  workspaceId: string;
  showToast: (toast: { id: string; message: string; tone?: "info" | "success" | "warning" }) => void;
  refresh: () => Promise<void>;
  setIsInviteOpen: (isOpen: boolean) => void;
  inviteInput: { emails: string[]; role: "admin" | "member" };
}) {
  const result = await inviteWorkspaceMembers({
    token: input.token,
    workspaceId: input.workspaceId,
    input: { emails: input.inviteInput.emails, role: input.inviteInput.role },
  });
  if (result.invitations.length !== 0) {
    const sentInvitation = result.invitations[0];
    notifyToast({
      showToast: input.showToast,
      tone: "success",
      message:
        result.invitations.length === 1 && sentInvitation
          ? `Invitation sent to ${sentInvitation.email}.`
          : `${result.invitations.length} invitations sent.`,
    });
  }
  result.failures.forEach((failure) => {
    const reasonLabel =
      failure.reason === "already_member"
        ? WORKSPACE_ADMIN_COPY.failureAlreadyMember
        : failure.reason === "already_invited"
          ? WORKSPACE_ADMIN_COPY.failureAlreadyInvited
          : failure.reason === "invalid_email"
            ? WORKSPACE_ADMIN_COPY.failureInvalidEmail
            : WORKSPACE_ADMIN_COPY.failureEmailGeneric;
    notifyToast({
      showToast: input.showToast,
      tone: "error",
      message: workspaceAdminInviteFailureMessage(failure.email, reasonLabel),
    });
  });
  if (result.invitations.length !== 0) {
    input.setIsInviteOpen(false);
  }
  await input.refresh();
}

function useWorkspaceMembersAdminHandlers(input: {
  token: string;
  workspaceId: string;
  showToast: (toast: { id: string; message: string; tone?: "info" | "success" | "warning" }) => void;
  refresh: () => Promise<void>;
  pendingConfirm: ConfirmState | null;
  setPendingConfirm: (state: ConfirmState | null) => void;
  setIsConfirmPending: (isPending: boolean) => void;
  setIsInviteOpen: (isOpen: boolean) => void;
  setIsInvitePending: (isPending: boolean) => void;
  setRowBusyKey: (key: string | null) => void;
  setOpenMenuKey: (key: string | null) => void;
}) {
  const runRowAction = useCallback(
    (rowInput: { key: string; action: () => Promise<unknown>; successMessage: string }) => {
      input.setRowBusyKey(rowInput.key);
      input.setOpenMenuKey(null);
      void (async () => {
        try {
          await rowInput.action();
          notifyToast({ showToast: input.showToast, tone: "success", message: rowInput.successMessage });
          await input.refresh();
        } catch (error) {
          notifyToast({
            showToast: input.showToast,
            tone: "error",
            message: getApiErrorMessage({ error, fallback: WORKSPACE_ADMIN_COPY.rowActionError }),
          });
        } finally {
          input.setRowBusyKey(null);
        }
      })();
    },
    [input],
  );

  const openConfirm = useCallback(
    (state: ConfirmState) => {
      input.setOpenMenuKey(null);
      input.setPendingConfirm(state);
    },
    [input],
  );

  const runConfirm = useCallback(async () => {
    if (input.pendingConfirm === null) {
      return;
    }
    input.setIsConfirmPending(true);
    try {
      await input.pendingConfirm.action();
      input.setPendingConfirm(null);
      await input.refresh();
    } catch (error) {
      notifyToast({
        showToast: input.showToast,
        tone: "error",
        message: getApiErrorMessage({ error, fallback: WORKSPACE_ADMIN_COPY.rowActionError }),
      });
    } finally {
      input.setIsConfirmPending(false);
    }
  }, [input]);

  const handleInvite = useCallback(
    async (inviteInput: { emails: string[]; role: "admin" | "member" }) => {
      input.setIsInvitePending(true);
      try {
        await submitWorkspaceMemberInvites({
          token: input.token,
          workspaceId: input.workspaceId,
          showToast: input.showToast,
          refresh: input.refresh,
          setIsInviteOpen: input.setIsInviteOpen,
          inviteInput,
        });
      } catch (error) {
        notifyToast({
          showToast: input.showToast,
          tone: "error",
          message: getApiErrorMessage({ error, fallback: WORKSPACE_ADMIN_COPY.inviteSendError }),
        });
      } finally {
        input.setIsInvitePending(false);
      }
    },
    [input],
  );

  return { runRowAction, openConfirm, runConfirm, handleInvite };
}

function useWorkspaceMembersAdminLoad(input: {
  token: string;
  workspaceId: string;
  onViewerRoleChanged?: (role: WorkspaceMemberRole) => void;
}) {
  const [members, setMembers] = useState<AdminWorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [viewerRole, setViewerRole] = useState<WorkspaceMemberRole>("member");
  const [capabilities, setCapabilities] = useState<WorkspaceMembersResponse["capabilities"]>({
    canManageMembers: false,
    canInviteMembers: false,
    canTransferOwnership: false,
    canManageBilling: false,
    canDeleteWorkspace: false,
  });
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const payload = await getWorkspaceAdminMembers({ token: input.token, workspaceId: input.workspaceId });
      setMembers(payload.members);
      setInvitations(payload.invitations);
      setViewerRole(payload.viewerRole);
      setCapabilities(payload.capabilities);
      input.onViewerRoleChanged?.(payload.viewerRole);
      setLoadError(null);
      setIsLoaded(true);
    } catch (error) {
      setLoadError(getApiErrorMessage({ error, fallback: WORKSPACE_ADMIN_COPY.loadMembersError }));
      setIsLoaded(true);
    }
  }, [input.token, input.workspaceId, input.onViewerRoleChanged]);

  useEffect(() => {
    setIsLoaded(false);
    void refresh();
  }, [refresh]);

  return { members, invitations, viewerRole, capabilities, isLoaded, loadError, refresh };
}

function useWorkspaceMembersAdminPanel({
  token,
  workspaceId,
  onViewerRoleChanged,
}: {
  token: string;
  workspaceId: string;
  onViewerRoleChanged?: (role: WorkspaceMemberRole) => void;
}) {
  const { showToast } = useToast();
  const loadState = useWorkspaceMembersAdminLoad({ token, workspaceId, onViewerRoleChanged });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmState | null>(null);
  const [isConfirmPending, setIsConfirmPending] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [isInvitePending, setIsInvitePending] = useState(false);
  const [rowBusyKey, setRowBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!loadState.capabilities.canManageMembers && filter === "invited") {
      setFilter("all");
    }
  }, [loadState.capabilities.canManageMembers, filter]);

  useEffect(() => {
    if (!isFilterOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Element)) {
        return;
      }
      const target = event.target;
      if (target.closest("[data-settings-members-filter-picker]")) {
        return;
      }
      setIsFilterOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isFilterOpen]);

  const { runRowAction, openConfirm, runConfirm, handleInvite } = useWorkspaceMembersAdminHandlers({
    token,
    workspaceId,
    showToast,
    refresh: loadState.refresh,
    pendingConfirm,
    setPendingConfirm,
    setIsConfirmPending,
    setIsInviteOpen,
    setIsInvitePending,
    setRowBusyKey,
    setOpenMenuKey,
  });

  const searchNeedle = search.trim().toLowerCase();
  const membersViewModel = buildMembersPanelViewModel({
    members: loadState.members,
    invitations: loadState.invitations,
    filter,
    searchNeedle,
  });
  const rowActions: MembersAdminRowActions = {
    token,
    workspaceId,
    viewerRole: loadState.viewerRole,
    capabilities: loadState.capabilities,
    openMenuKey,
    setOpenMenuKey,
    rowBusyKey,
    runRowAction,
    openConfirm,
    showToast,
  };

  return {
    loadError: loadState.loadError,
    search,
    setSearch,
    filter,
    setFilter,
    isFilterOpen,
    setIsFilterOpen,
    capabilities: loadState.capabilities,
    membersViewModel,
    rowActions,
    isLoaded: loadState.isLoaded,
    searchNeedle,
    pendingConfirm,
    isConfirmPending,
    setPendingConfirm,
    runConfirm,
    isInviteOpen,
    setIsInviteOpen,
    isInvitePending,
    handleInvite,
  };
}

type WorkspaceMembersAdminPanelModel = {
  loadError: string | null;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  filter: MemberFilter;
  setFilter: Dispatch<SetStateAction<MemberFilter>>;
  isFilterOpen: boolean;
  setIsFilterOpen: Dispatch<SetStateAction<boolean>>;
  capabilities: WorkspaceMembersResponse["capabilities"];
  membersViewModel: ReturnType<typeof buildMembersPanelViewModel>;
  rowActions: MembersAdminRowActions;
  isLoaded: boolean;
  searchNeedle: string;
  pendingConfirm: ConfirmState | null;
  isConfirmPending: boolean;
  setPendingConfirm: Dispatch<SetStateAction<ConfirmState | null>>;
  runConfirm: () => Promise<void>;
  isInviteOpen: boolean;
  setIsInviteOpen: Dispatch<SetStateAction<boolean>>;
  isInvitePending: boolean;
  handleInvite: (inviteInput: { emails: string[]; role: "admin" | "member" }) => Promise<void>;
};

function WorkspaceMembersAdminTableBody({
  membersViewModel,
  rowActions,
  isLoaded,
  loadError,
  searchNeedle,
}: Pick<
  WorkspaceMembersAdminPanelModel,
  "membersViewModel" | "rowActions" | "isLoaded" | "loadError" | "searchNeedle"
>) {
  const visibleRowCount =
    membersViewModel.activeMembers.length +
    membersViewModel.suspendedMembers.length +
    membersViewModel.visibleInvitations.length;

  return (
    <tbody>
      {membersViewModel.shouldShowActive && membersViewModel.activeMembers.length !== 0 ? (
        <>
          <MembersGroupHeader
            label={WORKSPACE_ADMIN_COPY.membersGroupActive}
            count={membersViewModel.activeMembers.length}
          />
          {membersViewModel.activeMembers.map((member) => (
            <AdminMemberTableRow key={`member:${member.userId}`} member={member} actions={rowActions} />
          ))}
        </>
      ) : null}
      {membersViewModel.shouldShowInvited && membersViewModel.visibleInvitations.length !== 0 ? (
        <>
          <MembersGroupHeader
            label={WORKSPACE_ADMIN_COPY.membersGroupInvited}
            count={membersViewModel.visibleInvitations.length}
          />
          {membersViewModel.visibleInvitations.map((invitation) => (
            <AdminInvitationTableRow key={`invitation:${invitation.id}`} invitation={invitation} actions={rowActions} />
          ))}
        </>
      ) : null}
      {membersViewModel.shouldShowSuspended && membersViewModel.suspendedMembers.length !== 0 ? (
        <>
          <MembersGroupHeader
            label={WORKSPACE_ADMIN_COPY.membersGroupSuspended}
            count={membersViewModel.suspendedMembers.length}
          />
          {membersViewModel.suspendedMembers.map((member) => (
            <AdminMemberTableRow key={`member:${member.userId}`} member={member} actions={rowActions} />
          ))}
        </>
      ) : null}
      {isLoaded && visibleRowCount === 0 ? (
        <tr>
          <td colSpan={MEMBERS_TABLE_COLUMN_COUNT} className="members-empty">
            {searchNeedle.length > 0 ? WORKSPACE_ADMIN_COPY.membersEmptySearch : WORKSPACE_ADMIN_COPY.membersEmpty}
          </td>
        </tr>
      ) : null}
      {!isLoaded && loadError === null ? (
        <tr>
          <td colSpan={MEMBERS_TABLE_COLUMN_COUNT}>
            <span className="workspace-loading-status" role="status">
              {WORKSPACE_ADMIN_COPY.membersLoading}
            </span>
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

function WorkspaceMembersAdminToolbar({
  search,
  setSearch,
  filter,
  setFilter,
  isFilterOpen,
  setIsFilterOpen,
  capabilities,
  setIsInviteOpen,
}: Pick<
  WorkspaceMembersAdminPanelModel,
  | "search"
  | "setSearch"
  | "filter"
  | "setFilter"
  | "isFilterOpen"
  | "setIsFilterOpen"
  | "capabilities"
  | "setIsInviteOpen"
>) {
  const handleFilterSelect = (nextFilter: MemberFilter) => {
    setFilter(nextFilter);
    setIsFilterOpen(false);
  };

  return (
    <div className="members-toolbar">
      <div className="members-search">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-task-topbar-search-icon" fill="none">
          <path
            d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        <input
          type="search"
          className="workspace-task-search-input"
          placeholder={WORKSPACE_ADMIN_COPY.membersSearchPlaceholder}
          aria-label={WORKSPACE_ADMIN_COPY.membersSearchLabel}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <MembersFilterDropdown
        value={filter}
        isOpen={isFilterOpen}
        shouldShowInvitations={capabilities.canManageMembers}
        onToggle={() => setIsFilterOpen((isFilterMenuOpen) => !isFilterMenuOpen)}
        onSelect={handleFilterSelect}
      />
      <span className="members-toolbar-spacer" />
      {capabilities.canInviteMembers ? (
        <button type="button" className="members-invite-button" onClick={() => setIsInviteOpen(true)}>
          {WORKSPACE_ADMIN_COPY.membersInviteButton}
        </button>
      ) : null}
    </div>
  );
}

function WorkspaceMembersAdminPanelView({
  loadError,
  search,
  setSearch,
  filter,
  setFilter,
  isFilterOpen,
  setIsFilterOpen,
  capabilities,
  membersViewModel,
  rowActions,
  isLoaded,
  searchNeedle,
  pendingConfirm,
  isConfirmPending,
  setPendingConfirm,
  runConfirm,
  isInviteOpen,
  setIsInviteOpen,
  isInvitePending,
  handleInvite,
}: WorkspaceMembersAdminPanelModel) {
  return (
    <section className="settings-section settings-members-section">
      <header className="settings-section-header">
        <h1>{WORKSPACE_ADMIN_COPY.membersSectionTitle}</h1>
      </header>

      {loadError !== null ? <p className="settings-error">{loadError}</p> : null}

      <WorkspaceMembersAdminToolbar
        search={search}
        setSearch={setSearch}
        filter={filter}
        setFilter={setFilter}
        isFilterOpen={isFilterOpen}
        setIsFilterOpen={setIsFilterOpen}
        capabilities={capabilities}
        setIsInviteOpen={setIsInviteOpen}
      />

      <div className="members-table-wrap">
        <table className="members-table">
          <thead>
            <tr>
              <th className="members-cell-name-header">{WORKSPACE_ADMIN_COPY.membersTableName}</th>
              <th className="members-cell-status-header">{WORKSPACE_ADMIN_COPY.membersTableStatus}</th>
              <th className="members-cell-date-joined">{WORKSPACE_ADMIN_COPY.membersTableJoined}</th>
              <th className="members-cell-date-seen">{WORKSPACE_ADMIN_COPY.membersTableLastSeen}</th>
              <th className="members-cell-actions-header">
                <span className="members-visually-hidden">{WORKSPACE_ADMIN_COPY.membersTableActions}</span>
              </th>
            </tr>
          </thead>
          <WorkspaceMembersAdminTableBody
            membersViewModel={membersViewModel}
            rowActions={rowActions}
            isLoaded={isLoaded}
            loadError={loadError}
            searchNeedle={searchNeedle}
          />
        </table>
      </div>

      {pendingConfirm !== null ? (
        <ConfirmDialog
          state={pendingConfirm}
          isPending={isConfirmPending}
          onCancel={() => {
            if (!isConfirmPending) {
              setPendingConfirm(null);
            }
          }}
          onConfirm={() => void runConfirm()}
        />
      ) : null}

      {isInviteOpen ? (
        <InviteModal
          isPending={isInvitePending}
          onClose={() => setIsInviteOpen(false)}
          onSubmit={(submitInput) => void handleInvite(submitInput)}
        />
      ) : null}
    </section>
  );
}

export function WorkspaceAdminMembersPanel({
  token,
  workspaceId,
  onViewerRoleChanged,
}: {
  token: string;
  workspaceId: string;
  onViewerRoleChanged?: (role: WorkspaceMemberRole) => void;
}) {
  const panel = useWorkspaceMembersAdminPanel({ token, workspaceId, onViewerRoleChanged });

  return <WorkspaceMembersAdminPanelView {...panel} />;
}
