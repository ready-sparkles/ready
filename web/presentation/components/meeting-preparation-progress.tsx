"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";

import { fallbackMeetingPreparationLines } from "../../composition/meeting-preparation";

const MEETING_PREPARATION_DELAY_MS_0 = 4_000;
const MEETING_PREPARATION_DELAY_MS_1 = 4_500;
const MEETING_PREPARATION_DELAY_MS_2 = 5_000;
const MEETING_PREPARATION_DELAY_MS_3 = 5_500;
const MEETING_PREPARATION_DELAY_MS_4 = 6_000;
const MEETING_PREPARATION_DELAY_MS_5 = 7_000;
const MEETING_PREPARATION_DELAY_MS_6 = 8_000;
const MEETING_PREPARATION_DELAY_MS_7 = 9_000;
const MEETING_PREPARATION_DELAY_MS_8 = 11_000;
const MEETING_PREPARATION_DELAY_MS_9 = 12_000;
const MEETING_PREPARATION_DELAY_MS_10 = 14_000;
const MEETING_PREPARATION_MAX_DECK_LINES = 12;
const MEETING_PREPARATION_LINE_ANIMATION_MS = 240;

export const MEETING_PREPARATION_LINE_DELAYS_MS = [
  MEETING_PREPARATION_DELAY_MS_0,
  MEETING_PREPARATION_DELAY_MS_1,
  MEETING_PREPARATION_DELAY_MS_2,
  MEETING_PREPARATION_DELAY_MS_3,
  MEETING_PREPARATION_DELAY_MS_4,
  MEETING_PREPARATION_DELAY_MS_5,
  MEETING_PREPARATION_DELAY_MS_6,
  MEETING_PREPARATION_DELAY_MS_7,
  MEETING_PREPARATION_DELAY_MS_8,
  MEETING_PREPARATION_DELAY_MS_9,
  MEETING_PREPARATION_DELAY_MS_10,
] as const;

export function getNextMeetingPreparationLineIndex(input: { currentIndex: number; lineCount: number }): number | null {
  return input.currentIndex < input.lineCount - 1 ? input.currentIndex + 1 : null;
}

function normalizeDeck(lines: string[]) {
  const normalized = Array.from(new Set(lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean)));

  return normalized.length !== 0
    ? normalized.slice(0, MEETING_PREPARATION_MAX_DECK_LINES)
    : fallbackMeetingPreparationLines();
}

export function MeetingPreparationProgress({ lines }: { lines: string[] }) {
  const deck = useMemo(() => normalizeDeck(lines), [lines]);
  const deckKey = deck.join("\u0000");
  const [activeIndex, setActiveIndex] = useState(0);
  const [previousLine, setPreviousLine] = useState<string | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    setActiveIndex(0);
    setPreviousLine(null);
    setIsAnimating(false);
  }, [deckKey]);

  useEffect(() => {
    const nextIndex = getNextMeetingPreparationLineIndex({ currentIndex: activeIndex, lineCount: deck.length });
    if (nextIndex === null) {
      return;
    }

    const timeoutId = window.setTimeout(
      () => {
        setPreviousLine(deck[activeIndex] ?? null);
        setIsAnimating(false);
        setActiveIndex(nextIndex);
      },
      MEETING_PREPARATION_LINE_DELAYS_MS[Math.min(activeIndex, MEETING_PREPARATION_LINE_DELAYS_MS.length - 1)],
    );

    return () => window.clearTimeout(timeoutId);
  }, [activeIndex, deck]);

  useLayoutEffect(() => {
    if (previousLine === null) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      setIsAnimating(true);
    });
    const timeoutId = window.setTimeout(() => {
      setPreviousLine(null);
      setIsAnimating(false);
    }, MEETING_PREPARATION_LINE_ANIMATION_MS);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [activeIndex, previousLine]);

  const activeLine = deck[activeIndex] ?? deck[0];

  return (
    <span className="workspace-meeting-preparation-copy" aria-label={activeLine}>
      {previousLine !== null ? (
        <span
          className={`workspace-meeting-preparation-line is-previous${isAnimating ? " is-animating" : ""}`}
          aria-hidden="true"
        >
          {previousLine}
        </span>
      ) : null}
      <span
        className={`workspace-meeting-preparation-line is-current${previousLine !== null ? "" : " is-settled"}${isAnimating ? " is-animating" : ""}`}
        aria-hidden="true"
      >
        {activeLine}
      </span>
    </span>
  );
}
