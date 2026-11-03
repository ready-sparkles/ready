"use client";
import type { MeetingTrackerItem, MeetingTrackerState } from "@readymeet/shared";
import { type ReactNode, useEffect } from "react";

const MEETING_TRACKER_COPY = {
  close: "Close summary",
  title: "Summary",
  delayed: "Live updates are delayed. New speech will retry automatically.",
  unavailable: "Meeting tracking is not available.",
  empty: "None yet",
  resolved: "Resolved",
  closeGlyph: "×",
} as const;
const sections = [
  ["agreement", "Decisions"],
  ["open_item", "Open questions"],
  ["next_step", "Tasks"],
] as const;
function hasText(value: string | null): value is string {
  return value !== null && value !== "";
}

function MeetingTrackerSection({ title, items }: { title: string; items: MeetingTrackerItem[] }): ReactNode {
  return (
    <section className="live-ambient-context-research live-meeting-tracker-section">
      <h3 className="live-ambient-standing-heading">{title}</h3>
      {items.length !== 0 ? (
        <ul className="live-web-search-reasons live-ambient-context-facts is-standing">
          {items.map((item) => (
            <li key={item.id}>
              <span>{item.text}</span>
              {hasText(item.owner) || hasText(item.due) || item.status === "resolved" ? (
                <span className="live-web-search-result-meta live-meeting-tracker-meta">
                  {[item.owner, item.due, item.status === "resolved" ? MEETING_TRACKER_COPY.resolved : null]
                    .filter(hasText)
                    .join(" · ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="live-web-search-result-meta">{MEETING_TRACKER_COPY.empty}</p>
      )}
    </section>
  );
}

export function MeetingTrackerPanel({
  state,
  hasError,
  isOpen,
  onClose,
}: {
  state: MeetingTrackerState | null;
  hasError: boolean;
  isOpen: boolean;
  onClose: () => void;
}): ReactNode {
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);
  const sectionItems = sections.map(([section, title]) => ({
    section,
    title,
    items:
      state?.items.filter(
        (item) =>
          item.section === section &&
          item.status !== "cancelled" &&
          (section === "agreement" || item.status !== "resolved"),
      ) ?? [],
  }));

  return (
    <>
      <button
        type="button"
        className={`live-presence-backdrop${isOpen ? " is-open" : ""}`}
        aria-label={MEETING_TRACKER_COPY.close}
        aria-hidden={!isOpen}
        tabIndex={isOpen ? 0 : -1}
        onClick={onClose}
      />
      <aside
        className={`live-presence-panel live-web-search-sheet live-ambient-context-sheet live-meeting-tracker${isOpen ? " is-open" : ""}`}
        aria-label={MEETING_TRACKER_COPY.title}
        aria-hidden={!isOpen}
        inert={!isOpen}
      >
        <div className="live-presence-sheet-header live-ambient-context-header">
          <strong>{MEETING_TRACKER_COPY.title}</strong>
          <button
            type="button"
            className="live-presence-sheet-close"
            aria-label={MEETING_TRACKER_COPY.close}
            onClick={onClose}
          >
            {MEETING_TRACKER_COPY.closeGlyph}
          </button>
        </div>
        <div className="live-web-search-body live-ambient-context-body">
          {hasError || state?.status === "failed" ? (
            <p role="status" className="live-web-search-result-meta">
              {MEETING_TRACKER_COPY.delayed}
            </p>
          ) : null}
          {state?.status === "unavailable" ? (
            <p className="live-web-search-result-meta">{MEETING_TRACKER_COPY.unavailable}</p>
          ) : (
            sectionItems.map(({ section, title, items }) => (
              <MeetingTrackerSection key={section} title={title} items={items} />
            ))
          )}
        </div>
      </aside>
    </>
  );
}
