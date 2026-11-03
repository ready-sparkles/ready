"use client";
import { memoryCategories, type MemoryPerson } from "@readymeet/shared";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { MemoryFilterPills } from "./memory-filter-pills";
import { MemoryIcon } from "./memory-icons";

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_DAY = MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;
const PERSON_INITIALS_MAX_PARTS = 2;
const RELATIVE_CONTACT_DAYS_IN_MONTH = 31;
const MEMORY_AGE_TWO_YEARS_DAYS = 730;
const DAYS_PER_YEAR = 365;
const DATE_INPUT_PAD_WIDTH = 2;
const FILTER_SUBMENU_DEFAULT_TOP_PX = 7;
const FILTER_POPOVER_MAX_WIDTH_PX = 524;
const FILTER_POPOVER_VIEWPORT_GUTTER_PX = 24;
const FILTER_POPOVER_EDGE_INSET_PX = 12;
const FILTER_TYPE_ROW_OFFSET_FALLBACK_PX = 6;
const FILTER_TYPE_PARENT_CLIENT_TOP_FALLBACK_PX = 1;
const SCROLL_BACK_TO_TOP_THRESHOLD_PX = 48;
const SEARCH_INPUT_MAX_LENGTH = 200;
const DATE_FILTER_DAYS_ONE = 1;
const DATE_FILTER_DAYS_THREE = 3;
const DATE_FILTER_DAYS_SEVEN = 7;
const DATE_FILTER_MONTHS_ONE = 1;
const DATE_FILTER_MONTHS_THREE = 3;
const DATE_FILTER_MONTHS_SIX = 6;
const DATE_FILTER_MONTHS_TWELVE = 12;

const MEMORY_BROWSER_COPY = {
  contactToday: "Today",
  contactYesterday: "Yesterday",
  memoryToday: "today",
  memoryDaySingular: "day",
  memoryDayPlural: "days",
  memoryYearsAgoSuffix: "years ago",
  memoryDaysAgoSuffix: "ago",
  filterEmpty: "No matches",
  customDateSearchPhrase: "custom date or timeframe",
  customDateMenuLabel: "Custom date or timeframe",
  customDateMenuItem: "Custom date or timeframe…",
  customDateBack: "← Date options",
  customDateFrom: "From",
  customDateThrough: "Through",
  customDateApply: "Apply date filter",
  filterSearchPlaceholder: "Filter...",
  loadMorePeople: "Load more people",
  backToTop: "Back to top",
  addFilter: "Add filter",
  addFilterTitle: "Add filter",
  filterMenuLabel: "Add memory filter",
  searchPeople: "Search people",
  searchMemories: "Search memories",
  searchPlaceholder: "Search",
  clearSearch: "Clear search",
  dateOlderThanOneDay: "Older than 1 day",
  dateOlderThanThreeDays: "Older than 3 days",
  dateOlderThanOneWeek: "Older than 1 week",
  dateOlderThanOneMonth: "Older than 1 month",
  dateOlderThanThreeMonths: "Older than 3 months",
  dateOlderThanSixMonths: "Older than 6 months",
  dateOlderThanOneYear: "Older than 1 year",
  filterTypeCategory: "Category",
  filterTypePerson: "Person",
  filterTypeDate: "Date",
  filterTypeLastContact: "Last contact",
  filtersSuffix: "filters",
} as const;

const MEMORY_BROWSER_ERRORS = {
  unknownDateFilter: "Unknown date filter",
  dateFilterMissingDuration: "Date filter is missing a duration",
} as const;

export { MemoryIcon } from "./memory-icons";
export function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="relationship-category" data-category={category}>
      <i aria-hidden="true" />
      {category}
    </span>
  );
}
export function PersonInitials({ name, imageUrl }: { name: string; imageUrl?: string | null }) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  if (imageUrl !== null && imageUrl !== undefined && imageUrl !== "" && imageUrl !== failedImageUrl) {
    return (
      <span className="relationship-person-initials has-photo" aria-hidden="true">
        <img src={imageUrl} alt="" onError={() => setFailedImageUrl(imageUrl)} />
      </span>
    );
  }

  return (
    <span className="relationship-person-initials" aria-hidden="true">
      <span className="relationship-person-initials-label">
        {name
          .split(" ")
          .slice(0, PERSON_INITIALS_MAX_PARTS)
          .map((n) => n[0])
          .join("")}
      </span>
    </span>
  );
}
function relativeContact(date: string) {
  const d = new Date(date),
    today = new Date();
  const days = Math.round(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) /
      MS_PER_DAY,
  );
  if (days <= 0) {
    return MEMORY_BROWSER_COPY.contactToday;
  }
  if (days === 1) {
    return MEMORY_BROWSER_COPY.contactYesterday;
  }
  if (days < RELATIVE_CONTACT_DAYS_IN_MONTH) {
    return `${days} days ago`;
  }

  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}
function elapsedCalendarDaysImpl({ date, today }: { date: string; today: Date }) {
  const d = new Date(date);

  return Math.max(
    0,
    Math.round(
      (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
        Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) /
        MS_PER_DAY,
    ),
  );
}
export function contactAgeInDays(...args: [date: string, today?: Date]) {
  const [date, today = new Date()] = args;
  const days = elapsedCalendarDaysImpl({ date, today });
  if (days === 0) {
    return MEMORY_BROWSER_COPY.contactToday;
  }
  if (days === 1) {
    return MEMORY_BROWSER_COPY.contactYesterday;
  }

  return `${days} days ago`;
}
export function memoryAge(...args: [date: string, today?: Date]) {
  const [date, today = new Date()] = args;
  const days = elapsedCalendarDaysImpl({ date, today });
  if (days === 0) {
    return MEMORY_BROWSER_COPY.memoryToday;
  }
  if (days >= MEMORY_AGE_TWO_YEARS_DAYS) {
    return `${Math.floor(days / DAYS_PER_YEAR)} ${MEMORY_BROWSER_COPY.memoryYearsAgoSuffix}`;
  }

  return `${days} ${days === 1 ? MEMORY_BROWSER_COPY.memoryDaySingular : MEMORY_BROWSER_COPY.memoryDayPlural} ${MEMORY_BROWSER_COPY.memoryDaysAgoSuffix}`;
}
export function memoryDay(date: string) {
  const relative = relativeContact(date);

  return relative === MEMORY_BROWSER_COPY.contactToday || relative === MEMORY_BROWSER_COPY.contactYesterday
    ? relative
    : new Date(date).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}
