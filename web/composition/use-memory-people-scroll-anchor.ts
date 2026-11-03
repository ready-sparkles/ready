import type { MemoryPerson } from "@readymeet/shared";
import { type RefObject, useLayoutEffect, useRef } from "react";

const MEMORY_PEOPLE_SCROLL_CHUNK_SIZE = 50;

// Chunk shells remain mounted even when their rows are virtualized. Their
// geometry lets us preserve an identity across eviction and backward paging.
export function useMemoryPeopleScrollAnchor(input: {
  listRef: RefObject<HTMLDivElement | null>;
  groups: [string, MemoryPerson[]][];
  rowHeight: number;
}): void {
  const { listRef, groups, rowHeight } = input;
  const previous = useRef<{ id: string; offset: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = list?.closest<HTMLElement>(".relationship-memory-content");
    if (!list || !scroller) {
      return;
    }
    const positions = groups.flatMap(([, people], groupIndex) => {
      const chunks = [...list.querySelectorAll<HTMLElement>(`[data-people-group-index="${groupIndex}"]`)];

      return chunks.flatMap((chunk, chunkIndex) => {
        if (chunk.closest("[hidden]")) {
          return [];
        }
        const top = chunk.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

        return people
          .slice(chunkIndex * MEMORY_PEOPLE_SCROLL_CHUNK_SIZE, (chunkIndex + 1) * MEMORY_PEOPLE_SCROLL_CHUNK_SIZE)
          .map((person, index) => ({ id: person.id, offset: top + index * rowHeight }));
      });
    });
    const previousAnchor = previous.current;
    if (scroller.scrollTop > 0 && previousAnchor !== null) {
      const anchor = positions.find((person) => person.id === previousAnchor.id);
      if (anchor) {
        scroller.scrollTop += anchor.offset - previousAnchor.offset;
      }
    }
    const remember = () => {
      previous.current = positions.find((person) => person.offset >= scroller.scrollTop) ?? positions.at(-1) ?? null;
    };
    remember();
    scroller.addEventListener("scroll", remember, { passive: true });

    return () => scroller.removeEventListener("scroll", remember);
  }, [listRef, groups, rowHeight]);
}
