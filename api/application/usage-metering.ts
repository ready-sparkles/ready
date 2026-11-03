import type { RepositoryPort } from "@readymeet/db/ports/repository";

import { apiEnv } from "../ports/api-env";
import { repositories } from "../ports/repository-runtime";

const MICRO_USD_PER_USD = 1_000_000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

function usdToMicroUsd(value: number) {
  return Math.max(0, Math.round(value * MICRO_USD_PER_USD));
}

function getMeetingDurationSeconds(meeting: Awaited<ReturnType<RepositoryPort["getMeetingById"]>>) {
  if (!meeting?.startedAt || !meeting.endedAt) {
    return 0;
  }

  return Math.max(0, Math.ceil((meeting.endedAt.getTime() - meeting.startedAt.getTime()) / MS_PER_SECOND));
}

function costForSeconds(input: { seconds: number; minuteRateUsd: number }): number {
  return Math.round((input.seconds / SECONDS_PER_MINUTE) * usdToMicroUsd(input.minuteRateUsd));
}

export async function recordFinalizedMeetingUsage(input: { meetingId: string; hasTranscript: boolean }): Promise<void> {
  const meeting = await repositories().getMeetingById(input.meetingId);
  if (!meeting) {
    return;
  }

  const durationSeconds = getMeetingDurationSeconds(meeting);
  if (durationSeconds <= 0) {
    return;
  }

  const participants = await repositories().listParticipantsForMeeting(input.meetingId);
  const humanParticipantCount = Math.max(
    1,
    participants.filter((participant) => participant.role === "host" || participant.role === "guest").length,
  );

  if (input.hasTranscript) {
    await repositories().recordUsageEvent({
      userId: meeting.createdByUserId,
      meetingId: input.meetingId,
      provider: "assemblyai",
      category: "transcription",
      sku: "meeting_audio",
      unitCount: durationSeconds,
      unitType: "audio_second",
      unitPriceMicroUsd:
        apiEnv().ADMIN_TRANSCRIPTION_AUDIO_MINUTE_USD > 0
          ? Math.round(usdToMicroUsd(apiEnv().ADMIN_TRANSCRIPTION_AUDIO_MINUTE_USD) / SECONDS_PER_MINUTE)
          : null,
      costMicroUsd: costForSeconds({
        seconds: durationSeconds,
        minuteRateUsd: apiEnv().ADMIN_TRANSCRIPTION_AUDIO_MINUTE_USD,
      }),
      source: "meeting_finalized",
      idempotencyKey: `meeting:${input.meetingId}:transcription`,
      metadata: {
        durationSeconds,
        /** @external usage metering metadata wire field */
        rateConfigured: apiEnv().ADMIN_TRANSCRIPTION_AUDIO_MINUTE_USD > 0,
      },
      occurredAt: meeting.endedAt ?? new Date(),
    });
  }

  const participantSeconds = durationSeconds * humanParticipantCount;
  await repositories().recordUsageEvent({
    userId: meeting.createdByUserId,
    meetingId: input.meetingId,
    provider: "livekit",
    category: "realtime_room",
    sku: "participant_minute",
    unitCount: participantSeconds,
    unitType: "participant_second",
    unitPriceMicroUsd:
      apiEnv().ADMIN_LIVEKIT_PARTICIPANT_MINUTE_USD > 0
        ? Math.round(usdToMicroUsd(apiEnv().ADMIN_LIVEKIT_PARTICIPANT_MINUTE_USD) / SECONDS_PER_MINUTE)
        : null,
    costMicroUsd: 0,
    source: "meeting_finalized",
    idempotencyKey: `meeting:${input.meetingId}:livekit`,
    metadata: {
      durationSeconds,
      humanParticipantCount,
      participantSeconds,
      includedParticipantMinutes: apiEnv().ADMIN_LIVEKIT_INCLUDED_PARTICIPANT_MINUTES,
      /** @external usage metering metadata wire field */
      quotaAppliedInAdmin: true,
      /** @external usage metering metadata wire field */
      rateConfigured: apiEnv().ADMIN_LIVEKIT_PARTICIPANT_MINUTE_USD > 0,
    },
    occurredAt: meeting.endedAt ?? new Date(),
  });
}
