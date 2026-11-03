/** Model recorded on placeholder notes saved when real notes could not be generated. */
export const FALLBACK_SUMMARY_MODEL = "fallback-summary-v1";
const MAX_MEETING_NOTES_PREVIEW_LINES = 4;
const MAX_MEETING_NOTES_PREVIEW_CHARACTERS = 600;
const PREVIEW_TRUNCATION_END_INDEX = MAX_MEETING_NOTES_PREVIEW_CHARACTERS - 1;

// Keep supporting summaries saved before the heading was renamed to Tasks.
const SUMMARY_TASK_HEADING_PATTERN = /^\s*(?:Tasks|Action items)[ \t]*(?:\n|$)/i;
const SUMMARY_LIST_ITEM_PATTERN = /^\s*(?:[-*•]|\d+[.)])\s+/;

type SummaryTaskSectionScan = { keptBlocks: readonly string[]; isInTaskSection: boolean };

function isSummaryListOnlyBlock(block: string): boolean {
  return block.split("\n").every((line) => line.trim().length === 0 || SUMMARY_LIST_ITEM_PATTERN.test(line));
}

/**
 * Remove the task section when tasks are rendered separately from meeting notes. Summaries are
 * blank-line separated sections, so only the task heading block (and list-only blocks continuing it)
 * is dropped; notes before or after it stay visible.
 */
export function stripSummaryTaskSection(content: string): string {
  const { keptBlocks } = content
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .reduce<SummaryTaskSectionScan>(
      (scan, block) => {
        if (SUMMARY_TASK_HEADING_PATTERN.test(block)) {
          return { ...scan, isInTaskSection: true };
        }

        if (scan.isInTaskSection && isSummaryListOnlyBlock(block)) {
          return scan;
        }

        return { keptBlocks: [...scan.keptBlocks, block], isInTaskSection: false };
      },
      { keptBlocks: [], isInTaskSection: false },
    );

  return keptBlocks
    .filter((block) => block.trim().length > 0)
    .join("\n\n")
    .trim();
}

/** A small, non-interactive teaser; never send the full locked summary. */
export function buildMeetingNotesPreview(content: string): string {
  const lines = stripSummaryTaskSection(content)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const excerpt = lines.slice(0, MAX_MEETING_NOTES_PREVIEW_LINES).join("\n");
  if (excerpt.length <= MAX_MEETING_NOTES_PREVIEW_CHARACTERS) {
    return excerpt;
  }

  return `${excerpt
    .slice(0, PREVIEW_TRUNCATION_END_INDEX)
    .replace(/\s+\S*$/, "")
    .trimEnd()}…`;
}
