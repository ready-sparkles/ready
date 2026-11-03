"use client";
import { memoryCategories, type MemoryPerson } from "@readymeet/shared";
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { BrowserFilters } from "./memory-browser-controls";
import { MemoryIcon } from "./memory-icons";

const MISSING_DATE_PRESET = "Date preset is missing";

const LABEL_ONE_DAY = "1 day";
const LABEL_THREE_DAYS = "3 days";
const LABEL_ONE_WEEK = "1 week";
const LABEL_ONE_MONTH = "1 month";
const LABEL_THREE_MONTHS = "3 months";
const LABEL_SIX_MONTHS = "6 months";
const LABEL_ONE_YEAR = "1 year";
const LABEL_ANY_TIME = "Any time";
const LABEL_NOW = "Now";
const LABEL_PERSON = "Person";
const LABEL_CATEGORY = "Category";
const LABEL_DATE = "Date";
const LABEL_LAST_CONTACT = "Last contact";
const LABEL_CLEAR_ALL = "Clear all";
const LABEL_APPLY_DATE_FILTER = "Apply date filter";
const LABEL_CUSTOM_DATE_MENU = "Custom date or timeframe…";
const LABEL_FROM_DATE = "From date";
const LABEL_THROUGH_DATE = "Through date";
const LABEL_SEARCH_FILTER = "Search";
const LABEL_REMOVE_SEARCH_FILTER = "Remove search filter";
const LABEL_REMOVE_FILTER_PREFIX = "Remove ";
const LABEL_REMOVE_FILTER_SUFFIX = " filter";
const LABEL_PILL_REMOVE = "×";
const LABEL_SEARCH_OPEN_QUOTE = "“";
const LABEL_SEARCH_CLOSE_QUOTE = "”";
const LABEL_ACTIVE_FILTERS = "Active filters";
const LABEL_CHANGE_TYPE_FILTER = "Change type filter";
const LABEL_CHANGE_OPERATOR_FILTER = "Change operator filter";
const LABEL_CHANGE_VALUE_FILTER = "Change value filter";

const DATE_FILTER_DAYS_ONE = 1;
const DATE_FILTER_DAYS_THREE = 3;
const DATE_FILTER_DAYS_SEVEN = 7;
const DATE_FILTER_MONTHS_ONE = 1;
const DATE_FILTER_MONTHS_THREE = 3;
const DATE_FILTER_MONTHS_SIX = 6;
const DATE_FILTER_MONTHS_TWELVE = 12;
const DATE_INPUT_PAD_WIDTH = 2;
const DATE_END_OFFSET_DAYS = 1;
const DEFAULT_DATE_PRESET_INDEX = 2;
const PILL_EXIT_DELAY_MS = 100;
const FLIP_POSITION_EPSILON_PX = 0.5;
const FLIP_ANIMATION_DURATION_MS = 220;
const FLIP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

const SEGMENTS: readonly Segment[] = ["type", "operator", "value"];

type Kind = "category" | "person" | "date";
type Pill = { id: Kind | "search"; label: string; exitAt?: number };
type Segment = "type" | "operator" | "value";
type DatePresetOption = { label: string; days?: number; months?: number };
type DatePreset = { label: string; value: string };
type MenuOption = { value: string; label: string };

function isNonEmptyString(value: string): boolean {
  return value !== "";
}

function isFilterKind(id: Kind | "search"): id is Kind {
  return id !== "search";
}

function operatorKey(kind: Kind): "categoryOperator" | "personOperator" | "dateOperator" {
  if (kind === "category") {
    return "categoryOperator";
  }
  if (kind === "person") {
    return "personOperator";
  }

  return "dateOperator";
}

function clearKind(kind: Kind): Partial<BrowserFilters> {
  if (kind === "date") {
    return { from: "", to: "" };
  }

  if (kind === "category") {
    return { category: "" };
  }

  return { person: "" };
}

