import type { CalendarEventPrepResponse } from "@readymeet/shared";

type MeetingBriefProgressStatus = CalendarEventPrepResponse["status"] | "loading";

const MAX_LIVE_RESULT_LINE_LENGTH = 96;
const TRUNCATION_ELLIPSIS_LENGTH = 3;
const MIN_RESEARCH_TARGET_LENGTH = 2;
const MIN_RESULT_LABEL_LENGTH = 12;
const SOURCE_LIKE_PATTERN = /(?:https?:\/\/|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b|\/[a-z0-9][a-z0-9-]*)/i;
const TELEMETRY_LINE_PATTERN =
  /^(?:query\s*:|research progress\b|considered \d+\b|read \d+\b|waiting\b|finished\b|research failed\b|research issue\b)/i;

function dedupeLines(lines: readonly string[]) {
  const seen = new Set<string>();

  return lines.flatMap((line) => {
    const text = line.trim();
    if (text === "" || seen.has(text)) {
      return [];
    }
    seen.add(text);

    return [text];
  });
}

function truncateLiveResultLine(line: string) {
  const text = line.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_LIVE_RESULT_LINE_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_LIVE_RESULT_LINE_LENGTH - TRUNCATION_ELLIPSIS_LENGTH).trimEnd()}...`;
}

type LiveResultParseOutcome = string | null | false;

function liveResultLineFromSourceCounts(text: string): LiveResultParseOutcome {
  const consideredAndReadMatch = /^considered\s+(\d+)\s+sources?\s+and\s+read\s+(\d+)/i.exec(text);
  if (consideredAndReadMatch !== null) {
    const readCount = consideredAndReadMatch[2] ?? "";
    const consideredCount = consideredAndReadMatch[1] ?? "";

    return `Read ${readCount} of ${consideredCount} sources`;
  }

  const consideredMatch = /^considered\s+(\d+)\s+sources?/i.exec(text);
  if (consideredMatch !== null) {
    const consideredCount = consideredMatch[1] ?? "";

    return `${consideredCount} sources considered`;
  }

  const readSourcesMatch = /^read\s+(\d+)\s+sources?/i.exec(text);
  if (readSourcesMatch !== null) {
    const readCount = readSourcesMatch[1] ?? "";

    return `Read ${readCount} sources`;
  }

  return false;
}

function liveResultLineFromSourceAction(text: string): LiveResultParseOutcome {
  const sourceActionMatch = /^(reading|checking|reviewing|scanning)\s+(.+)$/i.exec(text);
  if (sourceActionMatch === null) {
    return false;
  }

  const action = sourceActionMatch[1]?.trim().toLowerCase() ?? "";
  const source = sourceActionMatch[2]?.trim() ?? "";
  const label = action !== "" ? `${action.charAt(0).toUpperCase()}${action.slice(1)}` : "Checking";

  return source !== "" && SOURCE_LIKE_PATTERN.test(source) ? truncateLiveResultLine(`${label} ${source}`) : null;
}

function liveResultLineFromResearching(text: string): LiveResultParseOutcome {
  const researchingMatch = /^researching\s+(.+)$/i.exec(text);
  if (researchingMatch === null) {
    return false;
  }

  const target = researchingMatch[1]?.replace(/:\s*\d+%$/, "").trim() ?? "";

  return target !== "" && target.length > MIN_RESEARCH_TARGET_LENGTH && !SOURCE_LIKE_PATTERN.test(target)
    ? truncateLiveResultLine(`Researching ${target}`)
    : null;
}

function liveResultLineFromFound(text: string): LiveResultParseOutcome {
  const foundMatch = /^(?:found|selected|matched)\s+(.+)$/i.exec(text);
  if (foundMatch === null) {
    return false;
  }

  const result = foundMatch[1]?.trim() ?? "";

  return result !== "" && result.length > MIN_RESULT_LABEL_LENGTH ? truncateLiveResultLine(`Found ${result}`) : null;
}

function liveResultLineFromRawMessage(message: string) {
  const text = message.trim();
  if (text === "") {
    return null;
  }

  const fromSourceCounts = liveResultLineFromSourceCounts(text);
  if (fromSourceCounts !== false) {
    return fromSourceCounts;
  }

  if (TELEMETRY_LINE_PATTERN.test(text)) {
    return null;
  }

  const fromSourceAction = liveResultLineFromSourceAction(text);
  if (fromSourceAction !== false) {
    return fromSourceAction;
  }

  const fromResearching = liveResultLineFromResearching(text);
  if (fromResearching !== false) {
    return fromResearching;
  }

  const fromFound = liveResultLineFromFound(text);
  if (fromFound !== false) {
    return fromFound;
  }

  return null;
}

function progressLineFromRawMessage(message: string) {
  const text = message.trim();
  if (text === "") {
    return null;
  }

  const normalized = text.toLowerCase();
  if (/^query\s*:/.test(normalized)) {
    return "Searching public sources";
  }
  if (/%/.test(text) || /\b\d+\s*\/\s*\d+\b/.test(text)) {
    if (/\bcompan(y|ies)\b/.test(normalized)) {
      return "Checking company context";
    }
    if (/\bpeople\b|\bperson\b|\bprofile\b|\blinkedin\b|\bparticipant/.test(normalized)) {
      return "Researching people in the meeting";
    }

    return "Looking through public sources";
  }
  if (/\bplan(ned|ning)?\b|\bprepar/.test(normalized)) {
    return "Planning the research";
  }
  if (/\bsearch|\bsource|\bweb\b|\bpublic\b|\bquery\b/.test(normalized)) {
    return "Searching public sources";
  }
  if (/\bread|\bopen|\bfetch|\bpage|\barticle|\bnews|\bresult/.test(normalized)) {
    return "Reading useful sources";
  }
  if (/\bcompan(y|ies)\b|\bdomain\b|\bwebsite\b|\bcustomer\b/.test(normalized)) {
    return "Checking company context";
  }
  if (/\bpeople\b|\bperson\b|\bprofile\b|\blinkedin\b|\bparticipant\b|\battendee\b/.test(normalized)) {
    return "Researching people in the meeting";
  }
  if (/\bbrief\b|\bsummar|\bdraft|\bwrite/.test(normalized)) {
    return "Drafting the brief";
  }

  return "Looking through public sources";
}

function displayLinesFromMessages(messages: readonly string[]) {
  const liveResults = dedupeLines(
    messages.flatMap((message) => {
      const line = liveResultLineFromRawMessage(message);

      return line !== null ? [line] : [];
    }),
  );
  if (liveResults.length !== 0) {
    return liveResults;
  }

  return dedupeLines(
    messages.flatMap((message) => {
      const line = progressLineFromRawMessage(message);

      return line !== null ? [line] : [];
    }),
  );
}

export function getMeetingBriefProgressDisplay(input: {
  peopleMessages?: readonly string[] | null;
  companyMessages?: readonly string[] | null;
  fallbackMessages?: readonly (string | null | undefined)[] | null;
  prepStatus: MeetingBriefProgressStatus;
}): {
  lines: { text: string; kind: "progress" | "generic" }[];
  mode: "ticker" | "static";
} {
  const rawMessages = displayLinesFromMessages([...(input.peopleMessages ?? []), ...(input.companyMessages ?? [])]);
  if (rawMessages.length !== 0) {
    return {
      lines: rawMessages.map((text) => ({ text, kind: "progress" as const })),
      mode: rawMessages.length > 1 ? ("ticker" as const) : ("static" as const),
    };
  }

  const fallbackMessages = dedupeLines(
    (input.fallbackMessages ?? []).flatMap((message) =>
      message !== null && message !== undefined && message !== "" ? [message] : [],
    ),
  );
  const fallbackLines = displayLinesFromMessages(fallbackMessages);
  if (fallbackLines.length !== 0) {
    return {
      lines: fallbackLines.map((text) => ({ text, kind: "progress" as const })),
      mode: fallbackLines.length > 1 ? ("ticker" as const) : ("static" as const),
    };
  }

  return {
    lines: [
      {
        text: input.prepStatus === "running" ? "Looking through public sources" : "Planning the research",
        kind: "generic" as const,
      },
    ],
    mode: "static" as const,
  };
}
