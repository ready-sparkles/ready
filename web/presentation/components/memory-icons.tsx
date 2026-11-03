// SVG geometry shared with the Highlight prototype. Keep these independent of its mock data.
function MemoryMinimizeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M20 3.75 13.5 10.25m0-5.5v5.5H19M4 20.25l6.5-6.5m-5.5 0h5.5v5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function MemoryExternalLinkIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 -0.5 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M17.25 15.25V6.75H8.75"
        stroke="currentColor"
        strokeWidth="1.72"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17 7L6.75 17.25"
        stroke="currentColor"
        strokeWidth="1.72"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function MemorySearchClearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="memory-search-clear-icon">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="m8.75 8.75 6.5 6.5M15.25 8.75l-6.5 6.5" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function MemorySettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="memory-layout-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M3.99963 5.00055L9.99963 5.00031" />
      <path d="M12.9996 5.00031L19.9996 5.00031" />
      <path d="M15.9996 9.00031L15.9996 15.0003" />
      <path d="M9.99963 2.00031L9.99963 8.00031" />
      <path d="M11.9996 16.0003L11.9996 22.0003" />
      <path d="M15.9996 12.0001L19.9996 12.0003" />
      <path d="M3.99963 12.0005L12.9996 12.0003" />
      <path d="M11.9996 19.0003L19.9996 19.0003" />
      <path d="M3.99963 19.0005L8.99963 19.0003" />
    </svg>
  );
}
function CalendarStackIcon({
  className = "workspace-nav-icon workspace-visual-compact-nav-icon",
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
      <path d="M16 2V6M8 2V6" />
      <path d="M13 4H11C7.22876 4 5.34315 4 4.17157 5.17157C3 6.34315 3 8.22876 3 12V14C3 17.7712 3 19.6569 4.17157 20.8284C5.34315 22 7.22876 22 11 22H13C16.7712 22 18.6569 22 19.8284 20.8284C21 19.6569 21 17.7712 21 14V12C21 8.22876 21 6.34315 19.8284 5.17157C18.6569 4 16.7712 4 13 4Z" />
      <path d="M3 10H21" />
      <path d="M15.5 15.5V17.5M17 16.5C17 17.3284 16.3284 18 15.5 18C14.6716 18 14 17.3284 14 16.5C14 15.6716 14.6716 15 15.5 15C16.3284 15 17 15.6716 17 16.5Z" />
    </svg>
  );
}
function VideoPlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-nav-icon" fill="none">
      <path
        d="M4.5 5.25H13.5C14.7426 5.25 15.75 6.25736 15.75 7.5V16.5C15.75 17.7426 14.7426 18.75 13.5 18.75H4.5C3.25736 18.75 2.25 17.7426 2.25 16.5V7.5C2.25 6.25736 3.25736 5.25 4.5 5.25Z"
        fill="currentColor"
      />
      <path
        d="M16.5 10.1893L20.47 6.2193C20.9425 5.74684 21.75 6.0815 21.75 6.75V17.25C21.75 17.9185 20.9425 18.2532 20.47 17.7807L16.5 13.8107V10.1893Z"
        fill="currentColor"
      />
    </svg>
  );
}
function EntityFilterTypeIcon({ type }: { type: "person" | "company" | "category" }) {
  if (type === "person") {
    return (
      <svg
        aria-hidden="true"
        className="memory-pill-type-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="7" r="4" />
        <path d="M12 14C7 14 4 16.5 4 19C4 20.1046 4.89543 21 6 21H18C19.1046 21 20 20.1046 20 19C20 16.5 17 14 12 14Z" />
      </svg>
    );
  }

  if (type === "company") {
    return (
      <svg aria-hidden="true" className="memory-pill-type-icon" viewBox="0 0 24 24" fill="none">
        <path
          d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="memory-pill-type-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle
        cx="1.5"
        cy="1.5"
        r="1.5"
        transform="matrix(1 0 0 -1 16 8.00024)"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M2.77423 11.1439C1.77108 12.2643 1.7495 13.9546 2.67016 15.1437C4.49711 17.5033 6.49674 19.5029 8.85633 21.3298C10.0454 22.2505 11.7357 22.2289 12.8561 21.2258C15.8979 18.5022 18.6835 15.6559 21.3719 12.5279C21.6377 12.2187 21.8039 11.8397 21.8412 11.4336C22.0062 9.63798 22.3452 4.46467 20.9403 3.05974C19.5353 1.65481 14.362 1.99377 12.5664 2.15876C12.1603 2.19608 11.7813 2.36233 11.472 2.62811C8.34412 5.31646 5.49781 8.10211 2.77423 11.1439Z" />
      <path d="M7.00002 14.0002L10 17.0002" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function FilterChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12.9121 18.6592" className="workspace-upcoming-calendar-nav-icon">
      <path
        d="M12.9121 9.32422C12.9121 9.05566 12.8047 8.80859 12.6006 8.61523L4.09277 0.279297C3.89941 0.0966797 3.66309 0 3.38379 0C2.83594 0 2.40625 0.418945 2.40625 0.977539C2.40625 1.24609 2.51367 1.49316 2.68555 1.67578L10.5059 9.32422L2.68555 16.9727C2.51367 17.1553 2.40625 17.3916 2.40625 17.6709C2.40625 18.2295 2.83594 18.6484 3.38379 18.6484C3.66309 18.6484 3.89941 18.5518 4.09277 18.3584L12.6006 10.0332C12.8047 9.8291 12.9121 9.59277 12.9121 9.32422Z"
        fill="currentColor"
      />
    </svg>
  );
}
function ToolbarFilterIcon() {
  return (
    <svg
      aria-hidden="true"
      className="memory-filter-icon"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6H21" />
      <path d="M6 12H18" />
      <path d="M9 18H15" />
    </svg>
  );
}
function MemoryDisclosureIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M1.5 3h7L5 8Z" fill="currentColor" />
    </svg>
  );
}
function MemorySearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 17L21 21" />
      <path d="M19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19C15.4183 19 19 15.4183 19 11Z" />
    </svg>
  );
}
function MemoryChevronIcon({ isUp }: { isUp: boolean }) {
  return (
    <span className={`relationship-chevron-icon${isUp ? " is-up" : ""}`}>
      <FilterChevronIcon />
    </span>
  );
}
function MemoryDefaultStrokeIcon({ name }: { name: "back" | "close" | "check" }) {
  const path =
    name === "back"
      ? "M15.75 19.5 8.25 12l7.5-7.5"
      : name === "check"
        ? "m4.5 12.75 6 6 9-13.5"
        : "m6 6 12 12M18 6 6 18";

  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}
