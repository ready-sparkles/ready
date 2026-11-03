"use client";

import { useEffect, useMemo, useRef, useState } from "react";

function isSummaryBullet(line: string) {
  return /^[-*•]\s+/.test(line.trim()) || /^\d+\.\s+/.test(line.trim());
}

function cleanSummaryLine(line: string) {
  return line
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\s*\((?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[-–]\s*(?:\d{1,2}:)?\d{1,2}:\d{2})?\)/g, "");
}

const NOTE_REVEAL_INITIAL_DELAY_MS = 900;
const NOTE_REVEAL_CHAR_ANIMATION_MS = 160;
const NOTE_REVEAL_LINE_GAP_MS = 60;
const NOTE_REVEAL_HEADING_CHAR_DELAY_MS = 4.5;
const NOTE_REVEAL_BULLET_CHAR_DELAY_MS = 3.5;

type SummaryLineKind = "bullet" | "heading" | "paragraph";

type SummaryRow = { kind: SummaryLineKind; text: string };

const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+/;
/** A single full stop (not an ellipsis), optionally followed by closing quotes or brackets. */
const DECLARATIVE_SENTENCE_END_PATTERN = /[^.]\.["'”’)\]]*$/;

/**
 * Generated notes are sections: a title line followed by the lines it introduces. A line is a heading
 * when it opens such a section; a line with nothing after it, or a declarative sentence leading into
 * bullets, is body text.
 */
function getSummaryLineKind(input: { line: string; hasFollowingLine: boolean }): SummaryLineKind {
  const { line, hasFollowingLine } = input;

  if (isSummaryBullet(line)) {
    return "bullet";
  }

  if (MARKDOWN_HEADING_PATTERN.test(line)) {
    return "heading";
  }

  return hasFollowingLine && !DECLARATIVE_SENTENCE_END_PATTERN.test(cleanSummaryLine(line)) ? "heading" : "paragraph";
}

function toSummaryRows(lines: string[]): SummaryRow[] {
  return lines.map((line, index) => ({
    kind: getSummaryLineKind({ line, hasFollowingLine: index < lines.length - 1 }),
    text: cleanSummaryLine(line).replace(MARKDOWN_HEADING_PATTERN, ""),
  }));
}

function getSummaryRowCharDelayMs(row: SummaryRow) {
  return row.kind === "heading" ? NOTE_REVEAL_HEADING_CHAR_DELAY_MS : NOTE_REVEAL_BULLET_CHAR_DELAY_MS;
}

export function getWorkspaceTextRevealDuration(input: { text: string; charDelayMs: number }): number {
  const { text, charDelayMs } = input;

  return (
    Math.max(1, Array.from(text).filter((character) => !/\s/.test(character)).length) * charDelayMs +
    NOTE_REVEAL_CHAR_ANIMATION_MS +
    NOTE_REVEAL_LINE_GAP_MS
  );
}

function getRevealRows(input: { summary: string; shouldOmitLeadingHeading: boolean }): SummaryRow[] {
  const { summary, shouldOmitLeadingHeading } = input;
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => cleanSummaryLine(line).toLowerCase() !== "topics");
  const firstLine = lines[0];

  return toSummaryRows(
    shouldOmitLeadingHeading && firstLine !== undefined && isRedundantSummaryHeading(firstLine)
      ? lines.slice(1)
      : lines,
  );
}

function isRedundantSummaryHeading(line: string) {
  if (isSummaryBullet(line)) {
    return false;
  }

  const label = cleanSummaryLine(line)
    .replace(MARKDOWN_HEADING_PATTERN, "")
    .replace(/:$/, "")
    .replace(/^(\*\*|__)(.+)\1$/, "$2")
    .replace(/:$/, "")
    .trim();

  return /^(?:overview|general summary|summary)$/i.test(label);
}

function buildLineRevealTimings(input: { rows: SummaryRow[]; charDelayScale: number; initialDelayMs: number }): {
  nextDelayMs: number;
  timings: { delayMs: number; durationMs: number }[];
} {
  const { rows, charDelayScale, initialDelayMs } = input;

  return rows.reduce<{ nextDelayMs: number; timings: { delayMs: number; durationMs: number }[] }>(
    (state, row) => {
      const lineDurationMs = getWorkspaceTextRevealDuration({
        text: row.text,
        charDelayMs: getSummaryRowCharDelayMs(row) * charDelayScale,
      });

      return {
        nextDelayMs: state.nextDelayMs + lineDurationMs,
        timings: [...state.timings, { delayMs: state.nextDelayMs, durationMs: lineDurationMs }],
      };
    },
    { nextDelayMs: initialDelayMs, timings: [] },
  );
}

function WorkspaceGeneratedNoteRow({
  row,
  shouldReveal,
  charDelayScale,
}: {
  row: SummaryRow;
  shouldReveal: boolean;
  charDelayScale: number;
}) {
  const { kind, text: cleanedLine } = row;

  if (cleanedLine.toLowerCase() === "topics") {
    return null;
  }

  const text = shouldReveal ? (
    <AnimatedWorkspaceText
      text={cleanedLine}
      delayMs={0}
      charDelayMs={getSummaryRowCharDelayMs(row) * charDelayScale}
    />
  ) : (
    cleanedLine
  );

  if (kind === "heading") {
    return <h3 className="workspace-flow-snapshot-note-heading">{text}</h3>;
  }

  return (
    <p
      className={`workspace-flow-snapshot-note-line${kind === "paragraph" ? " workspace-flow-snapshot-note-paragraph" : ""}`}
    >
      {kind === "bullet" ? <span aria-hidden="true" className="workspace-flow-summary-bullet" /> : null}
      {text}
    </p>
  );
}

