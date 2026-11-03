import { SLACK_MEETING_CATEGORIES } from "@readymeet/shared";
import { createHash } from "node:crypto";

const SLACK_SECTION_TEXT_LIMIT = 2900;
const SLACK_HEADER_TITLE_MAX = 150;
const SLACK_MAX_BLOCKS = 50;
const SECTION_BOUNDARY_HALF_DIVISOR = 2;
const SLACK_CLIENT_MSG_ID_BYTE_LENGTH = 16;
const SLACK_CLIENT_MSG_ID_VERSION_BYTE_INDEX = 6;
const SLACK_CLIENT_MSG_ID_VARIANT_BYTE_INDEX = 8;
const SLACK_CLIENT_MSG_ID_VERSION_MASK = 0x0f;
const SLACK_CLIENT_MSG_ID_VERSION_NIBBLE = 0x40;
const SLACK_CLIENT_MSG_ID_VARIANT_MASK = 0x3f;
const SLACK_CLIENT_MSG_ID_VARIANT_NIBBLE = 0x80;
const SLACK_CLIENT_MSG_ID_SEGMENT_ONE_END = 8;
const SLACK_CLIENT_MSG_ID_SEGMENT_TWO_END = 12;
const SLACK_CLIENT_MSG_ID_SEGMENT_THREE_END = 16;
const SLACK_CLIENT_MSG_ID_SEGMENT_FOUR_END = 20;

const SLACK_MESSAGE_SIZE_LIMIT_MESSAGE = "These notes exceed Slack’s message size limit. Nothing was sent.";
const SLACK_CONTEXT_POSTED_BY_READY_PREFIX = "Posted by Ready · ";

function categoryLabel(key: string) {
  return SLACK_MEETING_CATEGORIES.find((category) => category.key === key)?.label ?? key;
}

/** Best-effort markdown -> Slack mrkdwn: bold markers and headings differ. */
function toSlackMrkdwn(content: string): string {
  return content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

function slackSectionEnd(remaining: string) {
  const limit = Math.min(remaining.length, SLACK_SECTION_TEXT_LIMIT);
  if (limit >= remaining.length) {
    return limit;
  }
  const boundary = remaining.lastIndexOf("\n", limit);
  if (boundary > limit / SECTION_BOUNDARY_HALF_DIVISOR) {
    return boundary + 1;
  }

  return limit;
}

function slackSectionChunks(remaining: string): string[] {
  if (remaining.length === 0) {
    return [];
  }
  const end = slackSectionEnd(remaining);

  return [remaining.slice(0, end), ...slackSectionChunks(remaining.slice(end))];
}

function sectionBlocks(text: string) {
  return slackSectionChunks(text).map((chunk) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: chunk,
      /** @external Slack mrkdwn section verbatim flag */
      verbatim: true,
    },
  }));
}

function formatTaskLine(task: { title: string; assigneeName: string | null }) {
  const assigneeSuffix =
    task.assigneeName !== null && task.assigneeName !== "" ? ` — ${toSlackMrkdwn(task.assigneeName)}` : "";

  return `• ${toSlackMrkdwn(task.title)}${assigneeSuffix}`;
}

function buildMessageBlocks(input: {
  title: string;
  categoryKey: string;
  summaryContent: string;
  tasks: { title: string; assigneeName: string | null }[];
}): (
  | {
      type: string;
      text: {
        type: string;
        text: string;
        /** @external Slack plain_text header emoji flag */
        emoji: boolean;
      };
    }
  | {
      type: string;
      text: {
        type: string;
        text: string;
        /** @external Slack mrkdwn section verbatim flag */
        verbatim: boolean;
      };
    }
  | { type: string; elements: { type: string; text: string }[] }
)[] {
  const headerBlock = {
    type: "header",
    text: {
      type: "plain_text",
      text: input.title.slice(0, SLACK_HEADER_TITLE_MAX),
      /** @external Slack plain_text header emoji flag */
      emoji: true,
    },
  };
  const summaryBlocks = sectionBlocks(toSlackMrkdwn(input.summaryContent));
  const taskBlocks =
    input.tasks.length === 0 ? [] : sectionBlocks(`*Tasks*\n${input.tasks.map(formatTaskLine).join("\n")}`);
  const slackContextPostedByReadyText = `${SLACK_CONTEXT_POSTED_BY_READY_PREFIX}${categoryLabel(input.categoryKey)}`;
  const contextBlock = {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: slackContextPostedByReadyText,
      },
    ],
  };
  const blocks = [...[headerBlock], ...summaryBlocks, ...taskBlocks, contextBlock];

  if (blocks.length > SLACK_MAX_BLOCKS) {
    throw new Error(SLACK_MESSAGE_SIZE_LIMIT_MESSAGE);
  }

  return blocks;
}

function createDeterministicSlackClientMsgId(input: { meetingId: string; channelId: string }): string {
  const bytes = createHash("sha256")
    .update(`ready-slack-delivery:${input.meetingId}:${input.channelId}`)
    .digest()
    .subarray(0, SLACK_CLIENT_MSG_ID_BYTE_LENGTH);
  const versionNibble = bytes[SLACK_CLIENT_MSG_ID_VERSION_BYTE_INDEX];
  const variantNibble = bytes[SLACK_CLIENT_MSG_ID_VARIANT_BYTE_INDEX];
  if (versionNibble === undefined || variantNibble === undefined) {
    throw new TypeError(String(bytes.length));
  }
  bytes[SLACK_CLIENT_MSG_ID_VERSION_BYTE_INDEX] =
    (versionNibble & SLACK_CLIENT_MSG_ID_VERSION_MASK) | SLACK_CLIENT_MSG_ID_VERSION_NIBBLE;
  bytes[SLACK_CLIENT_MSG_ID_VARIANT_BYTE_INDEX] =
    (variantNibble & SLACK_CLIENT_MSG_ID_VARIANT_MASK) | SLACK_CLIENT_MSG_ID_VARIANT_NIBBLE;
  const text = bytes.toString("hex");

  return `${text.slice(0, SLACK_CLIENT_MSG_ID_SEGMENT_ONE_END)}-${text.slice(
    SLACK_CLIENT_MSG_ID_SEGMENT_ONE_END,
    SLACK_CLIENT_MSG_ID_SEGMENT_TWO_END,
  )}-${text.slice(SLACK_CLIENT_MSG_ID_SEGMENT_TWO_END, SLACK_CLIENT_MSG_ID_SEGMENT_THREE_END)}-${text.slice(
    SLACK_CLIENT_MSG_ID_SEGMENT_THREE_END,
    SLACK_CLIENT_MSG_ID_SEGMENT_FOUR_END,
  )}-${text.slice(SLACK_CLIENT_MSG_ID_SEGMENT_FOUR_END)}`;
}

export { buildMessageBlocks, createDeterministicSlackClientMsgId, toSlackMrkdwn };
