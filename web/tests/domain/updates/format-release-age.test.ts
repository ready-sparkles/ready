import assert from "node:assert/strict";
import test from "node:test";

import { formatReleaseAge } from "../../../domain/updates/format-release-age";

const TEST_YEAR = 2026;
const TEST_MONTH = 9;
const TEST_DAY = 1;
const TEST_HOUR = 12;
const JANUARY_MONTH = 0;
const FEBRUARY_MONTH = 1;
const FEBRUARY_DAY = 28;
const JANUARY_THIRD = 3;
const RELEASE_AGE_CASES = [
  ["2026-10-01", "Today"],
  ["2026-09-30", "Yesterday"],
  ["2026-09-29", "2 days ago"],
  ["2026-09-01", "1 month ago"],
  ["2026-08-30", "1 month, 1 day ago"],
  ["2026-07-30", "2 months, 1 day ago"],
  ["2026-07-29", "2 months, 2 days ago"],
  ["2026-10-02", "Full date"],
] as const;

void test("release ages keep recent labels and include whole months with remaining days", () => {
  const now = new Date(TEST_YEAR, TEST_MONTH, TEST_DAY, TEST_HOUR);
  RELEASE_AGE_CASES.forEach(([date, expected]) => {
    assert.equal(formatReleaseAge({ date, fullDate: "Full date", now }), expected);
  });
});

void test("month anniversaries handle shorter months and year boundaries", () => {
  assert.equal(
    formatReleaseAge({
      date: "2026-01-31",
      fullDate: "",
      now: new Date(TEST_YEAR, FEBRUARY_MONTH, FEBRUARY_DAY),
    }),
    "1 month ago",
  );
  assert.equal(
    formatReleaseAge({ date: "2025-12-01", fullDate: "", now: new Date(TEST_YEAR, JANUARY_MONTH, JANUARY_THIRD) }),
    "1 month, 2 days ago",
  );
});