const DEFAULT_WORKSPACE_TEXT_CHAR_DELAY_MS = 14;

export function AnimatedWorkspaceText({
  text,
  className,
  delayMs = 0,
  charDelayMs = DEFAULT_WORKSPACE_TEXT_CHAR_DELAY_MS,
}: {
  text: string;
  className?: string;
  delayMs?: number;
  charDelayMs?: number;
}) {
  const tokens = text.split(/(\s+)/);
  const tokenStartIndexes = tokens.reduce<{ nextIndex: number; starts: number[] }>(
    (state, token) => {
      const starts = [...state.starts, state.nextIndex];
      if (token === "" || /^\s+$/.test(token)) {
        return { nextIndex: state.nextIndex, starts };
      }

      return { nextIndex: state.nextIndex + Array.from(token).length, starts };
    },
    { nextIndex: 0, starts: [] },
  ).starts;

  return (
    <span
      className={`workspace-flow-animated-text live-transcript-line-animated${className !== undefined && className !== "" ? ` ${className}` : ""}`}
      aria-label={text}
    >
      <span aria-hidden="true">
        {tokens.map((token, tokenIndex) => {
          if (token === "") {
            return null;
          }

          if (/^\s+$/.test(token)) {
            return <span key={`space-${tokenIndex}`}>{token}</span>;
          }

          return (
            <span key={`word-${tokenIndex}`} className="live-transcript-word">
              {Array.from(token).map((character, characterIndex) => {
                const animationDelay = delayMs + ((tokenStartIndexes[tokenIndex] ?? 0) + characterIndex) * charDelayMs;

                return (
                  <span
                    key={`${tokenIndex}-${characterIndex}-${character}`}
                    className="live-transcript-char workspace-flow-live-char"
                    style={{ animationDelay: `${animationDelay}ms` }}
                  >
                    {character}
                  </span>
                );
              })}
            </span>
          );
        })}
      </span>
    </span>
  );
}

export function WorkspaceGeneratedNotes({
  summary,
  mode = "reveal",
  charDelayScale = 1,
  initialDelayMs = NOTE_REVEAL_INITIAL_DELAY_MS,
  onRowReveal,
  onRevealComplete,
  ...rest
}: {
  summary: string;
  mode?: "reveal" | "static";
  charDelayScale?: number;
  initialDelayMs?: number;
  /** @external existing workspace notes prop contract */
  omitLeadingHeading?: boolean;
  onRowReveal?: () => void;
  onRevealComplete?: () => void;
}) {
  const shouldOmitLeadingHeading = rest.omitLeadingHeading ?? false;
  const [hasRevealed, setHasRevealed] = useState(false);
  const shouldReveal = mode === "reveal" && !hasRevealed;
  const rows = useMemo(() => getRevealRows({ summary, shouldOmitLeadingHeading }), [shouldOmitLeadingHeading, summary]);
  const { nextDelayMs: revealDurationMs, timings: revealTimings } = useMemo(
    () => buildLineRevealTimings({ rows, charDelayScale, initialDelayMs }),
    [charDelayScale, initialDelayMs, rows],
  );
  const [visibleLineCount, setVisibleLineCount] = useState(shouldReveal ? 0 : rows.length);
  const onRowRevealRef = useRef(onRowReveal);
  const onRevealCompleteRef = useRef(onRevealComplete);

  useEffect(() => {
    onRowRevealRef.current = onRowReveal;
    onRevealCompleteRef.current = onRevealComplete;
  }, [onRevealComplete, onRowReveal]);

  useEffect(() => {
    setVisibleLineCount(shouldReveal ? 0 : rows.length);
  }, [rows, shouldReveal]);

  useEffect(() => {
    if (!shouldReveal) {
      setVisibleLineCount(rows.length);
      if (!hasRevealed) {
        onRevealCompleteRef.current?.();
      }

      return;
    }

    if (rows.length === 0) {
      setVisibleLineCount(0);
      onRevealCompleteRef.current?.();

      return;
    }

    const timeoutIds = rows.map((_row, index) =>
      window.setTimeout(() => {
        setVisibleLineCount((current) => Math.max(current, index + 1));
        window.requestAnimationFrame(() => onRowRevealRef.current?.());
      }, revealTimings[index]?.delayMs ?? 0),
    );
    const completionTimeoutId = window.setTimeout(() => {
      setHasRevealed(true);
      onRevealCompleteRef.current?.();
    }, revealDurationMs);

    return () => {
      timeoutIds.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      window.clearTimeout(completionTimeoutId);
    };
  }, [hasRevealed, rows, revealDurationMs, revealTimings, shouldReveal]);

  return (
    <div className={`workspace-flow-snapshot-notes${shouldReveal ? "" : " is-static"}`} aria-live="polite">
      {(shouldReveal ? rows.slice(0, visibleLineCount) : rows).map((row, index) => (
        <WorkspaceGeneratedNoteRow
          key={`${index}-${row.text}`}
          row={row}
          shouldReveal={shouldReveal}
          charDelayScale={charDelayScale}
        />
      ))}
    </div>
  );
}