function datePresets(): DatePreset[] {
  const options: DatePresetOption[] = [
    { label: LABEL_ONE_DAY, days: DATE_FILTER_DAYS_ONE },
    { label: LABEL_THREE_DAYS, days: DATE_FILTER_DAYS_THREE },
    { label: LABEL_ONE_WEEK, days: DATE_FILTER_DAYS_SEVEN },
    { label: LABEL_ONE_MONTH, months: DATE_FILTER_MONTHS_ONE },
    { label: LABEL_THREE_MONTHS, months: DATE_FILTER_MONTHS_THREE },
    { label: LABEL_SIX_MONTHS, months: DATE_FILTER_MONTHS_SIX },
    { label: LABEL_ONE_YEAR, months: DATE_FILTER_MONTHS_TWELVE },
  ];

  return options.map((option) => {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    if (option.days !== undefined) {
      cutoff.setDate(cutoff.getDate() - option.days);
    } else if (option.months !== undefined) {
      const day = cutoff.getDate();
      cutoff.setDate(1);
      cutoff.setMonth(cutoff.getMonth() - option.months);
      cutoff.setDate(Math.min(day, new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate()));
    }

    return { label: option.label, value: cutoff.toISOString() };
  });
}

function formatInputDate({ value, isEnd = false }: { value: string; isEnd?: boolean }): string {
  if (!isNonEmptyString(value)) {
    return "";
  }
  const date = new Date(value);
  if (isEnd) {
    date.setDate(date.getDate() - DATE_END_OFFSET_DAYS);
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(DATE_INPUT_PAD_WIDTH, "0")}-${String(date.getDate()).padStart(DATE_INPUT_PAD_WIDTH, "0")}`;
}

function buildDateLabel({ filters, preset }: { filters: BrowserFilters; preset: DatePreset | undefined }): string {
  const fromLabel = isNonEmptyString(filters.from) ? new Date(filters.from).toLocaleDateString() : LABEL_ANY_TIME;
  const toLabel = isNonEmptyString(filters.to)
    ? new Date(Date.parse(filters.to) - DATE_END_OFFSET_DAYS).toLocaleDateString()
    : LABEL_NOW;

  if (preset !== undefined) {
    return preset.label;
  }

  return `${fromLabel} – ${toLabel}`;
}

function findDatePreset({
  filters,
  presets,
}: {
  filters: BrowserFilters;
  presets: DatePreset[];
}): DatePreset | undefined {
  if (isNonEmptyString(filters.from)) {
    return undefined;
  }

  return presets.find((option) => option.value === filters.to);
}

function buildIncomingPills({
  search,
  filters,
  personLabel,
  dateLabel,
}: {
  search: string;
  filters: BrowserFilters;
  personLabel: string;
  dateLabel: string;
}): Pill[] {
  return [
    ...(isNonEmptyString(search) ? [{ id: "search" as const, label: search }] : []),
    ...(isNonEmptyString(filters.category) ? [{ id: "category" as const, label: filters.category }] : []),
    ...(isNonEmptyString(filters.person) ? [{ id: "person" as const, label: personLabel }] : []),
    ...(isNonEmptyString(filters.from) || isNonEmptyString(filters.to)
      ? [{ id: "date" as const, label: dateLabel }]
      : []),
  ];
}

function removeFilterAriaLabel(label: string): string {
  return `${LABEL_REMOVE_FILTER_PREFIX}${label}${LABEL_REMOVE_FILTER_SUFFIX}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function rememberPresencePositions(root: HTMLDivElement | null): { element: HTMLElement; top: number; left: number }[] {
  const presence = [...(root?.querySelectorAll<HTMLElement>("[data-filter-presence]") ?? [])];
  const body = root?.closest(".relationship-memory-page")?.querySelector<HTMLElement>("[data-memory-results]");
  const elements: HTMLElement[] = body !== null && body !== undefined ? [...presence, body] : presence;

  return elements.map((element) => {
    const rect = element.getBoundingClientRect();

    return { element, top: rect.top, left: rect.left };
  });
}

function mergeVisiblePills({ previous, incoming }: { previous: Pill[]; incoming: Pill[] }): Pill[] {
  const retained = previous.map(
    (pill) =>
      incoming.find((next) => next.id === pill.id) ?? {
        ...pill,
        exitAt: pill.exitAt ?? performance.now() + PILL_EXIT_DELAY_MS,
      },
  );
  const added = incoming.filter((pill) => !previous.some((old) => old.id === pill.id));

  return [...retained, ...added];
}

function filterTypeOptions({ view }: { view: "all" | "people" }): { value: Kind; label: string }[] {
  if (view === "all") {
    return [
      { value: "category", label: LABEL_CATEGORY },
      { value: "person", label: LABEL_PERSON },
      { value: "date", label: LABEL_DATE },
    ];
  }

  return [
    { value: "category", label: LABEL_CATEGORY },
    { value: "date", label: LABEL_LAST_CONTACT },
  ];
}

function defaultFilterPatch({
  kind,
  people,
  presets,
}: {
  kind: Kind;
  people: MemoryPerson[];
  presets: DatePreset[];
}): Partial<BrowserFilters> {
  if (kind === "category") {
    return { category: memoryCategories[0], categoryOperator: "is" };
  }
  if (kind === "person") {
    return { person: people[0]?.id ?? "", personOperator: "is" };
  }

  const defaultPreset = presets[DEFAULT_DATE_PRESET_INDEX];
  if (defaultPreset === undefined) {
    throw new Error(MISSING_DATE_PRESET);
  }

  return { from: "", to: defaultPreset.value, dateOperator: "is" };
}

function menuOptions({
  segment,
  id,
  types,
  people,
  presets,
  preset,
}: {
  segment: Segment;
  id: Kind;
  types: { value: Kind; label: string }[];
  people: MemoryPerson[];
  presets: DatePreset[];
  preset: DatePreset | undefined;
}): MenuOption[] {
  if (segment === "type") {
    return types.filter((type) => type.value !== "person" || people.length !== 0);
  }
  if (segment === "operator") {
    const hasPreset = preset !== undefined;

    return [
      { value: "is", label: id === "date" && hasPreset ? "older than" : "is" },
      { value: "is_not", label: id === "date" && hasPreset ? "not older than" : "is not" },
    ];
  }
  if (id === "category") {
    return memoryCategories.map((value) => ({ value, label: value }));
  }
  if (id === "person") {
    return people.map((person) => ({ value: person.id, label: person.name }));
  }

  return presets.map((entry) => ({ value: entry.value, label: `Older than ${entry.label}` }));
}

function menuSelectedValue({
  segment,
  id,
  isNegative,
  filters,
}: {
  segment: Segment;
  id: Kind;
  isNegative: boolean;
  filters: BrowserFilters;
}): string {
  if (segment === "type") {
    return id;
  }
  if (segment === "operator") {
    return isNegative ? "is_not" : "is";
  }
  if (id === "category") {
    return filters.category;
  }
  if (id === "person") {
    return filters.person;
  }

  return filters.to;
}

function nextMenuItemIndex({ key, index, length }: { key: string; index: number; length: number }): number | null {
  if (key === "ArrowDown") {
    return (index + 1) % length;
  }
  if (key === "ArrowUp") {
    return index <= 0 ? length - 1 : index - 1;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return length - 1;
  }

  return null;
}

function focusMenuItemIndex({
  event,
  items,
}: {
  event: KeyboardEvent<HTMLDivElement>;
  items: HTMLButtonElement[];
}): void {
  const active = document.activeElement;
  const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
  const next = nextMenuItemIndex({ key: event.key, index, length: items.length });
  if (next !== null && items.length !== 0) {
    event.preventDefault();
    items[next]?.focus();
  }
}

function pillTypeLabel({
  pillId,
  types,
}: {
  pillId: Kind | "search";
  types: { value: Kind; label: string }[];
}): string {
  if (!isFilterKind(pillId)) {
    return LABEL_SEARCH_FILTER;
  }

  return types.find((type) => type.value === pillId)?.label ?? "";
}

function operatorSegmentLabel({
  pillId,
  preset,
  filters,
}: {
  pillId: Kind;
  preset: DatePreset | undefined;
  filters: BrowserFilters;
}): string {
  if (pillId === "date" && preset !== undefined) {
    return filters.dateOperator === "is_not" ? "not older than" : "older than";
  }

  return filters[operatorKey(pillId)] === "is_not" ? "is not" : "is";
}

function segmentAriaLabel({ segment }: { segment: Segment }): string {
  if (segment === "type") {
    return LABEL_CHANGE_TYPE_FILTER;
  }
  if (segment === "operator") {
    return LABEL_CHANGE_OPERATOR_FILTER;
  }

  return LABEL_CHANGE_VALUE_FILTER;
}

function FilterPillCustomDateForm({
  from,
  to,
  onFromChange,
  onToChange,
  onChange,
  onClose,
}: {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const end = isNonEmptyString(to) ? new Date(`${to}T00:00:00`) : null;
        end?.setDate(end.getDate() + DATE_END_OFFSET_DAYS);
        onChange({
          from: isNonEmptyString(from) ? new Date(`${from}T00:00:00`).toISOString() : "",
          to: end?.toISOString() ?? "",
        });
        onClose();
      }}
    >
      <label>
        {LABEL_FROM_DATE}
        <input
          type="date"
          value={from}
          max={isNonEmptyString(to) ? to : undefined}
          onChange={(event) => onFromChange(event.target.value)}
        />
      </label>
      <label>
        {LABEL_THROUGH_DATE}
        <input
          type="date"
          value={to}
          min={isNonEmptyString(from) ? from : undefined}
          onChange={(event) => onToChange(event.target.value)}
        />
      </label>
      <button type="submit">{LABEL_APPLY_DATE_FILTER}</button>
    </form>
  );
}

