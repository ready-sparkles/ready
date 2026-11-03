import assert from "node:assert/strict";
import test from "node:test";

import { loadPostMeetingRefresh } from "../../domain/post-meeting-refresh";

class FixtureHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`API request failed (${status})`);
    this.status = status;
  }
}

const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const MEETINGS = ["meeting-a", "meeting-b"];
const isMeetingUnavailable = (error: unknown) => error instanceof FixtureHttpError && error.status === HTTP_NOT_FOUND;

void test("an unknown meeting resolves to the not-found state and still returns the meeting list", async () => {
  const notFound = new FixtureHttpError(HTTP_NOT_FOUND);
  const result = await loadPostMeetingRefresh({
    listMeetings: async () => MEETINGS,
    getMeeting: async () => {
      throw notFound;
    },
    isMeetingUnavailable,
  });

  assert.deepEqual(result, { kind: "unavailable", meetings: MEETINGS, error: notFound });
});

void test("a visible meeting resolves with its detail", async () => {
  const result = await loadPostMeetingRefresh({
    listMeetings: async () => MEETINGS,
    getMeeting: async () => ({ id: "meeting-a" }),
    isMeetingUnavailable,
  });

  assert.deepEqual(result, { kind: "loaded", meetings: MEETINGS, detail: { id: "meeting-a" } });
});

void test("other meeting failures still reject", async () => {
  await assert.rejects(
    () =>
      loadPostMeetingRefresh({
        listMeetings: async () => MEETINGS,
        getMeeting: async () => {
          throw new FixtureHttpError(HTTP_INTERNAL_SERVER_ERROR);
        },
        isMeetingUnavailable,
      }),
    /API request failed \(500\)/,
  );
});
