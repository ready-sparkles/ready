"use client";

import { MemoryAllNavIcon } from "../workspace-nav-icons";

function MemoryListModeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="memory-layout-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 5.5L20 5.5" />
      <path d="M8 12.5L20 12.5" />
      <path d="M8 19.5L20 19.5" />
      <path
        fill="currentColor"
        d="M4.375 5.5H4.25M4.5 5.5C4.5 5.63807 4.38807 5.75 4.25 5.75C4.11193 5.75 4 5.63807 4 5.5C4 5.36193 4.11193 5.25 4.25 5.25C4.38807 5.25 4.5 5.36193 4.5 5.5Z"
      />
      <path
        fill="currentColor"
        d="M4.375 12.5H4.25M4.5 12.5C4.5 12.6381 4.38807 12.75 4.25 12.75C4.11193 12.75 4 12.6381 4 12.5C4 12.3619 4.11193 12.25 4.25 12.25C4.38807 12.25 4.5 12.3619 4.5 12.5Z"
      />
      <path
        fill="currentColor"
        d="M4.375 19.5H4.25M4.5 19.5C4.5 19.6381 4.38807 19.75 4.25 19.75C4.11193 19.75 4 19.6381 4 19.5C4 19.3619 4.11193 19.25 4.25 19.25C4.38807 19.25 4.5 19.3619 4.5 19.5Z"
      />
    </svg>
  );
}

export type MemoryDisplayMode = "list" | "stack";
export function MemoryLayoutToggle({
  mode,
  onChange,
}: {
  mode: MemoryDisplayMode;
  onChange: (mode: MemoryDisplayMode) => void;
}) {
  return (
    <div className="memory-layout-toggle" role="group" aria-label="Memory layout">
      <button
        type="button"
        className="memory-layout-toggle-button"
        aria-label="List view"
        title="List view"
        aria-pressed={mode === "list"}
        onClick={() => onChange("list")}
      >
        <MemoryListModeIcon />
      </button>
      <button
        type="button"
        className="memory-layout-toggle-button"
        aria-label="Card view"
        title="Card view"
        aria-pressed={mode === "stack"}
        onClick={() => onChange("stack")}
      >
        <MemoryAllNavIcon className="memory-layout-icon" />
      </button>
    </div>
  );
}
