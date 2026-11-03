import type { MemoryPerson } from "@readymeet/shared";
import Link from "next/link";
import type { ReactNode } from "react";

export function memoryPersonMentions(input: { text: string; people: Pick<MemoryPerson, "id" | "name">[] }) {
  const aliases = new Map<string, Set<string>>();
  input.people.forEach((person) => {
    const name = person.name.trim();
    const first = name.split(/\s+/)[0];
    const aliasCandidates = new Set([name, ...(first !== undefined && first.length > 1 ? [first] : [])]);
    aliasCandidates.forEach((alias) => {
      if (alias === "") {
        return;
      }
      const key = alias.toLocaleLowerCase();
      const existingIds = aliases.get(key);
      const ids = existingIds === undefined ? new Set<string>() : new Set(existingIds);
      ids.add(person.id);
      aliases.set(key, ids);
    });
  });
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) {
    return [];
  }
  const pattern = new RegExp(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");

  return [...input.text.matchAll(pattern)].flatMap((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const hasWordCharacterBefore = /[\p{L}\p{M}\p{N}_]$/u.test(input.text.slice(0, start));
    const hasWordCharacterAfter = /^[\p{L}\p{M}\p{N}_]/u.test(input.text.slice(end));
    const ids = aliases.get(match[0].toLocaleLowerCase());
    // Only link known participants, and never guess between same-name people.
    if (hasWordCharacterBefore || hasWordCharacterAfter || ids?.size !== 1) {
      return [];
    }
    const [personId] = [...ids];
    if (personId === undefined) {
      return [];
    }

    return [{ start, end, personId }];
  });
}

export function MemoryPersonText({
  text,
  people,
  returnTo,
}: {
  text: string;
  people: MemoryPerson[];
  returnTo: string;
}) {
  const mentions = memoryPersonMentions({ text, people });
  const content = mentions.reduce<{ nodes: ReactNode[]; cursor: number }>(
    (accumulator, mention) => {
      const prefix = text.slice(accumulator.cursor, mention.start);
      const person = people.find((entry) => entry.id === mention.personId);
      const personName = person?.name ?? "person";
      const nextNodes = [
        ...accumulator.nodes,
        <span key={`${mention.start}-${mention.personId}`}>
          {prefix}
          <Link
            className="relationship-person-mention"
            href={`/workspace/memory/people/${mention.personId}?return=${encodeURIComponent(returnTo)}`}
            aria-label={`Open ${personName}`}
          >
            {text.slice(mention.start, mention.end)}
          </Link>
        </span>,
      ];

      return { nodes: nextNodes, cursor: mention.end };
    },
    { nodes: [], cursor: 0 },
  );

  return (
    <>
      {content.nodes}
      {text.slice(content.cursor)}
    </>
  );
}
