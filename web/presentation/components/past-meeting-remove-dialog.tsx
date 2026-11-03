"use client";

import type { Meeting } from "@readymeet/shared";
import { useEffect, useId } from "react";
import { createPortal } from "react-dom";

const PAST_MEETING_REMOVE_TITLE = "Remove past meeting?";
const PAST_MEETING_REMOVE_DESCRIPTION_PREFIX = 'Remove "';
const PAST_MEETING_REMOVE_DESCRIPTION_SUFFIX = '" from your past meetings. This cannot be undone.';

export function PastMeetingRemoveDialog({
  meeting,
  isPending,
  error,
  onCancel,
  onConfirm,
}: {
  meeting: Meeting | null;
  isPending: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (meeting === null) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isPending) {
        event.preventDefault();
        onCancel();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isPending, meeting, onCancel]);

  if (meeting === null || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="past-meeting-remove-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPending) {
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
            {PAST_MEETING_REMOVE_TITLE}
          </h3>
          <p id={descriptionId} className="past-meeting-remove-description">
            {PAST_MEETING_REMOVE_DESCRIPTION_PREFIX}
            {meeting.title}
            {PAST_MEETING_REMOVE_DESCRIPTION_SUFFIX}
          </p>
          {error !== null && error !== undefined && error !== "" ? (
            <p className="past-meeting-remove-error">{error}</p>
          ) : null}
        </div>
        <div className="past-meeting-remove-actions">
          <button type="button" className="past-meeting-remove-cancel" disabled={isPending} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="past-meeting-remove-confirm" disabled={isPending} onClick={onConfirm}>
            Remove
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
