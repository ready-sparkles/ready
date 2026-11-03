import assert from "node:assert/strict";
import test from "node:test";

import {
  getNextMeetingPreparationLineIndex,
  MEETING_PREPARATION_LINE_DELAYS_MS,
} from "../../../presentation/components/meeting-preparation-progress";

const MEETING_PREPARATION_FULL_DECK_LINE_COUNT = 12;
const MEETING_PREPARATION_LAST_LINE_INDEX = MEETING_PREPARATION_FULL_DECK_LINE_COUNT - 1;

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

const EXPECTED_MEETING_PREPARATION_LINE_DELAYS_MS = [
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
];

const EXPECTED_VISITED_LINE_INDICES = Array.from(
  { length: MEETING_PREPARATION_FULL_DECK_LINE_COUNT },
  (_, index) => index,
);

function walkPreparationLines(input: { current: number; visited: number[]; lineCount: number }): number[] {
  const next = getNextMeetingPreparationLineIndex({ currentIndex: input.current, lineCount: input.lineCount });
  if (next === null) {
    return input.visited;
  }

  return walkPreparationLines({
    current: next,
    visited: [...input.visited, next],
    lineCount: input.lineCount,
  });
}

void test("meeting preparation advances through its deck once and never loops", () => {
  const visited = walkPreparationLines({
    current: 0,
    visited: [0],
    lineCount: MEETING_PREPARATION_FULL_DECK_LINE_COUNT,
  });

  assert.deepEqual(visited, EXPECTED_VISITED_LINE_INDICES);
  assert.equal(
    getNextMeetingPreparationLineIndex({
      currentIndex: MEETING_PREPARATION_LAST_LINE_INDEX,
      lineCount: MEETING_PREPARATION_FULL_DECK_LINE_COUNT,
    }),
    null,
  );
  assert.deepEqual(MEETING_PREPARATION_LINE_DELAYS_MS, EXPECTED_MEETING_PREPARATION_LINE_DELAYS_MS);
});
