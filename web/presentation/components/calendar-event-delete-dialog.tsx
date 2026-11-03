"use client";

import type { NormalizedCalendarEvent } from "@readymeet/shared";
import { useEffect, useId } from "react";
import { createPortal } from "react-dom";

import { getCalendarEventTitle } from "../../domain/calendar-events";

const DELETE_DIALOG_TITLE = "Delete calendar event?";
const DELETE_DIALOG_DESCRIPTION_PREFIX = 'Delete "';
const DELETE_DIALOG_DESCRIPTION_SUFFIX = '" from your Google Calendar. This cannot be undone in Ready.';
const DELETE_DIALOG_CANCEL_LABEL = "Cancel";
const DELETE_DIALOG_CONFIRM_PENDING_LABEL = "Deleting...";
const DELETE_DIALOG_CONFIRM_LABEL = "Delete event";

type CalendarEventDeleteDialogProps = {
  event: NormalizedCalendarEvent | null;
  /** @external existing wire contract */
  pending: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
};

export function CalendarEventDeleteDialog({
  event,
  pending: isDeletePending,
  error,
  onCancel,
  onConfirm,
}: CalendarEventDeleteDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (event === null) {
      return;
    }

    function onKeyDown(keyboardEvent: KeyboardEvent) {
      if (keyboardEvent.key === "Escape" && !isDeletePending) {
        keyboardEvent.preventDefault();
        onCancel();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [event, onCancel, isDeletePending]);

  if (event === null || typeof document === "undefined") {
    return null;
  }

  const errorMessage = error ?? null;

  return createPortal(
    <div
      className="past-meeting-remove-backdrop"
      role="presentation"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.target === mouseEvent.currentTarget && !isDeletePending) {
          onCancel();
        }
      }}
    >
      <section
        className="past-meeting-remove-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="past-meeting-remove-copy">
          <h3 id={titleId} className="past-meeting-remove-title">
            {DELETE_DIALOG_TITLE}
          </h3>
          <p id={descriptionId}>
            {DELETE_DIALOG_DESCRIPTION_PREFIX}
            {getCalendarEventTitle(event)}
            {DELETE_DIALOG_DESCRIPTION_SUFFIX}
          </p>
          {errorMessage !== null && errorMessage.length > 0 ? (
            <p className="past-meeting-remove-error">{errorMessage}</p>
          ) : null}
        </div>
        <div className="past-meeting-remove-actions">
          <button type="button" className="past-meeting-remove-cancel" disabled={isDeletePending} onClick={onCancel}>
            {DELETE_DIALOG_CANCEL_LABEL}
          </button>
          <button type="button" className="past-meeting-remove-confirm" disabled={isDeletePending} onClick={onConfirm}>
            {isDeletePending ? DELETE_DIALOG_CONFIRM_PENDING_LABEL : DELETE_DIALOG_CONFIRM_LABEL}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
