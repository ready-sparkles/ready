import type { MeetingTask } from "@readymeet/shared";

type CopyableMeetingTask = Pick<MeetingTask, "title" | "description" | "status">;

type MeetingCopyContent = {
  title: string;
  dateTime: string;
  participants: string[];
  summary: string;
  tasks: CopyableMeetingTask[];
};

const SUMMARY_TOPICS_LABEL = "topics";
const NO_TASKS_COPY = "No tasks.";
const CLIPBOARD_HTML_FONT_FAMILY = "Arial, Helvetica, sans-serif";
const CLIPBOARD_HTML_TEXT_COLOR = "#111820";
const CLIPBOARD_HTML_LINE_HEIGHT = 1.45;
const CLIPBOARD_TITLE_FONT_SIZE_PX = 18;
const CLIPBOARD_SECTION_FONT_SIZE_PX = 16;
const CLIPBOARD_SECTION_MARGIN_TOP_PX = 18;
const CLIPBOARD_SECTION_MARGIN_BOTTOM_PX = 8;
const BULLET_LIST_PADDING_LEFT_PX = 20;
const BULLET_ITEM_PADDING_LEFT_PX = 3;
const BULLET_ITEM_MARGIN_BOTTOM_PX = 5;
const TASK_DESCRIPTION_MARGIN_TOP_PX = 2;
const SUMMARY_HEADING_MARGIN_TOP_PX = 12;
const SUMMARY_HEADING_MARGIN_BOTTOM_PX = 5;

export function getMeetingCopyParticipantNames(participants: readonly { displayName: string }[]): string[] {
  return Array.from(
    new Set(
      participants
        .map((participant) => participant.displayName.trim())
        .filter((displayName) => displayName.length !== 0),
    ),
  );
}

function isSummaryBullet(line: string): boolean {
  return /^[-*•]\s+/.test(line.trim()) || /^\d+\.\s+/.test(line.trim());
}

function cleanSummaryLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\s*\((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[-–]\s*(?:\d{1,2}:)?\d{1,2}:\d{2})?\)/g, "")
    .trim();
}

function getSummaryLines(summary: string): { isBullet: boolean; text: string }[] {
  return summary
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => ({
      isBullet: isSummaryBullet(line),
      text: cleanSummaryLine(line),
    }))
    .filter(({ text }) => text.length !== 0 && text.toLowerCase() !== SUMMARY_TOPICS_LABEL);
}

function formatSummaryText(lines: ReturnType<typeof getSummaryLines>): string {
  const formatted = lines.reduce<string[]>((accumulated, line) => {
    const withSpacer =
      !line.isBullet && accumulated.length !== 0 && accumulated.at(-1) !== "" ? [...accumulated, ""] : accumulated;

    return [...withSpacer, line.isBullet ? `• ${line.text}` : line.text];
  }, []);

  return formatted.join("\n");
}

