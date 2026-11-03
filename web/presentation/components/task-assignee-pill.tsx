"use client";

import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type TaskAssigneeParticipant = {
  userId: string;
  displayName: string;
  email?: string | null;
  avatarUrl: string | null;
};

export function mergeTaskAssigneeParticipants(
  ...args: [primary: TaskAssigneeParticipant[], additional: TaskAssigneeParticipant[]]
) {
  const [primary, additional] = args;
  const merged = additional.reduce(
    (participants, participant) => {
      const existing = participants.get(participant.userId);
      const next = new Map(participants);
      next.set(
        participant.userId,
        existing
          ? {
              ...participant,
              displayName: existing.displayName,
              email: existing.email ?? participant.email,
              avatarUrl: existing.avatarUrl ?? participant.avatarUrl,
            }
          : participant,
      );

      return next;
    },
    new Map(primary.map((participant) => [participant.userId, participant])),
  );

  return Array.from(merged.values());
}

const ASSIGNEE_MENU_OPEN_EVENT = "readymeet:task-assignee-menu-open";
const ASSIGNEE_MENU_GAP_PX = 6;
const ASSIGNEE_MENU_VIEWPORT_MARGIN_PX = 8;
const ASSIGNEE_MENU_FALLBACK_WIDTH_PX = 224;
const ASSIGNEE_MENU_MOBILE_ALIGN_BREAKPOINT_PX = 1000;
const ASSIGNEE_INITIALS_SINGLE_NAME_MAX_CHARS = 2;
const TASK_ASSIGNEE_UNASSIGNED_LABEL = "Unassigned";

type TaskAssigneeMenuPositionInput = {
  anchor: Pick<DOMRect, "top" | "left" | "right" | "bottom">;
  align?: "start" | "end";
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

export function calculateTaskAssigneeMenuPosition({
  anchor,
  align = "end",
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
}: TaskAssigneeMenuPositionInput) {
  const margin = ASSIGNEE_MENU_VIEWPORT_MARGIN_PX;
  const maximumLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const left = Math.min(maximumLeft, Math.max(margin, align === "start" ? anchor.left : anchor.right - menuWidth));
  const belowTop = anchor.bottom + ASSIGNEE_MENU_GAP_PX;
  const aboveTop = anchor.top - ASSIGNEE_MENU_GAP_PX - menuHeight;
  const isFittingBelow = belowTop + menuHeight <= viewportHeight - margin;
  const isFittingAbove = aboveTop >= margin;
  const maximumTop = Math.max(margin, viewportHeight - menuHeight - margin);
  const top = !isFittingBelow && isFittingAbove ? aboveTop : Math.min(maximumTop, Math.max(margin, belowTop));

  return { top, left };
}

export function trackTaskAssigneeMenuPosition(input: {
  measure: () => void;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (frameId: number) => void;
}) {
  const tracking: { isStopped: boolean; frameId: number | null } = { isStopped: false, frameId: null };
  const tick = () => {
    if (tracking.isStopped) {
      return;
    }
    input.measure();
    tracking.frameId = input.requestFrame(tick);
  };

  input.measure();
  tracking.frameId = input.requestFrame(tick);

  return () => {
    tracking.isStopped = true;
    if (tracking.frameId !== null) {
      input.cancelFrame(tracking.frameId);
    }
  };
}

function UnassignedOwnerIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" className="task-assignee-icon is-outline">
      <path
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
      />
    </svg>
  );
}

function assigneeInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts.at(-1);
  const firstCharacter = first?.[0] ?? "";
  const lastCharacter = last?.[0] ?? "";
  const initials =
    parts.length > 1
      ? `${firstCharacter}${lastCharacter}`
      : (first?.slice(0, ASSIGNEE_INITIALS_SINGLE_NAME_MAX_CHARS) ?? "");
  const upper = initials.toUpperCase();

  return upper.length > 0 ? upper : "?";
}

function AssigneeIcon({ assignee }: { assignee: TaskAssigneeParticipant | null }) {
  if (!assignee) {
    return <UnassignedOwnerIcon />;
  }

  if (assignee.avatarUrl !== null && assignee.avatarUrl.length > 0) {
    return <img src={assignee.avatarUrl} alt="" className="task-assignee-avatar" />;
  }

  return (
    <span className="task-assignee-initials" aria-hidden="true">
      {assigneeInitials(assignee.displayName)}
    </span>
  );
}

function normalizeAssigneeName(name: string) {
  return name.trim().toLowerCase();
}

function assigneeEmailLabel(participant: TaskAssigneeParticipant) {
  const trimmed = participant.email?.trim();
  if (trimmed === undefined || trimmed === "") {
    return null;
  }

  return trimmed;
}

function buildDuplicateAssigneeNameKeys(input: { participants: TaskAssigneeParticipant[] }) {
  return new Set(
    input.participants
      .map((participant) => normalizeAssigneeName(participant.displayName))
      .filter((name, index, names) => name.length > 0 && names.indexOf(name) !== index),
  );
}

