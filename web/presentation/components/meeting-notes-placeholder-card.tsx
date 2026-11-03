"use client";

import { cn } from "../../domain/utils";

function MeetingNotesDocumentIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-brief-card-icon guest-notes-document-icon meeting-notes-document-icon"
      fill="none"
    >
      <path
        d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MeetingNotesPlaceholderCard({
  cardClassName,
  contentClassName,
  description,
  title,
}: {
  cardClassName?: string;
  contentClassName?: string;
  description: string;
  title: string;
}) {
  return (
    <div className={cn("workspace-meeting-brief-content", contentClassName)}>
      <div className="workspace-meeting-brief-cards">
        <section className={cn("workspace-meeting-brief-card workspace-ready-meeting-card", cardClassName)}>
          <div className="workspace-meeting-brief-card-inner">
            <div className="workspace-meeting-brief-card-head">
              <span className="workspace-brief-card-icon-tile workspace-ready-meeting-logo-tile">
                <MeetingNotesDocumentIcon />
              </span>
            </div>
            <div className="workspace-meeting-brief-card-copy">
              <h5 className="workspace-meeting-brief-card-title">{title}</h5>
              <p className="workspace-meeting-brief-card-description">{description}</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