export function moveRowFocus(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }
  const rows = [
    ...(event.currentTarget
      .closest("[data-memory-browser-list]")
      ?.querySelectorAll<HTMLElement>("[data-browser-row]") ?? []),
  ].filter((row) => !row.closest('[hidden], [inert], [aria-hidden="true"]'));
  const index = rows.indexOf(event.currentTarget);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
  event.preventDefault();
  rows[next]?.focus();
}
export function MemoryGroup({
  label,
  count,
  children,
  headingInert: isGroupHeadingInert = false,
}: {
  label: string;
  count: number;
  children: ReactNode;
  /** @external memory browser group heading contract */
  headingInert?: boolean;
}) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <section className="relationship-memory-group">
      <div
        className="relationship-memory-group-heading"
        inert={isGroupHeadingInert}
        aria-hidden={isGroupHeadingInert ? true : undefined}
      >
        <button
          type="button"
          aria-expanded={!isCollapsed}
          onClick={() => setIsCollapsed((isCurrentlyCollapsed) => !isCurrentlyCollapsed)}
        >
          <span className="relationship-group-chevron" aria-hidden="true">
            <MemoryIcon name="disclosure" />
          </span>
          {label}
          <span className="relationship-group-count">{count}</span>
        </button>
      </div>
      <h2 hidden={isCollapsed}>{children}</h2>
    </section>
  );
}
function dateInputValueImpl({ value, isPreviousDay = false }: { value: string; isPreviousDay?: boolean }) {
  if (value === "") {
    return "";
  }
  const date = new Date(value);
  if (isPreviousDay) {
    date.setDate(date.getDate() - 1);
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(DATE_INPUT_PAD_WIDTH, "0")}-${String(date.getDate()).padStart(DATE_INPUT_PAD_WIDTH, "0")}`;
}
function dateInputValue(...args: [value: string, isPreviousDay?: boolean]) {
  const [value, isPreviousDay = false] = args;

  return dateInputValueImpl({ value, isPreviousDay });
}
function afterDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + 1);

  return date.toISOString();
}

type MemoryBrowserDateOption =
  | { id: string; label: string; days: number }
  | { id: string; label: string; months: number };

const MEMORY_BROWSER_DATE_OPTIONS: MemoryBrowserDateOption[] = [
  { id: "day-1", label: MEMORY_BROWSER_COPY.dateOlderThanOneDay, days: DATE_FILTER_DAYS_ONE },
  { id: "day-3", label: MEMORY_BROWSER_COPY.dateOlderThanThreeDays, days: DATE_FILTER_DAYS_THREE },
  { id: "day-7", label: MEMORY_BROWSER_COPY.dateOlderThanOneWeek, days: DATE_FILTER_DAYS_SEVEN },
  { id: "month-1", label: MEMORY_BROWSER_COPY.dateOlderThanOneMonth, months: DATE_FILTER_MONTHS_ONE },
  { id: "month-3", label: MEMORY_BROWSER_COPY.dateOlderThanThreeMonths, months: DATE_FILTER_MONTHS_THREE },
  { id: "month-6", label: MEMORY_BROWSER_COPY.dateOlderThanSixMonths, months: DATE_FILTER_MONTHS_SIX },
  { id: "month-12", label: MEMORY_BROWSER_COPY.dateOlderThanOneYear, months: DATE_FILTER_MONTHS_TWELVE },
];

type MemoryBrowserFilterType = { id: string; label: string };

function buildMemoryBrowserFilterTypes(view: "all" | "people"): MemoryBrowserFilterType[] {
  const categoryType: MemoryBrowserFilterType = {
    id: "category",
    label: MEMORY_BROWSER_COPY.filterTypeCategory,
  };
  const dateType: MemoryBrowserFilterType = {
    id: "date",
    label: view === "all" ? MEMORY_BROWSER_COPY.filterTypeDate : MEMORY_BROWSER_COPY.filterTypeLastContact,
  };
  if (view === "all") {
    return [categoryType, { id: "person", label: MEMORY_BROWSER_COPY.filterTypePerson }, dateType];
  }

  return [categoryType, dateType];
}

function memoryBrowserFilterTypeIcon(typeId: string): "category" | "person" | "date" | "filter" {
  if (typeId === "category" || typeId === "person" || typeId === "date") {
    return typeId;
  }

  return "filter";
}

function nextMenuIndex({ key, index, length }: { key: string; index: number; length: number }) {
  if (key === "ArrowDown") {
    return (index + 1) % length;
  }
  if (key === "ArrowUp") {
    return index < 0 ? length - 1 : (index - 1 + length) % length;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return length - 1;
  }

  return null;
}

function moveMenuFocus(...args: [event: KeyboardEvent<HTMLElement>, items: (HTMLElement | null)[]]) {
  const [event, items] = args;
  const available = items.filter((item): item is HTMLElement => item !== null);
  if (available.length === 0) {
    return;
  }
  const activeElement = document.activeElement;
  const index = activeElement instanceof HTMLElement ? available.indexOf(activeElement) : -1;
  const next = nextMenuIndex({ key: event.key, index, length: available.length });
  if (next === null) {
    return;
  }
  event.preventDefault();
  available[next]?.focus({ preventScroll: true });
}

function computeDateFilterCutoff(option: MemoryBrowserDateOption) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  if ("days" in option) {
    cutoff.setDate(cutoff.getDate() - option.days);

    return cutoff;
  }
  const day = cutoff.getDate();
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - option.months);
  const lastDay = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
  cutoff.setDate(Math.min(day, lastDay));

  return cutoff;
}

function memoryBrowserUnknownDateFilterError(id: string) {
  return new Error([MEMORY_BROWSER_ERRORS.unknownDateFilter, id, "."].join(" "));
}

function memoryBrowserFilterOptionsAriaLabel({
  isCustomDate,
  kindLabel,
}: {
  isCustomDate: boolean;
  kindLabel: string;
}) {
  if (isCustomDate) {
    return MEMORY_BROWSER_COPY.customDateMenuLabel;
  }

  return `${kindLabel} ${MEMORY_BROWSER_COPY.filtersSuffix}`;
}

function isCustomDateFilterVisible({ filterKind, filterQuery }: { filterKind: string; filterQuery: string }) {
  return (
    filterKind === "date" && MEMORY_BROWSER_COPY.customDateSearchPhrase.includes(filterQuery.trim().toLocaleLowerCase())
  );
}

function isCustomDateRangeInvalid({ from, to }: { from: string; to: string }) {
  const hasFrom = from !== "";
  const hasTo = to !== "";

  return (!hasFrom && !hasTo) || (hasFrom && hasTo && to < from);
}

function memoryBrowserFilterMenuPosition(triggerRect: DOMRect) {
  const width = Math.min(FILTER_POPOVER_MAX_WIDTH_PX, window.innerWidth - FILTER_POPOVER_VIEWPORT_GUTTER_PX);

  return {
    width,
    left: Math.min(0, window.innerWidth - FILTER_POPOVER_EDGE_INSET_PX - triggerRect.left - width),
  };
}

function useMemoryBrowserToolbarScrollTop(rootRef: RefObject<HTMLDivElement | null>) {
  const [isBackToTopVisible, setIsBackToTopVisible] = useState(false);
  useEffect(() => {
    const scroller = rootRef.current?.closest(".relationship-memory-content");
    if (!scroller) {
      return;
    }
    const update = () => setIsBackToTopVisible(scroller.scrollTop > SCROLL_BACK_TO_TOP_THRESHOLD_PX);
    update();
    scroller.addEventListener("scroll", update, { passive: true });

    return () => scroller.removeEventListener("scroll", update);
  }, [rootRef]);

  return isBackToTopVisible;
}

function useMemoryBrowserFilterMenuDismissal({
  isOpen,
  rootRef,
  close,
}: {
  isOpen: boolean;
  rootRef: RefObject<HTMLDivElement | null>;
  close: (shouldRestoreFocus?: boolean) => void;
}) {
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const outside = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || !(rootRef.current?.contains(target) ?? false)) {
        close(false);
      }
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);

    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [close, isOpen, rootRef]);
}

function useMemoryBrowserFilterMenuPosition({
  isOpen,
  triggerRef,
  setMenuPosition,
}: {
  isOpen: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  setMenuPosition: (position: { left: number; width: number }) => void;
}) {
  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setMenuPosition(memoryBrowserFilterMenuPosition(rect));
    };
    position();
    window.addEventListener("resize", position);

    return () => window.removeEventListener("resize", position);
  }, [isOpen, setMenuPosition, triggerRef]);
}

type MemoryBrowserFilterOption = { id: string; label: string };

function MemoryBrowserFilterCustomDateForm({
  from,
  to,
  setFrom,
  setTo,
  filterInputRef,
  onChange,
  onClose,
  onLeaveCustomDate,
}: {
  from: string;
  to: string;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
  onLeaveCustomDate: () => void;
}) {
  return (
    <form
      className="relationship-custom-date-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (isCustomDateRangeInvalid({ from, to })) {
          return;
        }
        onChange({
          from: from !== "" ? new Date(`${from}T00:00:00`).toISOString() : "",
          to: to !== "" ? afterDate(to) : "",
          dateOperator: "is",
        });
        onClose();
      }}
    >
      <button type="button" className="relationship-custom-date-back" onClick={onLeaveCustomDate}>
        {MEMORY_BROWSER_COPY.customDateBack}
      </button>
      <label>
        {MEMORY_BROWSER_COPY.customDateFrom}
        <input
          ref={filterInputRef}
          autoFocus
          type="date"
          aria-label="From date"
          value={from}
          max={to !== "" ? to : undefined}
          onInput={(e) => setFrom(e.currentTarget.value)}
        />
      </label>
      <label>
        {MEMORY_BROWSER_COPY.customDateThrough}
        <input
          type="date"
          aria-label="Through date"
          value={to}
          min={from !== "" ? from : undefined}
          onInput={(e) => setTo(e.currentTarget.value)}
        />
      </label>
      <button
        type="submit"
        className="relationship-custom-date-apply"
        disabled={isCustomDateRangeInvalid({ from, to })}
      >
        {MEMORY_BROWSER_COPY.customDateApply}
      </button>
    </form>
  );
}

function MemoryBrowserFilterValueOptions({
  filterKind,
  filters,
  visibleOptions,
  hasMorePeople: canLoadMorePeople,
  loadingPeople: isLoadingMorePeople,
  onLoadMorePeople,
  onSelectOption,
  isCustomDateOptionVisible,
  onRequestCustomDate,
}: {
  filterKind: string;
  filters: BrowserFilters;
  visibleOptions: MemoryBrowserFilterOption[];
  /** @external memory browser toolbar contract */
  hasMorePeople?: boolean;
  /** @external memory browser toolbar contract */
  loadingPeople?: boolean;
  onLoadMorePeople?: () => void;
  onSelectOption: (id: string) => void;
  isCustomDateOptionVisible: boolean;
  onRequestCustomDate: () => void;
}) {
  return (
    <div className="relationship-filter-values">
      {filterKind === "person" && canLoadMorePeople === true ? (
        <button type="button" role="menuitem" disabled={isLoadingMorePeople} onClick={onLoadMorePeople}>
          {MEMORY_BROWSER_COPY.loadMorePeople}
        </button>
      ) : null}
      {visibleOptions.map((option) => {
        const isSelected =
          filterKind === "category"
            ? filters.category === option.id
            : filterKind === "person" && filters.person === option.id;

        return (
          <button
            key={option.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={isSelected}
            onClick={() => onSelectOption(option.id)}
          >
            {filterKind === "category" ? (
              <CategoryBadge category={option.label} />
            ) : filterKind === "person" ? (
              <>
                <PersonInitials name={option.label} />
                <span>{option.label}</span>
              </>
            ) : (
              <span>{option.label}</span>
            )}
            {isSelected ? (
              <span className="relationship-filter-check">
                <MemoryIcon name="check" />
              </span>
            ) : null}
          </button>
        );
      })}
      {isCustomDateOptionVisible ? (
        <button type="button" role="menuitem" onClick={onRequestCustomDate}>
          {MEMORY_BROWSER_COPY.customDateMenuItem}
        </button>
      ) : null}
      {visibleOptions.length === 0 && !isCustomDateOptionVisible ? (
        <span className="relationship-filter-empty">{MEMORY_BROWSER_COPY.filterEmpty}</span>
      ) : null}
    </div>
  );
}

function MemoryBrowserFilterSearchPane({
  filterKind,
  filterQuery,
  setFilterQuery,
  filterInputRef,
  filters,
  visibleOptions,
  hasMorePeople: canLoadMorePeople,
  loadingPeople: isLoadingMorePeople,
  onLoadMorePeople,
  onSelectOption,
  isCustomDateOptionVisible,
  onRequestCustomDate,
}: {
  filterKind: string;
  filterQuery: string;
  setFilterQuery: (value: string) => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
  filters: BrowserFilters;
  visibleOptions: MemoryBrowserFilterOption[];
  /** @external memory browser toolbar contract */
  hasMorePeople?: boolean;
  /** @external memory browser toolbar contract */
  loadingPeople?: boolean;
  onLoadMorePeople?: () => void;
  onSelectOption: (id: string) => void;
  isCustomDateOptionVisible: boolean;
  onRequestCustomDate: () => void;
}) {
  return (
    <>
      <label className="relationship-filter-search">
        <input
          ref={filterInputRef}
          type="search"
          aria-label={`Search ${filterKind} filters`}
          placeholder={MEMORY_BROWSER_COPY.filterSearchPlaceholder}
          autoComplete="off"
          spellCheck={false}
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
      </label>
      <MemoryBrowserFilterValueOptions
        filterKind={filterKind}
        filters={filters}
        visibleOptions={visibleOptions}
        hasMorePeople={canLoadMorePeople}
        loadingPeople={isLoadingMorePeople}
        onLoadMorePeople={onLoadMorePeople}
        onSelectOption={onSelectOption}
        isCustomDateOptionVisible={isCustomDateOptionVisible}
        onRequestCustomDate={onRequestCustomDate}
      />
    </>
  );
}

function memoryBrowserFilterOptionsMenuKeyDown({
  event,
  filterKind,
  types,
  typeRowElements,
  isCustomDate,
}: {
  event: KeyboardEvent<HTMLDivElement>;
  filterKind: string;
  types: MemoryBrowserFilterType[];
  typeRowElements: RefObject<Record<number, HTMLButtonElement>>;
  isCustomDate: boolean;
}) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    typeRowElements.current[types.findIndex((type) => type.id === filterKind)]?.focus({
      preventScroll: true,
    });
  } else if (!isCustomDate) {
    moveMenuFocus(event, [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]'),
    ]);
  }
}

function MemoryBrowserFilterOptionsColumnBody({
  isCustomDate,
  from,
  to,
  setFrom,
  setTo,
  filterInputRef,
  onChange,
  onClose,
  setIsCustomDate,
  filterKind,
  filterQuery,
  setFilterQuery,
  filters,
  visibleOptions,
  canLoadMorePeople,
  isLoadingMorePeople,
  onLoadMorePeople,
  onSelectOption,
  isCustomDateOptionVisible,
}: {
  isCustomDate: boolean;
  from: string;
  to: string;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
  setIsCustomDate: (value: boolean) => void;
  filterKind: string;
  filterQuery: string;
  setFilterQuery: (value: string) => void;
  filters: BrowserFilters;
  visibleOptions: MemoryBrowserFilterOption[];
  canLoadMorePeople?: boolean;
  isLoadingMorePeople?: boolean;
  onLoadMorePeople?: () => void;
  onSelectOption: (id: string) => void;
  isCustomDateOptionVisible: boolean;
}) {
  if (isCustomDate) {
    return (
      <MemoryBrowserFilterCustomDateForm
        from={from}
        to={to}
        setFrom={setFrom}
        setTo={setTo}
        filterInputRef={filterInputRef}
        onChange={onChange}
        onClose={onClose}
        onLeaveCustomDate={() => {
          setIsCustomDate(false);
          requestAnimationFrame(() => filterInputRef.current?.focus());
        }}
      />
    );
  }

  return (
    <MemoryBrowserFilterSearchPane
      filterKind={filterKind}
      filterQuery={filterQuery}
      setFilterQuery={setFilterQuery}
      filterInputRef={filterInputRef}
      filters={filters}
      visibleOptions={visibleOptions}
      hasMorePeople={canLoadMorePeople}
      loadingPeople={isLoadingMorePeople}
      onLoadMorePeople={onLoadMorePeople}
      onSelectOption={onSelectOption}
      isCustomDateOptionVisible={isCustomDateOptionVisible}
      onRequestCustomDate={() => setIsCustomDate(true)}
    />
  );
}

function MemoryBrowserFilterOptionsColumn({
  filterKind,
  submenuTop,
  isCustomDate,
  activeFilterKindLabel,
  types,
  typeRowElements,
  from,
  to,
  setFrom,
  setTo,
  filterInputRef,
  onChange,
  onClose,
  setIsCustomDate,
  filterQuery,
  setFilterQuery,
  filters,
  visibleOptions,
  hasMorePeople: canLoadMorePeople,
  loadingPeople: isLoadingMorePeople,
  onLoadMorePeople,
  onSelectOption,
  isCustomDateOptionVisible,
}: {
  filterKind: string;
  submenuTop: number;
  isCustomDate: boolean;
  activeFilterKindLabel: string;
  types: MemoryBrowserFilterType[];
  typeRowElements: RefObject<Record<number, HTMLButtonElement>>;
  from: string;
  to: string;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
  setIsCustomDate: (value: boolean) => void;
  filterQuery: string;
  setFilterQuery: (value: string) => void;
  filters: BrowserFilters;
  visibleOptions: MemoryBrowserFilterOption[];
  /** @external memory browser toolbar contract */
  hasMorePeople?: boolean;
  /** @external memory browser toolbar contract */
  loadingPeople?: boolean;
  onLoadMorePeople?: () => void;
  onSelectOption: (id: string) => void;
  isCustomDateOptionVisible: boolean;
}) {
  return (
    <div
      className={`relationship-filter-options${filterKind === "date" ? " is-date-submenu" : ""}`}
      style={{ top: submenuTop }}
      role={isCustomDate ? "dialog" : "menu"}
      aria-label={memoryBrowserFilterOptionsAriaLabel({
        isCustomDate,
        kindLabel: activeFilterKindLabel,
      })}
      onKeyDown={(e) =>
        memoryBrowserFilterOptionsMenuKeyDown({
          event: e,
          filterKind,
          types,
          typeRowElements,
          isCustomDate,
        })
      }
    >
      <MemoryBrowserFilterOptionsColumnBody
        isCustomDate={isCustomDate}
        from={from}
        to={to}
        setFrom={setFrom}
        setTo={setTo}
        filterInputRef={filterInputRef}
        onChange={onChange}
        onClose={onClose}
        setIsCustomDate={setIsCustomDate}
        filterKind={filterKind}
        filterQuery={filterQuery}
        setFilterQuery={setFilterQuery}
        filters={filters}
        visibleOptions={visibleOptions}
        canLoadMorePeople={canLoadMorePeople}
        isLoadingMorePeople={isLoadingMorePeople}
        onLoadMorePeople={onLoadMorePeople}
        onSelectOption={onSelectOption}
        isCustomDateOptionVisible={isCustomDateOptionVisible}
      />
    </div>
  );
}

function MemoryBrowserFilterTypesColumn({
  types,
  filterKind,
  typeRowElements,
  registerTypeRow,
  filterInputRef,
  showFilterType,
  setIsKeyboardMenu,
}: {
  types: MemoryBrowserFilterType[];
  filterKind: string;
  typeRowElements: RefObject<Record<number, HTMLButtonElement>>;
  registerTypeRow: (index: number) => (node: HTMLButtonElement | null) => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
  showFilterType: (...args: [id: string, isAutoFocusRequested?: boolean]) => void;
  setIsKeyboardMenu: (value: boolean) => void;
}) {
  return (
    <div
      className="relationship-filter-types"
      role="menu"
      aria-label={MEMORY_BROWSER_COPY.filterMenuLabel}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" && filterKind !== "") {
          e.preventDefault();
          filterInputRef.current?.focus({ preventScroll: true });
        } else {
          moveMenuFocus(
            e,
            types.map((_, index) => typeRowElements.current[index] ?? null),
          );
        }
      }}
    >
      {types.map((type, index) => (
        <button
          key={type.id}
          ref={registerTypeRow(index)}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={filterKind === type.id}
          className={filterKind === type.id ? "is-active" : undefined}
          onPointerEnter={(e) => {
            if (e.pointerType !== "touch") {
              setIsKeyboardMenu(false);
              showFilterType(type.id);
            }
          }}
          onFocus={() => showFilterType(type.id)}
          onClick={() => showFilterType(type.id, true)}
        >
          <span className="relationship-filter-type-label">
            <MemoryIcon name={memoryBrowserFilterTypeIcon(type.id)} />
            {type.label}
          </span>
          <MemoryIcon name="chevron" />
        </button>
      ))}
    </div>
  );
}

function MemoryBrowserFilterPopover({
  isKeyboardMenu,
  menuPosition,
  types,
  filterKind,
  typeRowElements,
  registerTypeRow,
  filterInputRef,
  showFilterType,
  setIsKeyboardMenu,
  submenuTop,
  isCustomDate,
  activeFilterKindLabel,
  from,
  to,
  setFrom,
  setTo,
  onChange,
  onClose,
  setIsCustomDate,
  filterQuery,
  setFilterQuery,
  filters,
  visibleOptions,
  hasMorePeople: canLoadMorePeople,
  loadingPeople: isLoadingMorePeople,
  onLoadMorePeople,
  onSelectOption,
  isCustomDateOptionVisible,
}: {
  isKeyboardMenu: boolean;
  menuPosition: { left: number; width: number };
  types: MemoryBrowserFilterType[];
  filterKind: string;
  typeRowElements: RefObject<Record<number, HTMLButtonElement>>;
  registerTypeRow: (index: number) => (node: HTMLButtonElement | null) => void;
  filterInputRef: RefObject<HTMLInputElement | null>;
  showFilterType: (...args: [id: string, isAutoFocusRequested?: boolean]) => void;
  setIsKeyboardMenu: (value: boolean) => void;
  submenuTop: number;
  isCustomDate: boolean;
  activeFilterKindLabel: string;
  from: string;
  to: string;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
  setIsCustomDate: (value: boolean) => void;
  filterQuery: string;
  setFilterQuery: (value: string) => void;
  filters: BrowserFilters;
  visibleOptions: MemoryBrowserFilterOption[];
  /** @external memory browser toolbar contract */
  hasMorePeople?: boolean;
  /** @external memory browser toolbar contract */
  loadingPeople?: boolean;
  onLoadMorePeople?: () => void;
  onSelectOption: (id: string) => void;
  isCustomDateOptionVisible: boolean;
}) {
  return (
    <div className="relationship-filter-popover" style={menuPosition} data-keyboard={isKeyboardMenu ? true : undefined}>
      <MemoryBrowserFilterTypesColumn
        types={types}
        filterKind={filterKind}
        typeRowElements={typeRowElements}
        registerTypeRow={registerTypeRow}
        filterInputRef={filterInputRef}
        showFilterType={showFilterType}
        setIsKeyboardMenu={setIsKeyboardMenu}
      />
      {filterKind !== "" ? (
        <MemoryBrowserFilterOptionsColumn
          filterKind={filterKind}
          submenuTop={submenuTop}
          isCustomDate={isCustomDate}
          activeFilterKindLabel={activeFilterKindLabel}
          types={types}
          typeRowElements={typeRowElements}
          from={from}
          to={to}
          setFrom={setFrom}
          setTo={setTo}
          filterInputRef={filterInputRef}
          onChange={onChange}
          onClose={onClose}
          setIsCustomDate={setIsCustomDate}
          filterQuery={filterQuery}
          setFilterQuery={setFilterQuery}
          filters={filters}
          visibleOptions={visibleOptions}
          hasMorePeople={canLoadMorePeople}
          loadingPeople={isLoadingMorePeople}
          onLoadMorePeople={onLoadMorePeople}
          onSelectOption={onSelectOption}
          isCustomDateOptionVisible={isCustomDateOptionVisible}
        />
      ) : null}
    </div>
  );
}

function MemoryBrowserFilterMenuButton({
  triggerRef,
  isOpen,
  typeRowElements,
  close,
  setIsOpen,
  setFilterKind,
  setFilterQuery,
  setIsCustomDate,
  setIsKeyboardMenu,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  isOpen: boolean;
  typeRowElements: RefObject<Record<number, HTMLButtonElement>>;
  close: (shouldRestoreFocus?: boolean) => void;
  setIsOpen: (value: boolean) => void;
  setFilterKind: (value: string) => void;
  setFilterQuery: (value: string) => void;
  setIsCustomDate: (value: boolean) => void;
  setIsKeyboardMenu: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      ref={triggerRef}
      className="relationship-icon-button"
      aria-label={MEMORY_BROWSER_COPY.addFilter}
      title={MEMORY_BROWSER_COPY.addFilterTitle}
      aria-expanded={isOpen}
      aria-haspopup="menu"
      onClick={() => {
        if (isOpen) {
          close();
        } else {
          setIsOpen(true);
          setFilterKind("");
          setFilterQuery("");
          setIsCustomDate(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setIsOpen(true);
          setIsKeyboardMenu(true);
          requestAnimationFrame(() => typeRowElements.current[0]?.focus({ preventScroll: true }));
        }
      }}
    >
      <MemoryIcon name="filter" />
    </button>
  );
}

function MemoryBrowserFilterControl({
  rootRef,
  triggerRef,
  isOpen,
  setIsKeyboardMenu,
  close,
  setIsOpen,
  setFilterKind,
  setFilterQuery,
  setIsCustomDate,
  typeRowElements,
  popover,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  isOpen: boolean;
  setIsKeyboardMenu: (value: boolean) => void;
  close: (shouldRestoreFocus?: boolean) => void;
  setIsOpen: (value: boolean) => void;
  setFilterKind: (value: string) => void;
  setFilterQuery: (value: string) => void;
  setIsCustomDate: (value: boolean) => void;
  typeRowElements: RefObject<Record<number, HTMLButtonElement>>;
  popover: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      className="relationship-filter-control"
      onKeyDown={(e) => {
        e.stopPropagation();
        setIsKeyboardMenu(true);
      }}
      onPointerDown={() => setIsKeyboardMenu(false)}
    >
      <MemoryBrowserFilterMenuButton
        triggerRef={triggerRef}
        isOpen={isOpen}
        typeRowElements={typeRowElements}
        close={close}
        setIsOpen={setIsOpen}
        setFilterKind={setFilterKind}
        setFilterQuery={setFilterQuery}
        setIsCustomDate={setIsCustomDate}
        setIsKeyboardMenu={setIsKeyboardMenu}
      />
      {popover}
    </div>
  );
}

function MemoryBrowserToolbarSearchForm({
  view,
  query,
  setQuery,
  onSearch,
  inputRef,
}: {
  view: "all" | "people";
  query: string;
  setQuery: (q: string) => void;
  onSearch: (q: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <form
      className="relationship-search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(query.trim());
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
        <path
          d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <input
        ref={inputRef}
        aria-label={view === "people" ? MEMORY_BROWSER_COPY.searchPeople : MEMORY_BROWSER_COPY.searchMemories}
        placeholder={MEMORY_BROWSER_COPY.searchPlaceholder}
        type="search"
        value={query}
        maxLength={SEARCH_INPUT_MAX_LENGTH}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.nativeEvent.isComposing) {
            e.preventDefault();
          }
        }}
      />
      {query !== "" ? (
        <button
          type="button"
          aria-label={MEMORY_BROWSER_COPY.clearSearch}
          onClick={() => {
            setQuery("");
            onSearch("");
            inputRef.current?.focus();
          }}
        >
          <MemoryIcon name="clear" />
        </button>
      ) : null}
    </form>
  );
}

function MemoryBrowserToolbarFilterPills({
  view,
  people,
  filters,
  onChange,
  search,
  setQuery,
  onSearch,
  inputRef,
}: {
  view: "all" | "people";
  people: MemoryPerson[];
  filters: BrowserFilters;
  onChange: (patch: Partial<BrowserFilters>) => void;
  search: string;
  setQuery: (q: string) => void;
  onSearch: (q: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <MemoryFilterPills
      view={view}
      people={people}
      filters={filters}
      onChange={onChange}
      search={search}
      onEditSearch={() => {
        setQuery(search);
        inputRef.current?.focus();
      }}
      onRemoveSearch={() => {
        setQuery("");
        onSearch("");
      }}
      onClear={() => memoryBrowserToolbarClearFilters({ onChange, setQuery, onSearch })}
    />
  );
}

function memoryBrowserToolbarClearFilters({
  onChange,
  setQuery,
  onSearch,
}: {
  onChange: (patch: Partial<BrowserFilters>) => void;
  setQuery: (q: string) => void;
  onSearch: (q: string) => void;
}) {
  onChange({
    category: "",
    person: "",
    from: "",
    to: "",
    categoryOperator: "is",
    personOperator: "is",
    dateOperator: "is",
  });
  setQuery("");
  onSearch("");
}

export type BrowserFilters = {
  category: string;
  categoryOperator?: string;
  personOperator?: string;
  dateOperator?: string;
  person: string;
  from: string;
  to: string;
};

function memoryBrowserFilterMenuDerivedState({
  view,
  people,
  filterKind,
  filterQuery,
}: {
  view: "all" | "people";
  people: MemoryPerson[];
  filterKind: string;
  filterQuery: string;
}) {
  const types = buildMemoryBrowserFilterTypes(view);
  const options =
    filterKind === "category"
      ? memoryCategories.map((c) => ({ id: c, label: c }))
      : filterKind === "date"
        ? MEMORY_BROWSER_DATE_OPTIONS
        : people.map((p) => ({ id: p.id, label: p.name }));
  const visibleOptions = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(filterQuery.trim().toLocaleLowerCase()),
  );

  return {
    types,
    visibleOptions,
    isCustomDateOptionVisible: isCustomDateFilterVisible({ filterKind, filterQuery }),
    activeFilterKindLabel: types.find((type) => type.id === filterKind)?.label ?? "",
  };
}

function memoryBrowserShowFilterType({
  id,
  isAutoFocusRequested,
  typeRowElements,
  types,
  filterKind,
  filters,
  setSubmenuTop,
  setFilterQuery,
  setIsCustomDate,
  setFilterKind,
  setFrom,
  setTo,
  filterInput,
}: {
  id: string;
  isAutoFocusRequested: boolean;
  typeRowElements: RefObject<Record<number, HTMLButtonElement>>;
  types: MemoryBrowserFilterType[];
  filterKind: string;
  filters: BrowserFilters;
  setSubmenuTop: (value: number) => void;
  setFilterQuery: (value: string) => void;
  setIsCustomDate: (value: boolean) => void;
  setFilterKind: (value: string) => void;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  filterInput: RefObject<HTMLInputElement | null>;
}) {
  const row = typeRowElements.current[types.findIndex((type) => type.id === id)];
  setSubmenuTop(
    (row?.offsetTop ?? FILTER_TYPE_ROW_OFFSET_FALLBACK_PX) +
      (row?.parentElement?.clientTop ?? FILTER_TYPE_PARENT_CLIENT_TOP_FALLBACK_PX),
  );
  if (id !== filterKind) {
    setFilterQuery("");
    setIsCustomDate(false);
  }
  setFilterKind(id);
  setFrom(dateInputValue(filters.from));
  setTo(dateInputValue(filters.to, true));
  if (isAutoFocusRequested) {
    requestAnimationFrame(() => filterInput.current?.focus({ preventScroll: true }));
  }
}

function memoryBrowserApplyFilterSelection({
  filterKind,
  id,
  filters,
  onChange,
}: {
  filterKind: string;
  id: string;
  filters: BrowserFilters;
  onChange: (patch: Partial<BrowserFilters>) => void;
}) {
  if (filterKind === "date") {
    const option = MEMORY_BROWSER_DATE_OPTIONS.find((item) => item.id === id);
    if (option === undefined) {
      throw memoryBrowserUnknownDateFilterError(id);
    }
    const cutoff = computeDateFilterCutoff(option);
    onChange({ from: "", to: cutoff.toISOString(), dateOperator: "is" });

    return;
  }

  const activeValue = filterKind === "category" ? filters.category : filters.person;
  onChange({ [filterKind]: activeValue === id ? "" : id, [`${filterKind}Operator`]: "is" });
}

function useMemoryBrowserFilterTypeRowRegistry() {
  const typeRowElements = useRef<Record<number, HTMLButtonElement>>({});
  const registerTypeRow = useCallback(
    (index: number) => (node: HTMLButtonElement | null) => {
      if (node) {
        typeRowElements.current = { ...typeRowElements.current, [index]: node };

        return;
      }

      typeRowElements.current = Object.entries(typeRowElements.current)
        .filter(([key]) => Number(key) !== index)
        .reduce<Record<number, HTMLButtonElement>>((rows, [key, value]) => ({ ...rows, [Number(key)]: value }), {});
    },
    [],
  );

  return { typeRowElements, registerTypeRow };
}

function useMemoryBrowserFilterMenuPersonSearch({
  isOpen,
  filterKind,
  filterQuery,
  onPersonSearch,
}: {
  isOpen: boolean;
  filterKind: string;
  filterQuery: string;
  onPersonSearch?: (query: string | null) => void;
}) {
  useEffect(() => {
    onPersonSearch?.(isOpen && filterKind === "person" ? filterQuery : null);
  }, [isOpen, filterKind, filterQuery, onPersonSearch]);
}

function resetMemoryBrowserFilterMenuOnClose({
  setIsOpen,
  setFilterKind,
  setFilterQuery,
  setIsCustomDate,
}: {
  setIsOpen: (value: boolean) => void;
  setFilterKind: (value: string) => void;
  setFilterQuery: (value: string) => void;
  setIsCustomDate: (value: boolean) => void;
}) {
  setIsOpen(false);
  setFilterKind("");
  setFilterQuery("");
  setIsCustomDate(false);
}

function useMemoryBrowserFilterMenuState({
  filters,
  onChange,
  onPersonSearch,
  view,
  people,
}: {
  filters: BrowserFilters;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onPersonSearch?: (query: string | null) => void;
  view: "all" | "people";
  people: MemoryPerson[];
}) {
  const [isOpen, setIsOpen] = useState(false),
    [filterKind, setFilterKind] = useState(""),
    [filterQuery, setFilterQuery] = useState("");
  useMemoryBrowserFilterMenuPersonSearch({ isOpen, filterKind, filterQuery, onPersonSearch });
  const [submenuTop, setSubmenuTop] = useState(FILTER_SUBMENU_DEFAULT_TOP_PX);
  const [isCustomDate, setIsCustomDate] = useState(false);
  const [isKeyboardMenu, setIsKeyboardMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, width: FILTER_POPOVER_MAX_WIDTH_PX });
  const { typeRowElements, registerTypeRow } = useMemoryBrowserFilterTypeRowRegistry();
  const filterInput = useRef<HTMLInputElement>(null);
  const [from, setFrom] = useState(dateInputValue(filters.from)),
    [to, setTo] = useState(dateInputValue(filters.to, true));
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((shouldRestoreFocus = true) => {
    resetMemoryBrowserFilterMenuOnClose({ setIsOpen, setFilterKind, setFilterQuery, setIsCustomDate });
    if (shouldRestoreFocus) {
      trigger.current?.focus({ preventScroll: true });
    }
  }, []);
  useMemoryBrowserFilterMenuDismissal({ isOpen, rootRef: root, close });
  useMemoryBrowserFilterMenuPosition({ isOpen, triggerRef: trigger, setMenuPosition });
  const { types, visibleOptions, isCustomDateOptionVisible, activeFilterKindLabel } =
    memoryBrowserFilterMenuDerivedState({ view, people, filterKind, filterQuery });
  const showFilterType = useCallback(
    (...args: [id: string, isAutoFocusRequested?: boolean]) => {
      const [id, isAutoFocusRequested = false] = args;
      memoryBrowserShowFilterType({
        id,
        isAutoFocusRequested,
        typeRowElements,
        types,
        filterKind,
        filters,
        setSubmenuTop,
        setFilterQuery,
        setIsCustomDate,
        setFilterKind,
        setFrom,
        setTo,
        filterInput,
      });
    },
    [filterKind, filters, types],
  );
  const selectOption = useCallback(
    (id: string) => {
      memoryBrowserApplyFilterSelection({ filterKind, id, filters, onChange });
      close();
    },
    [close, filterKind, filters, onChange],
  );

  return {
    root,
    trigger,
    filterInput,
    isOpen,
    setIsOpen,
    filterKind,
    setFilterKind,
    filterQuery,
    setFilterQuery,
    submenuTop,
    isCustomDate,
    setIsCustomDate,
    isKeyboardMenu,
    setIsKeyboardMenu,
    menuPosition,
    typeRowElements,
    from,
    setFrom,
    to,
    setTo,
    close,
    types,
    showFilterType,
    visibleOptions,
    isCustomDateOptionVisible,
    activeFilterKindLabel,
    selectOption,
    registerTypeRow,
  };
}

function renderMemoryBrowserFilterPopover({
  filterMenu,
  filters,
  onChange,
  hasMorePeople: canLoadMorePeople,
  loadingPeople: isLoadingMorePeople,
  onLoadMorePeople,
}: {
  filterMenu: ReturnType<typeof useMemoryBrowserFilterMenuState>;
  filters: BrowserFilters;
  onChange: (patch: Partial<BrowserFilters>) => void;
  /** @external memory browser toolbar contract */
  hasMorePeople?: boolean;
  /** @external memory browser toolbar contract */
  loadingPeople?: boolean;
  onLoadMorePeople?: () => void;
}) {
  if (!filterMenu.isOpen) {
    return null;
  }

  return (
    <MemoryBrowserFilterPopover
      isKeyboardMenu={filterMenu.isKeyboardMenu}
      menuPosition={filterMenu.menuPosition}
      types={filterMenu.types}
      filterKind={filterMenu.filterKind}
      typeRowElements={filterMenu.typeRowElements}
      registerTypeRow={filterMenu.registerTypeRow}
      filterInputRef={filterMenu.filterInput}
      showFilterType={filterMenu.showFilterType}
      setIsKeyboardMenu={filterMenu.setIsKeyboardMenu}
      submenuTop={filterMenu.submenuTop}
      isCustomDate={filterMenu.isCustomDate}
      activeFilterKindLabel={filterMenu.activeFilterKindLabel}
      from={filterMenu.from}
      to={filterMenu.to}
      setFrom={filterMenu.setFrom}
      setTo={filterMenu.setTo}
      onChange={onChange}
      onClose={() => filterMenu.close()}
      setIsCustomDate={filterMenu.setIsCustomDate}
      filterQuery={filterMenu.filterQuery}
      setFilterQuery={filterMenu.setFilterQuery}
      filters={filters}
      visibleOptions={filterMenu.visibleOptions}
      hasMorePeople={canLoadMorePeople}
      loadingPeople={isLoadingMorePeople}
      onLoadMorePeople={onLoadMorePeople}
      onSelectOption={filterMenu.selectOption}
      isCustomDateOptionVisible={filterMenu.isCustomDateOptionVisible}
    />
  );
}

export function MemoryBrowserToolbar({
  inert: isToolbarInert = false,
  view,
  people,
  filters,
  onChange,
  query,
  search,
  setQuery,
  onSearch,
  children,
  layoutControl,
  onPersonSearch,
  /** @external memory browser toolbar contract */
  hasMorePeople,
  /** @external memory browser toolbar contract */
  loadingPeople,
  onLoadMorePeople,
}: {
  /** @external memory browser toolbar contract */
  inert?: boolean;
  view: "all" | "people";
  people: MemoryPerson[];
  filters: BrowserFilters;
  onChange: (patch: Partial<BrowserFilters>) => void;
  query: string;
  search: string;
  setQuery: (q: string) => void;
  onSearch: (q: string) => void;
  children?: ReactNode;
  layoutControl?: ReactNode;
  onPersonSearch?: (query: string | null) => void;
  /** @external memory browser toolbar contract */
  hasMorePeople?: boolean;
  /** @external memory browser toolbar contract */
  loadingPeople?: boolean;
  onLoadMorePeople?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const filterMenu = useMemoryBrowserFilterMenuState({ filters, onChange, onPersonSearch, view, people });
  const isBackToTopVisible = useMemoryBrowserToolbarScrollTop(filterMenu.root);

  return (
    <div className="relationship-browser-tools" inert={isToolbarInert}>
      <div className="relationship-memory-toolbar">
        <button
          type="button"
          className="relationship-icon-button relationship-back-top"
          aria-label={MEMORY_BROWSER_COPY.backToTop}
          hidden={!isBackToTopVisible}
          onClick={(e) => e.currentTarget.closest(".relationship-memory-content")?.scrollTo({ top: 0 })}
        >
          <MemoryIcon name="up" />
        </button>
        {children}
        {layoutControl}
        <MemoryBrowserFilterControl
          rootRef={filterMenu.root}
          triggerRef={filterMenu.trigger}
          isOpen={filterMenu.isOpen}
          setIsKeyboardMenu={filterMenu.setIsKeyboardMenu}
          close={filterMenu.close}
          setIsOpen={filterMenu.setIsOpen}
          setFilterKind={filterMenu.setFilterKind}
          setFilterQuery={filterMenu.setFilterQuery}
          setIsCustomDate={filterMenu.setIsCustomDate}
          typeRowElements={filterMenu.typeRowElements}
          popover={renderMemoryBrowserFilterPopover({
            filterMenu,
            filters,
            onChange,
            hasMorePeople,
            loadingPeople,
            onLoadMorePeople,
          })}
        />
        <MemoryBrowserToolbarSearchForm
          view={view}
          query={query}
          setQuery={setQuery}
          onSearch={onSearch}
          inputRef={input}
        />
      </div>
      <MemoryBrowserToolbarFilterPills
        view={view}
        people={people}
        filters={filters}
        onChange={onChange}
        search={search}
        setQuery={setQuery}
        onSearch={onSearch}
        inputRef={input}
      />
    </div>
  );
}

export function MemoryTimelineArrow() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      width="16"
      height="16"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="1.5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3" />
    </svg>
  );
}
