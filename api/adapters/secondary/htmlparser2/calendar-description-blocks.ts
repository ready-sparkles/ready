import { Parser } from "htmlparser2";

type Range = { start: number; end: number };
type ElementRange = Range & { name: string; textStart: number; textEnd: number; href?: string };
const BLOCK_TAGS = new Set(["div", "p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);

const READY_DESCRIPTION_BLOCK_PATTERN =
  /(?:^|\n)[ \t]*Ready[ \t]+meeting[ \t]*\n\s*Join[ \t]+meeting:[ \t]*(https?:\/\/[^\s<>]+)[ \t]*(?:\n\s*Dial-in:[ \t]*[^\n]+?[ \t]+PIN:[ \t]*[0-9]+#)?(?=[ \t]*(?:\n|$))/g;

type Projection = {
  text: string;
  characters: Range[];
  elements: ElementRange[];
  stack: ElementRange[];
};

type AppendInput = { value: string; start: number; end: number; isLiteral?: boolean };

function collectReadyBlockRanges(input: { projection: Projection; isReadyUrl: (url: string) => boolean }): Range[] {
  return [...input.projection.text.matchAll(READY_DESCRIPTION_BLOCK_PATTERN)].flatMap((match) => {
    const joinUrl = match[1];
    if (joinUrl === undefined || joinUrl === "" || !input.isReadyUrl(joinUrl)) {
      return [];
    }
    const start = match.index + match[0].indexOf("Ready");
    const end = match.index + match[0].trimEnd().length;
    const characterRanges = input.projection.characters.slice(start, end).filter((range) => range.end > range.start);
    const elementRanges = input.projection.elements.filter((node) => {
      // Remove whole formatting elements only when all their content belongs to
      // the block. Partial parents stay intact, including user notes inside them.
      const content = input.projection.text.slice(node.textStart, node.textEnd);
      if (content.trim() === "") {
        return false;
      }
      const first = node.textStart + content.length - content.trimStart().length;
      const last = node.textEnd - (content.length - content.trimEnd().length);

      return first >= start && last <= end;
    });

    return [...characterRanges, ...elementRanges];
  });
}

function compareRangeSortOrder(left: Range, right: Range): number {
  const startDiff = left.start - right.start;
  if (startDiff !== 0) {
    return startDiff;
  }

  return right.end - left.end;
}

function mergeOverlappingRanges(ranges: Range[]): Range[] {
  return [...ranges].sort(compareRangeSortOrder).reduce<Range[]>((acc, range) => {
    const previous = acc.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      return [...acc.slice(0, -1), { start: previous.start, end: Math.max(previous.end, range.end) }];
    }

    return [...acc, { start: range.start, end: range.end }];
  }, []);
}

function applyMergedReplacements(input: { source: string; merged: Range[]; replacement: string }): string {
  const noReplacement = "";

  return input.merged.reduceRight(
    (current, range, index) =>
      current.slice(0, range.start) + (index === 0 ? input.replacement : noReplacement) + current.slice(range.end),
    input.source,
  );
}

function replaceReadyDescriptionBlocksImpl(input: {
  source: string;
  replacement: string;
  isReadyUrl: (url: string) => boolean;
}): string | null {
  const emptyProjectionText = "";
  const projection: Projection = {
    text: emptyProjectionText,
    characters: [] as Range[],
    elements: [] as ElementRange[],
    stack: [] as ElementRange[],
  };
  const append = (appendInput: AppendInput) => {
    projection.text += appendInput.value.replace(/[\u00a0\r]/g, " ");
    projection.characters = [
      ...projection.characters,
      ...Array.from(appendInput.value, (_character, index) =>
        appendInput.isLiteral === true
          ? { start: appendInput.start + index, end: appendInput.start + index + 1 }
          : { start: appendInput.start, end: appendInput.end },
      ),
    ];
  };
  const inAnchor = () => projection.stack.some((node) => node.name === "a");
  const parser = new Parser({
    onopentag(...openTagArgs: [name: string, attributes: Record<string, string>]) {
      const [name, attributes] = openTagArgs;
      if (!inAnchor() && (BLOCK_TAGS.has(name) || name === "br")) {
        append({
          value: "\n",
          start: parser.startIndex,
          end: name === "br" ? parser.endIndex + 1 : parser.startIndex,
        });
      }
      projection.stack = [
        ...projection.stack,
        {
          name,
          start: parser.startIndex,
          end: parser.endIndex + 1,
          textStart: projection.text.length,
          textEnd: projection.text.length,
          href: attributes.href,
        },
      ];
    },
    ontext(value) {
      if (inAnchor()) {
        return;
      }
      append({
        value,
        start: parser.startIndex,
        end: parser.endIndex + 1,
        isLiteral: parser.endIndex + 1 - parser.startIndex === value.length,
      });
    },
    onclosetag(name) {
      const node = projection.stack.at(-1);
      if (node === undefined) {
        return;
      }
      projection.stack = projection.stack.slice(0, -1);
      node.end = parser.endIndex + 1;
      if (name === "a" && !inAnchor()) {
        // Match the destination, not a potentially abbreviated or misleading label.
        append({ value: node.href ?? "", start: node.start, end: node.end });
      }
      node.textEnd = projection.text.length;
      projection.elements = [...projection.elements, node];
      if (!inAnchor() && BLOCK_TAGS.has(name)) {
        append({ value: "\n", start: node.end, end: node.end });
      }
    },
  });
  parser.end(input.source);

  const ranges = collectReadyBlockRanges({ projection, isReadyUrl: input.isReadyUrl });
  if (ranges.length === 0) {
    return null;
  }

  const merged = mergeOverlappingRanges(ranges);

  // Collapse any existing duplicates to one block; preserve bytes outside the
  // recognized content. Keeping partial parent tags prevents malformed HTML.
  return applyMergedReplacements({ source: input.source, merged, replacement: input.replacement });
}

// Project HTML onto visible text, retaining source ranges so an editor's tags,
// links, and entities can be recognized without rewriting the surrounding agenda.
export function replaceReadyDescriptionBlocks(
  ...args: [source: string, replacement: string, isReadyUrl: (url: string) => boolean]
): string | null {
  const [source, replacement, isReadyUrl] = args;

  return replaceReadyDescriptionBlocksImpl({ source, replacement, isReadyUrl });
}