function FilterPillTypeMenuOptions({
  id,
  types,
  people,
  selected,
  onChange,
  onClose,
  presets,
}: {
  id: Kind;
  types: { value: Kind; label: string }[];
  people: MemoryPerson[];
  selected: string;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
  presets: DatePreset[];
}) {
  const options = types.filter((type) => type.value !== "person" || people.length !== 0);

  return options.map((option) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={option.value === selected}
      key={option.value}
      onClick={() => {
        if (option.value !== id) {
          onChange({ ...clearKind(id), ...defaultFilterPatch({ kind: option.value, people, presets }) });
        }
        onClose();
      }}
    >
      <span>{option.label}</span>
      {option.value === selected ? <MemoryIcon name="check" /> : null}
    </button>
  ));
}

function FilterPillValueMenuOptions({
  id,
  segment,
  filters,
  types,
  people,
  presets,
  preset,
  query,
  onQueryChange,
  onShowCustomDate,
  onChange,
  onClose,
}: {
  id: Kind;
  segment: Segment;
  filters: BrowserFilters;
  types: { value: Kind; label: string }[];
  people: MemoryPerson[];
  presets: DatePreset[];
  preset: DatePreset | undefined;
  query: string;
  onQueryChange: (value: string) => void;
  onShowCustomDate: () => void;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
}) {
  const isNegative = filters[operatorKey(id)] === "is_not";
  const options = menuOptions({ segment, id, types, people, presets, preset });
  const selected = menuSelectedValue({ segment, id, isNegative, filters });
  const normalizedQuery = query.toLocaleLowerCase();

  return (
    <>
      {segment === "value" && id !== "date" ? (
        <input
          type="search"
          aria-label={`Search ${id} filter values`}
          placeholder="Search…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      ) : null}
      {options
        .filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery))
        .map((option) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={option.value === selected}
            key={option.value}
            onClick={() => {
              if (segment === "operator") {
                onChange({ [operatorKey(id)]: option.value });
              } else if (id === "date") {
                onChange({ from: "", to: option.value });
              } else if (id === "category") {
                onChange({ category: option.value });
              } else {
                onChange({ person: option.value });
              }
              onClose();
            }}
          >
            <span>{option.label}</span>
            {option.value === selected ? <MemoryIcon name="check" /> : null}
          </button>
        ))}
      {segment === "value" && id === "date" ? (
        <button type="button" role="menuitem" onClick={onShowCustomDate}>
          {LABEL_CUSTOM_DATE_MENU}
        </button>
      ) : null}
    </>
  );
}

