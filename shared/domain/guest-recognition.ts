const DAYS_PER_YEAR = 365;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;

/** Increment when the recognition purpose or consent wording materially changes. */
export const GUEST_RECOGNITION_NOTICE_VERSION = "2026-09-30-v20";
export const GUEST_RECOGNITION_PURPOSE = "Link guest participation across meetings into private People profiles";
export const GUEST_RECOGNITION_TTL_SECONDS = DAYS_PER_YEAR * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
export const GUEST_RECOGNITION_COOKIE = "ready-guest-recognition";
export const GUEST_RECOGNITION_HEADER = "x-ready-guest-recognition";
export const GUEST_RECOGNITION_EXPIRES_HEADER = "x-ready-guest-recognition-expires";
export type GuestRecognitionStatus = {
  /** @external existing wire contract */
  available: boolean;
  /** @external existing wire contract */
  recognized: boolean;
  lastDisplayName?: string | null;
};