function formatTaskText(task: CopyableMeetingTask): string {
  const description = task.description?.trim();
  const lines =
    description !== undefined && description.length !== 0
      ? [`• ${task.title.trim()}`, `  ${description}`]
      : [`• ${task.title.trim()}`];

  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const BULLET_LIST_STYLE = `margin: 0; padding-left: ${BULLET_LIST_PADDING_LEFT_PX}px;`;
const BULLET_ITEM_STYLE = `padding-left: ${BULLET_ITEM_PADDING_LEFT_PX}px; margin: 0 0 ${BULLET_ITEM_MARGIN_BOTTOM_PX}px 0;`;

type SummaryHtmlState = { fragments: string[]; isListOpen: boolean };

function formatSummaryHtml(lines: ReturnType<typeof getSummaryLines>): string {
  const reduced = lines.reduce<SummaryHtmlState>(
    (state, line) => {
      if (line.isBullet) {
        const withOpenList = state.isListOpen
          ? state
          : {
              fragments: [...state.fragments, `<ul style="${BULLET_LIST_STYLE}">`],
              isListOpen: true,
            };

        return {
          fragments: [...withOpenList.fragments, `<li style="${BULLET_ITEM_STYLE}">${escapeHtml(line.text)}</li>`],
          isListOpen: true,
        };
      }

      const afterListClose = state.isListOpen ? { fragments: [...state.fragments, "</ul>"], isListOpen: false } : state;

      return {
        fragments: [
          ...afterListClose.fragments,
          `<div style="font-weight: 700; margin: ${afterListClose.fragments.length !== 0 ? `${SUMMARY_HEADING_MARGIN_TOP_PX}px` : "0"} 0 ${SUMMARY_HEADING_MARGIN_BOTTOM_PX}px 0;">${escapeHtml(line.text)}</div>`,
        ],
        isListOpen: false,
      };
    },
    { fragments: [], isListOpen: false },
  );

  const fragments = reduced.isListOpen ? [...reduced.fragments, "</ul>"] : reduced.fragments;

  return fragments.join("");
}

function formatTaskHtml(task: CopyableMeetingTask): string {
  const description = task.description?.trim();
  const descriptionHtml =
    description !== undefined && description.length !== 0
      ? `<div style="font-weight: 400; margin-top: ${TASK_DESCRIPTION_MARGIN_TOP_PX}px;">${escapeHtml(description)}</div>`
      : "";

  return [
    `<li style="${BULLET_ITEM_STYLE}">`,
    `<strong>${escapeHtml(task.title.trim())}</strong>`,
    descriptionHtml,
    "</li>",
  ].join("");
}

export function formatMeetingSummaryAndTasksForClipboard(input: MeetingCopyContent): { text: string; html: string } {
  const summaryLines = getSummaryLines(input.summary);
  const header = [
    input.title.trim(),
    input.dateTime.trim(),
    input.participants.length !== 0
      ? `Participants: ${input.participants
          .map((participant) => participant.trim())
          .filter((participant) => participant.length !== 0)
          .join(", ")}`
      : null,
  ].filter((line): line is string => line !== null && line.length !== 0);
  const activeTasks = input.tasks.filter((task) => task.status !== "dismissed");
  const formattedTaskText = activeTasks.length !== 0 ? activeTasks.map(formatTaskText).join("\n\n") : NO_TASKS_COPY;
  const text = [header.join("\n"), "Summary", formatSummaryText(summaryLines), "Tasks", formattedTaskText]
    .filter((section) => section.length !== 0)
    .join("\n\n");
  const participantLine = input.participants
    .map((participant) => participant.trim())
    .filter((participant) => participant.length !== 0)
    .join(", ");
  const formattedTaskHtml =
    activeTasks.length !== 0
      ? `<ul style="${BULLET_LIST_STYLE}">${activeTasks.map(formatTaskHtml).join("")}</ul>`
      : `<div>${NO_TASKS_COPY}</div>`;
  const html = [
    `<div style="font-family: ${CLIPBOARD_HTML_FONT_FAMILY}; color: ${CLIPBOARD_HTML_TEXT_COLOR}; line-height: ${CLIPBOARD_HTML_LINE_HEIGHT};">`,
    `<div style="font-size: ${CLIPBOARD_TITLE_FONT_SIZE_PX}px; font-weight: 700;">${escapeHtml(input.title.trim())}</div>`,
    `<div>${escapeHtml(input.dateTime.trim())}</div>`,
    participantLine.length !== 0 ? `<div>Participants: ${escapeHtml(participantLine)}</div>` : "",
    `<div style="font-size: ${CLIPBOARD_SECTION_FONT_SIZE_PX}px; font-weight: 700; margin: ${CLIPBOARD_SECTION_MARGIN_TOP_PX}px 0 ${CLIPBOARD_SECTION_MARGIN_BOTTOM_PX}px 0;">Summary</div>`,
    formatSummaryHtml(summaryLines),
    `<div style="font-size: ${CLIPBOARD_SECTION_FONT_SIZE_PX}px; font-weight: 700; margin: ${CLIPBOARD_SECTION_MARGIN_TOP_PX}px 0 ${CLIPBOARD_SECTION_MARGIN_BOTTOM_PX}px 0;">Tasks</div>`,
    formattedTaskHtml,
    "</div>",
  ].join("");

  return { text, html };
}
