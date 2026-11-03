import type { ReactNode } from "react";

export function MeetingEndControls({
  isOrganizer,
  isOpen,
  isLeaving,
  isJoining: isJoiningMeeting = false,
  onToggleMenu,
  onLeave,
  onEndForAll,
  children,
}: {
  isOrganizer: boolean;
  isOpen: boolean;
  isLeaving: boolean;
  /** @external meeting end controls joining state */
  isJoining?: boolean;
  onToggleMenu: () => void;
  onLeave: () => void;
  onEndForAll: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        className="danger-button"
        onClick={isOrganizer ? onToggleMenu : onLeave}
        onPointerUp={(event) => event.currentTarget.blur()}
        disabled={isLeaving || isJoiningMeeting}
        aria-label={isOrganizer ? "Meeting end options" : "Leave meeting"}
        aria-haspopup={isOrganizer ? "menu" : undefined}
        aria-expanded={isOrganizer ? isOpen : undefined}
        title={isOrganizer ? "Meeting end options" : "Leave meeting"}
      >
        {children}
      </button>
      {isOrganizer && isOpen ? (
        <div className="live-end-meeting-popover" role="menu" aria-label="Meeting end options">
          <button
            type="button"
            role="menuitem"
            className="live-end-meeting-menu-item is-danger"
            onClick={onEndForAll}
            disabled={isLeaving || isJoiningMeeting}
          >
            End meeting for all
          </button>
          <button
            type="button"
            role="menuitem"
            className="live-end-meeting-menu-item"
            onClick={onLeave}
            disabled={isLeaving || isJoiningMeeting}
          >
            Leave meeting
          </button>
        </div>
      ) : null}
    </>
  );
}
