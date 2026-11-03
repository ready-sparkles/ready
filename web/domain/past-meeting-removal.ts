type ShortcutEventLike = {
  key: string;
  /** @external DOM KeyboardEvent modifier key contract */
  altKey?: boolean;
  /** @external DOM KeyboardEvent modifier key contract */
  ctrlKey?: boolean;
  /** @external DOM KeyboardEvent modifier key contract */
  metaKey?: boolean;
  /** @external DOM KeyboardEvent modifier key contract */
  shiftKey?: boolean;
  /** @external DOM Event defaultPrevented contract */
  defaultPrevented?: boolean;
  target?: unknown;
};

type ShortcutContext = {
  view: "past" | "upcoming";
  hasSelectedMeeting?: boolean;
  hasSelectedCalendarEvent?: boolean;
  hasActiveOverlay?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEditableShortcutTarget(target: unknown) {
  if (!isRecord(target)) {
    return false;
  }

  if (target.isContentEditable === true) {
    return true;
  }

  const tagName = typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }

  const closest = target.closest;
  if (typeof closest !== "function") {
    return false;
  }

  return Boolean(closest.call(target, '[contenteditable="true"], [contenteditable=""], [contenteditable=true]'));
}

export function shouldOpenPastMeetingRemoveShortcut(input: {
  event: ShortcutEventLike;
  context: ShortcutContext;
}): boolean {
  const { event, context } = input;
  if (event.defaultPrevented === true) {
    return false;
  }

  if (event.key !== "Delete" && event.key !== "Backspace") {
    return false;
  }

  if (event.altKey === true || event.ctrlKey === true || event.metaKey === true || event.shiftKey === true) {
    return false;
  }

  const hasSelectedTarget =
    context.view === "past" ? Boolean(context.hasSelectedMeeting) : Boolean(context.hasSelectedCalendarEvent);

  if (!hasSelectedTarget || context.hasActiveOverlay === true) {
    return false;
  }

  return !isEditableShortcutTarget(event.target);
}