function taskAssigneeMenuAlign(input: { viewportWidth: number }): "start" | "end" {
  return input.viewportWidth <= ASSIGNEE_MENU_MOBILE_ALIGN_BREAKPOINT_PX ? "start" : "end";
}

function taskAssigneePillTitle(input: {
  assignee: TaskAssigneeParticipant | null;
  label: string;
  duplicateNameKeys: Set<string>;
}) {
  const email = input.assignee?.email?.trim();
  if (
    email !== undefined &&
    email !== "" &&
    input.assignee !== null &&
    input.duplicateNameKeys.has(normalizeAssigneeName(input.assignee.displayName))
  ) {
    return `${input.label} (${email})`;
  }

  return input.label;
}

function useTaskAssigneePeerMenuClose(input: { rootRef: RefObject<HTMLDivElement | null>; onClose: () => void }) {
  useEffect(() => {
    function handlePeerOpen(event: Event) {
      if (event instanceof CustomEvent && event.detail !== input.rootRef.current) {
        input.onClose();
      }
    }

    document.addEventListener(ASSIGNEE_MENU_OPEN_EVENT, handlePeerOpen);

    return () => {
      document.removeEventListener(ASSIGNEE_MENU_OPEN_EVENT, handlePeerOpen);
    };
  }, [input.onClose, input.rootRef]);
}

function useTaskAssigneeMenuDismissal(input: {
  isOpen: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!input.isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!(event.target instanceof Node)) {
        return;
      }
      const target = event.target;
      if (!(input.rootRef.current?.contains(target) ?? false) && !(input.menuRef.current?.contains(target) ?? false)) {
        input.onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        input.onClose();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [input.isOpen, input.menuRef, input.onClose, input.rootRef]);
}

