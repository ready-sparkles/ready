"use client";

// Icons for the workspace shell rail and nav. Kept dependency-free so the
// public home page showcase can reuse them without pulling in the shell's
// runtime dependencies.

export function GiftIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      className="workspace-beta-credit-icon"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M21 11.25v8.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 1 0 9.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1 1 14.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z"
      />
    </svg>
  );
}

export function ArrowForwardIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20.292 16.2959" className="workspace-beta-credit-arrow">
      <path
        d="M11.7842 16.2852C12.042 16.2852 12.2676 16.1885 12.4824 15.9844L19.626 8.8623C19.8408 8.6582 19.9482 8.41113 19.9482 8.14258C19.9482 7.87402 19.8408 7.62695 19.626 7.42285L12.5039 0.322266C12.2676 0.0859375 12.042 0 11.7842 0C11.2578 0 10.8496 0.386719 10.8496 0.923828C10.8496 1.18164 10.9355 1.42871 11.1074 1.60059L13.5137 4.0498L17.9932 8.14258L13.5137 12.2354L11.1074 14.6846C10.9355 14.8457 10.8496 15.1035 10.8496 15.3613C10.8496 15.8984 11.2578 16.2852 11.7842 16.2852ZM0.945312 9.09863L14.5342 9.09863L17.9932 8.88379C18.4336 8.85156 18.7344 8.58301 18.7344 8.14258C18.7344 7.70215 18.4336 7.43359 17.9932 7.40137L14.5342 7.18652L0.945312 7.18652C0.386719 7.18652 0 7.58398 0 8.14258C0 8.70117 0.386719 9.09863 0.945312 9.09863Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function CalendarStackIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon workspace-upcoming-nav-icon workspace-visual-compact-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.00008 11.9999C3.00008 7.75727 3.00008 5.63595 4.3181 4.31793C5.63612 2.99991 7.75744 2.99991 12.0001 2.99991C16.2427 2.99991 18.364 2.99991 19.6821 4.31793C21.0001 5.63595 21.0001 7.75727 21.0001 11.9999C21.0001 16.2426 21.0001 18.3639 19.6821 19.6819C18.364 20.9999 16.2427 20.9999 12.0001 20.9999C7.75744 20.9999 5.63612 20.9999 4.3181 19.6819C3.00008 18.3639 3.00008 16.2426 3.00008 11.9999Z" />
      <path d="M3.50008 7.99991H20.5001" />
      <path d="M12.0001 16.4999H17.0001M7.00008 16.4999H8.00008" />
      <path d="M12.0001 12.4999H17.0001M7.00008 12.4999H8.00008" />
    </svg>
  );
}

export function ArchiveTrayIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon workspace-calendar-nav-icon workspace-visual-compact-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 10.5V9.99995C19 6.22876 18.9999 4.34311 17.8284 3.17154C16.6568 2 14.7712 2 11 2C7.22889 2 5.34326 2.00006 4.17169 3.17159C3.00015 4.34315 3.00013 6.22872 3.0001 9.99988L3.00006 14.5C3.00003 17.7874 3.00002 19.4312 3.90794 20.5375C4.07418 20.7401 4.25992 20.9258 4.46249 21.0921C5.56883 22 7.21255 22 10.5 22" />
      <path d="M7 7H15M7 11H11" />
      <path d="M18 18.5L16.5 17.95V15.5M12 17.5C12 19.9853 14.0147 22 16.5 22C18.9853 22 21 19.9853 21 17.5C21 15.0147 18.9853 13 16.5 13C14.0147 13 12 15.0147 12 17.5Z" />
    </svg>
  );
}

export function StarNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon workspace-calendar-nav-icon workspace-task-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.7276 3.44418L15.4874 6.99288C15.7274 7.48687 16.3673 7.9607 16.9073 8.05143L20.0969 8.58575C22.1367 8.92853 22.6167 10.4206 21.1468 11.8925L18.6671 14.3927C18.2471 14.8161 18.0172 15.6327 18.1471 16.2175L18.8571 19.3125C19.417 21.7623 18.1271 22.71 15.9774 21.4296L12.9877 19.6452C12.4478 19.3226 11.5579 19.3226 11.0079 19.6452L8.01827 21.4296C5.8785 22.71 4.57865 21.7522 5.13859 19.3125L5.84851 16.2175C5.97849 15.6327 5.74852 14.8161 5.32856 14.3927L2.84884 11.8925C1.389 10.4206 1.85895 8.92853 3.89872 8.58575L7.08837 8.05143C7.61831 7.9607 8.25824 7.48687 8.49821 6.99288L10.258 3.44418C11.2179 1.51861 12.7777 1.51861 13.7276 3.44418Z" />
    </svg>
  );
}