type MemoryIconName =
  | "filter"
  | "search"
  | "close"
  | "clear"
  | "back"
  | "minimize"
  | "meeting"
  | "settings"
  | "up"
  | "external"
  | "person"
  | "category"
  | "date"
  | "chevron"
  | "disclosure"
  | "check";

const memoryIconByName: Record<MemoryIconName, React.JSX.Element> = {
  minimize: <MemoryMinimizeIcon />,
  filter: <ToolbarFilterIcon />,
  settings: <MemorySettingsIcon />,
  external: <MemoryExternalLinkIcon />,
  clear: <MemorySearchClearIcon />,
  person: <EntityFilterTypeIcon type="person" />,
  category: <EntityFilterTypeIcon type="category" />,
  date: <CalendarStackIcon className="relationship-date-icon" />,
  meeting: <VideoPlusIcon />,
  chevron: <MemoryChevronIcon isUp={false} />,
  up: <MemoryChevronIcon isUp={true} />,
  disclosure: <MemoryDisclosureIcon />,
  search: <MemorySearchIcon />,
  back: <MemoryDefaultStrokeIcon name="back" />,
  close: <MemoryDefaultStrokeIcon name="close" />,
  check: <MemoryDefaultStrokeIcon name="check" />,
};

export function MemoryIcon({ name }: { name: MemoryIconName }) {
  return memoryIconByName[name];
}