function FilterPillMenu({
  id,
  segment,
  editor,
  filters,
  types,
  people,
  presets,
  preset,
  isCustomDate,
  query,
  from,
  to,
  onQueryChange,
  onFromChange,
  onToChange,
  onShowCustomDate,
  onChange,
  onClose,
}: {
  id: Kind;
  segment: Segment;
  editor: { id: Kind; segment: Segment } | null;
  filters: BrowserFilters;
  types: { value: Kind; label: string }[];
  people: MemoryPerson[];
  presets: DatePreset[];
  preset: DatePreset | undefined;
  isCustomDate: boolean;
  query: string;
  from: string;
  to: string;
  onQueryChange: (value: string) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onShowCustomDate: () => void;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
}) {
  if (editor?.id !== id || editor.segment !== segment) {
    return null;
  }

  const isNegative = filters[operatorKey(id)] === "is_not";
  const selected = menuSelectedValue({ segment, id, isNegative, filters });

  return (
    <div
      className={`relationship-pill-menu${segment === "value" ? " is-right-aligned" : ""}`}
      role="menu"
      aria-label={segmentAriaLabel({ segment })}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();

          return;
        }
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        focusMenuItemIndex({ event, items });
      }}
    >
      {isCustomDate ? (
        <FilterPillCustomDateForm
          from={from}
          to={to}
          onFromChange={onFromChange}
          onToChange={onToChange}
          onChange={onChange}
          onClose={onClose}
        />
      ) : segment === "type" ? (
        <FilterPillTypeMenuOptions
          id={id}
          types={types}
          people={people}
          selected={selected}
          onChange={onChange}
          onClose={onClose}
          presets={presets}
        />
      ) : (
        <FilterPillValueMenuOptions
          id={id}
          segment={segment}
          filters={filters}
          types={types}
          people={people}
          presets={presets}
          preset={preset}
          query={query}
          onQueryChange={onQueryChange}
          onShowCustomDate={onShowCustomDate}
          onChange={onChange}
          onClose={onClose}
        />
      )}
    </div>
  );
}