export function LayersNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon workspace-calendar-nav-icon workspace-lowered-nav-icon workspace-task-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8.64298 3.14559L6.93816 3.93362C4.31272 5.14719 3 5.75397 3 6.75C3 7.74603 4.31272 8.35281 6.93817 9.56638L8.64298 10.3544C10.2952 11.1181 11.1214 11.5 12 11.5C12.8786 11.5 13.7048 11.1181 15.357 10.3544L17.0618 9.56638C19.6873 8.35281 21 7.74603 21 6.75C21 5.75397 19.6873 5.14719 17.0618 3.93362L15.357 3.14559C13.7048 2.38186 12.8786 2 12 2C11.1214 2 10.2952 2.38186 8.64298 3.14559Z" />
      <path d="M20.788 11.0972C20.9293 11.2959 21 11.5031 21 11.7309C21 12.7127 19.6873 13.3109 17.0618 14.5072L15.357 15.284C13.7048 16.0368 12.8786 16.4133 12 16.4133C11.1214 16.4133 10.2952 16.0368 8.64298 15.284L6.93817 14.5072C4.31272 13.3109 3 12.7127 3 11.7309C3 11.5031 3.07067 11.2959 3.212 11.0972" />
      <path d="M20.3767 16.2661C20.7922 16.5971 21 16.927 21 17.3176C21 18.2995 19.6873 18.8976 17.0618 20.0939L15.357 20.8707C13.7048 21.6236 12.8786 22 12 22C11.1214 22 10.2952 21.6236 8.64298 20.8707L6.93817 20.0939C4.31272 18.8976 3 18.2995 3 17.3176C3 16.927 3.20778 16.5971 3.62334 16.2661" />
    </svg>
  );
}

export function ActivityNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon workspace-calendar-nav-icon workspace-done-nav-icon workspace-task-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12Z" />
      <path d="M8 12.5L10.5 15L16 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function VideoPlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-nav-icon" fill="none">
      <path
        d="M5.25 5.25H12.75C14.4069 5.25 15.75 6.59315 15.75 8.25V15.75C15.75 17.4069 14.4069 18.75 12.75 18.75H5.25C3.59315 18.75 2.25 17.4069 2.25 15.75V8.25C2.25 6.59315 3.59315 5.25 5.25 5.25Z"
        fill="currentColor"
      />
      <path
        d="M16.5 10.1893L20.47 6.2193C20.9425 5.74684 21.75 6.0815 21.75 6.75V17.25C21.75 17.9185 20.9425 18.2532 20.47 17.7807L16.5 13.8107V10.1893Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="workspace-account-chevron" fill="none">
      <path
        d="M4.25 6.5L8 10.25L11.75 6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CalendarChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12.9121 18.6592" className="workspace-upcoming-calendar-nav-icon">
      <path
        d="M12.9121 9.32422C12.9121 9.05566 12.8047 8.80859 12.6006 8.61523L4.09277 0.279297C3.89941 0.0966797 3.66309 0 3.38379 0C2.83594 0 2.40625 0.418945 2.40625 0.977539C2.40625 1.24609 2.51367 1.49316 2.68555 1.67578L10.5059 9.32422L2.68555 16.9727C2.51367 17.1553 2.40625 17.3916 2.40625 17.6709C2.40625 18.2295 2.83594 18.6484 3.38379 18.6484C3.66309 18.6484 3.89941 18.5518 4.09277 18.3584L12.6006 10.0332C12.8047 9.8291 12.9121 9.59277 12.9121 9.32422Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function PeopleNavIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-nav-icon workspace-visual-compact-nav-icon"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18.5 7C18.5 9.20914 16.7091 11 14.5 11C12.2909 11 10.5 9.20914 10.5 7C10.5 4.79086 12.2909 3 14.5 3C16.7091 3 18.5 4.79086 18.5 7Z" />
      <path d="M8 11C6.34315 11 5 9.65685 5 8C5 6.34315 6.34315 5 8 5" />
      <path d="M14.5 14C9.8125 14 7 16.5 7 19C7 20.1046 7.83947 21 8.875 21H20.125C21.1605 21 22 20.1046 22 19C22 16.5 19.1875 14 14.5 14Z" />
      <path d="M4 19.9992H3.5C2.67157 19.9992 2 19.2317 2 18.2849C2 16.673 3.27307 15.0612 5.5 14.3613" />
    </svg>
  );
}

export function MemoryAllNavIcon({
  className = "workspace-nav-icon workspace-memory-all-nav-icon",
}: {
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 21H16.9999C19.3569 21 20.5354 21 21.2677 20.2678C21.9999 19.5355 21.9999 18.357 21.9999 16C21.9999 13.643 21.9999 12.4645 21.2677 11.7322C20.5354 11 19.3569 11 16.9999 11H7C4.64302 11 3.46453 11 2.7323 11.7322C2.00007 12.4644 2.00005 13.6429 2 15.9999C1.99995 18.357 1.99993 19.5355 2.73217 20.2677C3.4644 21 4.64294 21 7 21Z" />
      <path d="M4 11C4.00005 9.59977 4.00008 8.89966 4.27263 8.36485C4.5123 7.89455 4.89469 7.51218 5.365 7.27253C5.89981 7 6.59993 7 8.00015 7H16C17.4001 7 18.1002 7 18.635 7.27248C19.1054 7.51217 19.4878 7.89462 19.7275 8.36502C20 8.8998 20 9.59987 20 11" />
      <path d="M6 7C6.00004 5.5998 6.00006 4.89969 6.27259 4.3649C6.51227 3.89457 6.89467 3.51218 7.36501 3.27252C7.89981 3 8.59991 3 10.0001 3H14C15.4001 3 16.1002 3 16.635 3.27248C17.1054 3.51217 17.4878 3.89462 17.7275 4.36502C18 4.8998 18 5.59987 18 7" />
    </svg>
  );
}