function useTaskAssigneeMenuPositionTracking(input: {
  isOpen: boolean;
  participantCount: number;
  rootRef: RefObject<HTMLDivElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  setMenuPosition: Dispatch<SetStateAction<{ top: number; left: number } | null>>;
}) {
  useEffect(() => {
    if (!input.isOpen) {
      input.setMenuPosition(() => null);

      return;
    }

    function measureMenuPosition() {
      const anchor = input.rootRef.current;
      if (!anchor) {
        return;
      }
      const menu = input.menuRef.current;
      const nextPosition = calculateTaskAssigneeMenuPosition({
        anchor: anchor.getBoundingClientRect(),
        align: taskAssigneeMenuAlign({ viewportWidth: window.innerWidth }),
        menuWidth: menu?.offsetWidth ?? ASSIGNEE_MENU_FALLBACK_WIDTH_PX,
        menuHeight: menu?.offsetHeight ?? 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
      input.setMenuPosition((current) =>
        current?.top === nextPosition.top && current.left === nextPosition.left ? current : nextPosition,
      );
    }

    // Row reveal, merge, and Linear-exit animations can move the trigger via
    // transforms without producing scroll, resize, or ResizeObserver events.
    // Track it for every painted frame while this one menu is open, then stop
    // completely as soon as the menu closes.
    return trackTaskAssigneeMenuPosition({
      measure: measureMenuPosition,
      requestFrame: (callback) => window.requestAnimationFrame(callback),
      cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
    });
  }, [input.isOpen, input.menuRef, input.participantCount, input.rootRef, input.setMenuPosition]);
}

async function selectTaskAssignee(input: {
  assignee: TaskAssigneeParticipant | null;
  userId: string | null;
  onChange: (userId: string | null) => Promise<void> | void;
  onClose: () => void;
}) {
  if ((input.assignee?.userId ?? null) === input.userId) {
    input.onClose();

    return;
  }

  try {
    await input.onChange(input.userId);
    input.onClose();
  } catch (error) {
    if (error instanceof Error) {
      // Parent state rolls back optimistic changes.
      return;
    }
  }
}

function handleTaskAssigneePillToggle(input: {
  event: ReactMouseEvent<HTMLButtonElement>;
  isOpen: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  setIsOpen: (isOpen: boolean) => void;
  setMenuPosition: (position: { top: number; left: number }) => void;
  onOpen?: () => Promise<void> | void;
}) {
  input.event.stopPropagation();
  const isOpening = !input.isOpen;
  if (isOpening) {
    const anchor = input.rootRef.current?.getBoundingClientRect();
    if (anchor) {
      input.setMenuPosition(
        calculateTaskAssigneeMenuPosition({
          anchor,
          align: taskAssigneeMenuAlign({ viewportWidth: window.innerWidth }),
          menuWidth: ASSIGNEE_MENU_FALLBACK_WIDTH_PX,
          menuHeight: 0,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    }
    document.dispatchEvent(new CustomEvent(ASSIGNEE_MENU_OPEN_EVENT, { detail: input.rootRef.current }));
    void input.onOpen?.();
  }
  input.setIsOpen(isOpening);
}

function TaskAssigneeParticipantOption(input: {
  participant: TaskAssigneeParticipant;
  assignee: TaskAssigneeParticipant | null;
  duplicateNameKeys: Set<string>;
  onSelect: (userId: string) => void;
}) {
  const shouldDisambiguate = input.duplicateNameKeys.has(normalizeAssigneeName(input.participant.displayName));
  const emailLabel = shouldDisambiguate ? assigneeEmailLabel(input.participant) : null;
  const isSelected = input.assignee?.userId === input.participant.userId;

  return (
    <button
      type="button"
      className={`task-assignee-option${isSelected ? " is-selected" : ""}`}
      role="option"
      aria-selected={isSelected}
      onClick={() => input.onSelect(input.participant.userId)}
    >
      <AssigneeIcon assignee={input.participant} />
      <span className="task-assignee-option-label">
        <span className="task-assignee-option-name">{input.participant.displayName}</span>
        {emailLabel !== null ? <span className="task-assignee-option-email">{emailLabel}</span> : null}
      </span>
    </button>
  );
}

function TaskAssigneeMenuPortal(input: {
  menuRef: RefObject<HTMLDivElement | null>;
  menuPosition: { top: number; left: number };
  assignee: TaskAssigneeParticipant | null;
  participants: TaskAssigneeParticipant[];
  duplicateNameKeys: Set<string>;
  onSelect: (userId: string | null) => void;
}) {
  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={input.menuRef}
      className="task-assignee-menu"
      role="listbox"
      aria-label="Assign task"
      style={{ top: input.menuPosition.top, left: input.menuPosition.left }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`task-assignee-option${input.assignee ? "" : " is-selected"}`}
        role="option"
        aria-selected={!input.assignee}
        onClick={() => input.onSelect(null)}
      >
        <AssigneeIcon assignee={null} />
        <span>{TASK_ASSIGNEE_UNASSIGNED_LABEL}</span>
      </button>
      {input.participants.map((participant) => (
        <TaskAssigneeParticipantOption
          key={participant.userId}
          participant={participant}
          assignee={input.assignee}
          duplicateNameKeys={input.duplicateNameKeys}
          onSelect={(userId) => input.onSelect(userId)}
        />
      ))}
    </div>,
    document.body,
  );
}

type TaskAssigneePillProps = {
  assignee: TaskAssigneeParticipant | null;
  participants: TaskAssigneeParticipant[];
  /** @external TaskAssigneePill consumer prop */
  disabled?: boolean;
  variant?: "pill" | "avatar";
  /** @external TaskAssigneePill consumer prop */
  expandOnMobile?: boolean;
  onOpen?: () => Promise<void> | void;
  onChange: (userId: string | null) => Promise<void> | void;
};

export function TaskAssigneePill(props: TaskAssigneePillProps) {
  const { assignee, participants, onOpen, onChange } = props;
  const variant = props.variant ?? "pill";
  const hasMobilePillExpansion = props.expandOnMobile ?? false;
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = assignee?.displayName ?? TASK_ASSIGNEE_UNASSIGNED_LABEL;
  const duplicateNameKeys = buildDuplicateAssigneeNameKeys({ participants });
  const closeMenu = () => setIsOpen(false);

  useTaskAssigneePeerMenuClose({ rootRef, onClose: closeMenu });
  useTaskAssigneeMenuDismissal({ isOpen, rootRef, menuRef, onClose: closeMenu });
  useTaskAssigneeMenuPositionTracking({
    isOpen,
    participantCount: participants.length,
    rootRef,
    menuRef,
    setMenuPosition,
  });

  function handleButtonPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }

  return (
    <div
      ref={rootRef}
      className={`task-assignee-control${variant === "avatar" ? " is-avatar" : ""}${hasMobilePillExpansion ? " is-mobile-pill" : ""}`}
    >
      <button
        type="button"
        className={`task-assignee-pill${assignee ? "" : " is-unassigned"}${variant === "avatar" ? " is-avatar" : ""}${hasMobilePillExpansion ? " is-mobile-pill" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`Assign task: ${label}`}
        disabled={props.disabled}
        title={taskAssigneePillTitle({ assignee, label, duplicateNameKeys })}
        onPointerDown={handleButtonPointerDown}
        onClick={(event) =>
          handleTaskAssigneePillToggle({
            event,
            isOpen,
            rootRef,
            setIsOpen,
            setMenuPosition,
            onOpen,
          })
        }
      >
        <AssigneeIcon assignee={assignee} />
        {variant === "pill" || hasMobilePillExpansion ? <span className="task-assignee-name">{label}</span> : null}
      </button>

      {isOpen && menuPosition !== null && typeof document !== "undefined"
        ? TaskAssigneeMenuPortal({
            menuRef,
            menuPosition,
            assignee,
            participants,
            duplicateNameKeys,
            onSelect: (userId) => void selectTaskAssignee({ assignee, userId, onChange, onClose: closeMenu }),
          })
        : null}
    </div>
  );
}