function FilterPillSegment({
  pill,
  segment,
  types,
  filters,
  preset,
  editor,
  people,
  presets,
  isCustomDate,
  query,
  from,
  to,
  onQueryChange,
  onFromChange,
  onToChange,
  onShowCustomDate,
  onChange,
  onClose,
  onToggle,
}: {
  pill: Pill;
  segment: Segment;
  types: { value: Kind; label: string }[];
  filters: BrowserFilters;
  preset: DatePreset | undefined;
  editor: { id: Kind; segment: Segment } | null;
  people: MemoryPerson[];
  presets: DatePreset[];
  isCustomDate: boolean;
  query: string;
  from: string;
  to: string;
  onQueryChange: (value: string) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onShowCustomDate: () => void;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onClose: () => void;
  onToggle: (input: { id: Kind; segment: Segment; button: HTMLButtonElement }) => void;
}) {
  if (!isFilterKind(pill.id)) {
    return null;
  }

  const kind = pill.id;
  const typeLabel = types.find((type) => type.value === kind)?.label ?? "";
  const operatorLabel = operatorSegmentLabel({ pillId: kind, preset, filters });
  const segmentText = segment === "type" ? typeLabel : segment === "operator" ? operatorLabel : pill.label;
  const ruleWord = segment === "operator" ? "rule" : segment;
  // The accessible rule name stays "is"/"is not" even when a date preset shows "older than" visually (matches main).
  const operatorAriaLabel = filters[operatorKey(kind)] === "is_not" ? "is not" : "is";
  const ariaFrom = segment === "type" ? typeLabel : segment === "operator" ? operatorAriaLabel : pill.label;

  return (
    <span className="relationship-pill-segment-wrap">
      <button
        type="button"
        className={`relationship-pill-segment is-${segment}`}
        aria-label={`Change filter ${ruleWord} from ${ariaFrom}`}
        aria-haspopup="menu"
        aria-expanded={editor?.id === kind && editor.segment === segment ? true : false}
        onClick={(event) => onToggle({ id: kind, segment, button: event.currentTarget })}
      >
        {segment === "type" ? <MemoryIcon name={kind} /> : null}
        <span>{segmentText}</span>
      </button>
      <FilterPillMenu
        id={kind}
        segment={segment}
        editor={editor}
        filters={filters}
        types={types}
        people={people}
        presets={presets}
        preset={preset}
        isCustomDate={isCustomDate}
        query={query}
        from={from}
        to={to}
        onQueryChange={onQueryChange}
        onFromChange={onFromChange}
        onToChange={onToChange}
        onShowCustomDate={onShowCustomDate}
        onChange={onChange}
        onClose={onClose}
      />
    </span>
  );
}

