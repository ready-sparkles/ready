// Sorted geometry stays in memory; DOM work is limited to the visible window.
export function lowerBound<T>(input: { items: readonly T[]; value: number; offset: (item: T) => number }): number {
  const search = (range: { low: number; high: number }): number => {
    if (range.low >= range.high) {
      return range.low;
    }
    const mid = (range.low + range.high) >>> 1;
    const item = input.items[mid];
    if (item === undefined) {
      return range.low;
    }
    if (input.offset(item) < input.value) {
      return search({ low: mid + 1, high: range.high });
    }

    return search({ low: range.low, high: mid });
  };

  return search({ low: 0, high: input.items.length });
}

export function nearestIndex<T>(input: { items: readonly T[]; value: number; offset: (item: T) => number }): number {
  if (input.items.length === 0) {
    return -1;
  }
  const next = lowerBound({ items: input.items, value: input.value, offset: input.offset });
  if (next === 0) {
    return 0;
  }
  if (next === input.items.length) {
    return next - 1;
  }

  const previousItem = input.items[next - 1];
  const nextItem = input.items[next];
  if (previousItem === undefined || nextItem === undefined) {
    return next - 1;
  }

  return input.value - input.offset(previousItem) <= input.offset(nextItem) - input.value ? next - 1 : next;
}

export function windowIndices(input: {
  count: number;
  start: number;
  end: number;
  pinned?: readonly number[];
}): number[] {
  const rangeStart = Math.max(0, input.start);
  const rangeEnd = Math.min(input.count, input.end);
  const rangeLength = Math.max(0, rangeEnd - rangeStart);
  const range = Array.from({ length: rangeLength }, (_, offset) => rangeStart + offset);
  const pinned = (input.pinned ?? []).filter((index) => index >= 0 && index < input.count);

  return [...new Set([...range, ...pinned])].sort((left, right) => left - right);
}

const MEMORY_ROW_HEIGHT = 44;
const MEMORY_ROW_GAP = 0;
export const MEMORY_DAY_HEADER_HEIGHT = 48;
export const DEFAULT_EXPANDED_MEMORY_ROW_HEIGHT = 340;

type ListGeometry = {
  offset: (index: number) => number;
  height: (index: number) => number;
  headerHeight: (index: number) => number;
  indexAt: (position: number) => number;
  visibleIndices: number[];
  total: number;
};

export function createListGeometry(input: {
  count: number;
  expandedIndex?: number;
  expandedHeight?: number;
  dayStarts?: readonly number[];
  collapsedIndices?: ReadonlySet<number>;
  rowHeight?: number;
  dayHeaderHeight?: number;
}): ListGeometry {
  const count = input.count;
  const expandedIndex = input.expandedIndex ?? -1;
  const expandedHeight = input.expandedHeight ?? DEFAULT_EXPANDED_MEMORY_ROW_HEIGHT;
  const dayStarts = input.dayStarts ?? [];
  const collapsedIndices = input.collapsedIndices ?? new Set<number>();
  const rowHeight = input.rowHeight ?? MEMORY_ROW_HEIGHT;
  const dayHeaderHeight = input.dayHeaderHeight ?? MEMORY_DAY_HEADER_HEIGHT;
  const stride = rowHeight + MEMORY_ROW_GAP;
  const extra = expandedIndex >= 0 ? Math.max(0, expandedHeight - rowHeight) : 0;
  const starts = new Set(dayStarts);
  const headerHeight = (index: number): number => (starts.has(index) ? dayHeaderHeight : 0);
  const height = (index: number): number =>
    (collapsedIndices.has(index) ? 0 : index === expandedIndex ? rowHeight + extra : rowHeight) + headerHeight(index);

  const built = Array.from({ length: count }, (_, index) => {
    const size = height(index);
    const strideGap = collapsedIndices.has(index) ? 0 : stride - rowHeight;

    return { index, size, strideGap };
  });

  const offsets = built.reduce<number[]>(
    (accumulator, row) => {
      const previous = accumulator.at(-1) ?? 0;

      return [...accumulator, previous + row.size + row.strideGap];
    },
    [0],
  );

  const visibleIndices = built.filter((row) => row.size > 0).map((row) => row.index);

  const offset = (index: number): number => offsets[index] ?? 0;

  const indexAt = (position: number): number => {
    const search = (range: { low: number; high: number }): number => {
      if (range.low >= range.high) {
        return visibleIndices[Math.min(visibleIndices.length - 1, range.low)] ?? 0;
      }
      const mid = (range.low + range.high) >>> 1;
      const index = visibleIndices[mid];
      if (index === undefined) {
        return visibleIndices[Math.min(visibleIndices.length - 1, range.low)] ?? 0;
      }
      if (offset(index) + height(index) <= position) {
        return search({ low: mid + 1, high: range.high });
      }

      return search({ low: range.low, high: mid });
    };

    return search({ low: 0, high: visibleIndices.length });
  };

  return { offset, height, headerHeight, indexAt, visibleIndices, total: offset(count) };
}

export function getMemoryDayGroups(days: readonly string[]): { day: string; index: number; count: number }[] {
  return days.reduce<{ day: string; index: number; count: number }[]>((groups, day, index) => {
    const previous = groups.at(-1);
    if (previous?.day === day) {
      return [...groups.slice(0, -1), { ...previous, count: previous.count + 1 }];
    }

    return [...groups, { day, index, count: 1 }];
  }, []);
}
