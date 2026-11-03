const CLIENT_CLOCK_SKEW_MINUTES = 5;
const MILLISECONDS_PER_MINUTE = 60_000;

export const MEETING_TASK_CLIENT_CLOCK_SKEW_MS = CLIENT_CLOCK_SKEW_MINUTES * MILLISECONDS_PER_MINUTE;

const MEETING_TASK_TIMESTAMP_SEQUENCE_MESSAGES = {
  realtimeAfterRefetchStart: "Realtime-received timestamp must not be after refetch-started timestamp.",
  refetchCompletedBeforeStart: "Refetch-completed timestamp must not precede refetch-started timestamp.",
  renderedBeforeRefetchCompleted: "Rendered timestamp must not precede refetch-completed timestamp.",
  renderedBeforeRealtime: "Rendered timestamp must not precede realtime-received timestamp.",
  renderedBeforeRefetchStart: "Rendered timestamp must not precede refetch-started timestamp.",
} as const;

export function isMeetingTaskClientTimestampWithinWindow(input: { value: string; serverNowMs: number }): boolean {
  const { value, serverNowMs } = input;

  return Math.abs(serverNowMs - Date.parse(value)) <= MEETING_TASK_CLIENT_CLOCK_SKEW_MS;
}

type MeetingTaskClientTimestamps = {
  renderedAt: string;
  realtimeReceivedAt?: string | null;
  refetchStartedAt?: string | null;
  refetchCompletedAt?: string | null;
};

export function getMeetingTaskClientTimestampSequenceError(timestamps: MeetingTaskClientTimestamps): string | null {
  const orderedPairs = [
    [
      timestamps.realtimeReceivedAt,
      timestamps.refetchStartedAt,
      MEETING_TASK_TIMESTAMP_SEQUENCE_MESSAGES.realtimeAfterRefetchStart,
    ],
    [
      timestamps.refetchStartedAt,
      timestamps.refetchCompletedAt,
      MEETING_TASK_TIMESTAMP_SEQUENCE_MESSAGES.refetchCompletedBeforeStart,
    ],
    [
      timestamps.refetchCompletedAt,
      timestamps.renderedAt,
      MEETING_TASK_TIMESTAMP_SEQUENCE_MESSAGES.renderedBeforeRefetchCompleted,
    ],
    [
      timestamps.realtimeReceivedAt,
      timestamps.renderedAt,
      MEETING_TASK_TIMESTAMP_SEQUENCE_MESSAGES.renderedBeforeRealtime,
    ],
    [
      timestamps.refetchStartedAt,
      timestamps.renderedAt,
      MEETING_TASK_TIMESTAMP_SEQUENCE_MESSAGES.renderedBeforeRefetchStart,
    ],
  ] as const;

  return (
    orderedPairs.find(
      ([earlier, later]) =>
        earlier !== null &&
        earlier !== undefined &&
        earlier !== "" &&
        later !== null &&
        later !== undefined &&
        later !== "" &&
        Date.parse(earlier) > Date.parse(later),
    )?.[2] ?? null
  );
}