function useKeyboardNavigationMode(): RefObject<boolean> {
  const isKeyboardNavigation = useRef(false);

  useEffect(() => {
    const onPointer = () => {
      isKeyboardNavigation.current = false;
    };
    const onKey = () => {
      isKeyboardNavigation.current = true;
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);

    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  return isKeyboardNavigation;
}

function useFilterPillVisibility({
  incoming,
  root,
  isKeyboardNavigation,
}: {
  incoming: Pill[];
  root: RefObject<HTMLDivElement | null>;
  isKeyboardNavigation: RefObject<boolean>;
}) {
  const [visible, setVisible] = useState(incoming);
  const before = useRef<{ element: HTMLElement; top: number; left: number }[]>([]);
  const animations = useRef(new Map<HTMLElement, Animation>());

  useLayoutEffect(() => {
    before.current = rememberPresencePositions(root.current);
    const isImmediate = isKeyboardNavigation.current || prefersReducedMotion();
    setVisible((previous) => (isImmediate ? incoming : mergeVisiblePills({ previous, incoming })));
  }, [incoming, isKeyboardNavigation, root]);

  useEffect(() => {
    const deadlines = visible.flatMap((pill) => (pill.exitAt === undefined ? [] : [pill.exitAt]));
    if (deadlines.length === 0) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        before.current = rememberPresencePositions(root.current);
        setVisible((previous) =>
          previous.filter((pill) => pill.exitAt === undefined || pill.exitAt > performance.now()),
        );
      },
      Math.max(0, Math.min(...deadlines) - performance.now()),
    );

    return () => window.clearTimeout(timer);
  }, [root, visible]);

  useLayoutEffect(() => {
    const animationMap = animations.current;
    before.current.forEach(({ element, top, left }) => {
      animationMap.get(element)?.cancel();
      animationMap.delete(element);
      if (!element.isConnected || prefersReducedMotion() || isKeyboardNavigation.current) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const x = left - rect.left;
      const y = top - rect.top;
      if (Math.abs(x) < FLIP_POSITION_EPSILON_PX && Math.abs(y) < FLIP_POSITION_EPSILON_PX) {
        return;
      }
      const animation = element.animate(
        [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0, 0)" }],
        { duration: FLIP_ANIMATION_DURATION_MS, easing: FLIP_EASING },
      );
      animationMap.set(element, animation);
      animation.onfinish = () => {
        if (animationMap.get(element) === animation) {
          animationMap.delete(element);
        }
      };
    });
    before.current = [];
  }, [isKeyboardNavigation, visible]);

  useEffect(() => {
    const running = animations.current;

    return () => {
      running.forEach((animation) => {
        animation.cancel();
      });
      running.clear();
    };
  }, []);

  return visible;
}

function useFilterEditorDismissal({
  root,
  editor,
  onClose,
}: {
  root: RefObject<HTMLDivElement | null>;
  editor: { id: Kind; segment: Segment } | null;
  onClose: (input: { shouldRestore: boolean }) => void;
}) {
  useEffect(() => {
    if (editor === null) {
      return;
    }
    const onOutside = (event: PointerEvent) => {
      const target = event.target;
      const rootNode = root.current;
      if (rootNode === null || !(target instanceof Node) || !rootNode.contains(target)) {
        onClose({ shouldRestore: false });
      }
    };
    document.addEventListener("pointerdown", onOutside, true);

    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [editor, onClose, root]);
}

function useFilterEditorFocus({
  root,
  editor,
  isCustomDate,
}: {
  root: RefObject<HTMLDivElement | null>;
  editor: { id: Kind; segment: Segment } | null;
  isCustomDate: boolean;
}) {
  useLayoutEffect(() => {
    if (editor !== null) {
      root.current
        ?.querySelector<HTMLElement>('[role="menu"] input, [role="menu"] button')
        ?.focus({ preventScroll: true });
    }
  }, [editor, isCustomDate, root]);
}

function FilterPillRemoveControl({
  pill,
  onDismissEditor,
  onRemoveSearch,
  onChange,
}: {
  pill: Pill;
  onDismissEditor: () => void;
  onRemoveSearch: () => void;
  onChange: (patch: Partial<BrowserFilters>) => void;
}) {
  return (
    <button
      type="button"
      className="relationship-pill-remove"
      aria-label={pill.id === "search" ? LABEL_REMOVE_SEARCH_FILTER : removeFilterAriaLabel(pill.label)}
      onClick={() => {
        onDismissEditor();
        if (pill.id === "search") {
          onRemoveSearch();
        } else if (isFilterKind(pill.id)) {
          onChange(clearKind(pill.id));
        }
      }}
    >
      <span aria-hidden="true">{LABEL_PILL_REMOVE}</span>
    </button>
  );
}

function SearchQueryPill({ label, onEditSearch }: { label: string; onEditSearch: () => void }) {
  return (
    <button type="button" className="relationship-pill-segment is-type" onClick={onEditSearch}>
      <MemoryIcon name="search" />
      <span>
        {LABEL_SEARCH_OPEN_QUOTE}
        {label}
        {LABEL_SEARCH_CLOSE_QUOTE}
      </span>
    </button>
  );
}

function VisibleFilterPill({
  pill,
  types,
  editor,
  filters,
  preset,
  people,
  presets,
  isCustomDate,
  query,
  from,
  to,
  onEditSearch,
  onQueryChange,
  onFromChange,
  onToChange,
  onShowCustomDate,
  onChange,
  onCloseEditor,
  onDismissEditor,
  onToggle,
  onRemoveSearch,
}: {
  pill: Pill;
  types: { value: Kind; label: string }[];
  editor: { id: Kind; segment: Segment } | null;
  filters: BrowserFilters;
  preset: DatePreset | undefined;
  people: MemoryPerson[];
  presets: DatePreset[];
  isCustomDate: boolean;
  query: string;
  from: string;
  to: string;
  onEditSearch: () => void;
  onQueryChange: (value: string) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onShowCustomDate: () => void;
  onChange: (patch: Partial<BrowserFilters>) => void;
  onCloseEditor: () => void;
  onDismissEditor: () => void;
  onToggle: (input: { id: Kind; segment: Segment; button: HTMLButtonElement }) => void;
  onRemoveSearch: () => void;
}) {
  return (
    <span
      className="relationship-filter-presence"
      data-filter-presence
      data-exiting={pill.exitAt !== undefined || undefined}
      inert={pill.exitAt !== undefined}
      aria-hidden={pill.exitAt !== undefined || undefined}
    >
      <span
        className="relationship-query-pill"
        role="group"
        aria-label={`${pillTypeLabel({ pillId: pill.id, types })} filter`}
      >
        {pill.id === "search" ? (
          <SearchQueryPill label={pill.label} onEditSearch={onEditSearch} />
        ) : (
          SEGMENTS.map((segment) => (
            <FilterPillSegment
              key={segment}
              pill={pill}
              segment={segment}
              types={types}
              filters={filters}
              preset={preset}
              editor={editor}
              people={people}
              presets={presets}
              isCustomDate={isCustomDate}
              query={query}
              from={from}
              to={to}
              onQueryChange={onQueryChange}
              onFromChange={onFromChange}
              onToChange={onToChange}
              onShowCustomDate={onShowCustomDate}
              onChange={onChange}
              onClose={onCloseEditor}
              onToggle={onToggle}
            />
          ))
        )}
        <FilterPillRemoveControl
          pill={pill}
          onDismissEditor={onDismissEditor}
          onRemoveSearch={onRemoveSearch}
          onChange={onChange}
        />
      </span>
    </span>
  );
}

function useMemoryFilterPillModel({
  view,
  people,
  filters,
  search,
}: {
  view: "all" | "people";
  people: MemoryPerson[];
  filters: BrowserFilters;
  search: string;
}) {
  const presets = datePresets();
  const preset = findDatePreset({ filters, presets });
  const dateLabel = buildDateLabel({ filters, preset });
  const personLabel = people.find((person) => person.id === filters.person)?.name ?? LABEL_PERSON;
  const incoming = useMemo(
    () => buildIncomingPills({ search, filters, personLabel, dateLabel }),
    [search, filters.category, filters.person, filters.from, filters.to, personLabel, dateLabel],
  );
  const types = useMemo(() => filterTypeOptions({ view }), [view]);

  return { presets, preset, incoming, types };
}

export function MemoryFilterPills({
  view,
  people,
  filters,
  onChange,
  search,
  onEditSearch,
  onRemoveSearch,
  onClear,
}: {
  view: "all" | "people";
  people: MemoryPerson[];
  filters: BrowserFilters;
  onChange: (patch: Partial<BrowserFilters>) => void;
  search: string;
  onEditSearch: () => void;
  onRemoveSearch: () => void;
  onClear: () => void;
}) {
  const { presets, preset, incoming, types } = useMemoryFilterPillModel({ view, people, filters, search });
  const [editor, setEditor] = useState<{ id: Kind; segment: Segment } | null>(null);
  const [query, setQuery] = useState("");
  const [isCustomDate, setIsCustomDate] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const isKeyboardNavigation = useKeyboardNavigationMode();
  const visible = useFilterPillVisibility({ incoming, root, isKeyboardNavigation });

  const closeEditor = ({ shouldRestore = true }: { shouldRestore?: boolean } = {}) => {
    setEditor(null);
    if (shouldRestore) {
      trigger.current?.focus({ preventScroll: true });
    }
  };

  useFilterEditorDismissal({ root, editor, onClose: closeEditor });
  useFilterEditorFocus({ root, editor, isCustomDate });

  function openEditorToggle({ id, segment, button }: { id: Kind; segment: Segment; button: HTMLButtonElement }) {
    trigger.current = button;
    setQuery("");
    setIsCustomDate(false);
    setFrom(formatInputDate({ value: filters.from }));
    setTo(formatInputDate({ value: filters.to, isEnd: true }));
    setEditor(editor?.id === id && editor.segment === segment ? null : { id, segment });
  }

  return (
    <div
      ref={root}
      className="relationship-filter-chips"
      aria-label={LABEL_ACTIVE_FILTERS}
      data-empty={visible.length === 0 || undefined}
      data-instant={isKeyboardNavigation.current || undefined}
    >
      {visible.map((pill) => (
        <VisibleFilterPill
          key={pill.id}
          pill={pill}
          types={types}
          editor={editor}
          filters={filters}
          preset={preset}
          people={people}
          presets={presets}
          isCustomDate={isCustomDate}
          query={query}
          from={from}
          to={to}
          onEditSearch={onEditSearch}
          onQueryChange={setQuery}
          onFromChange={setFrom}
          onToChange={setTo}
          onShowCustomDate={() => setIsCustomDate(true)}
          onChange={onChange}
          onCloseEditor={() => closeEditor()}
          onDismissEditor={() => setEditor(null)}
          onToggle={openEditorToggle}
          onRemoveSearch={onRemoveSearch}
        />
      ))}
      {incoming.length !== 0 ? (
        <button
          type="button"
          className="relationship-clear-filters"
          onClick={() => {
            setEditor(null);
            onClear();
          }}
        >
          {LABEL_CLEAR_ALL}
        </button>
      ) : null}
    </div>
  );
}
