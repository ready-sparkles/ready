import { ConnectionQuality } from "livekit-client";

export const CONNECTION_QUALITY_DIAGNOSTIC_COOLDOWN_MS = 30_000;

type ConnectionQualityDiagnosticLimiter = {
  shouldReport: (input: { participantIdentity: string; quality: ConnectionQuality; now?: number }) => boolean;
  removeParticipant: (participantIdentity: string) => void;
};

export function createConnectionQualityDiagnosticLimiter(
  cooldownMs = CONNECTION_QUALITY_DIAGNOSTIC_COOLDOWN_MS,
): ConnectionQualityDiagnosticLimiter {
  const qualityByParticipant = new Map<string, ConnectionQuality>();
  const lastReportAtByParticipantAndQuality = new Map<string, number>();

  return {
    shouldReport({ participantIdentity, quality, now = Date.now() }) {
      const previousQuality = qualityByParticipant.get(participantIdentity);
      qualityByParticipant.set(participantIdentity, quality);

      if ((quality !== ConnectionQuality.Poor && quality !== ConnectionQuality.Lost) || previousQuality === quality) {
        return false;
      }

      const reportKey = `${participantIdentity}:${quality}`;
      const lastReportAt = lastReportAtByParticipantAndQuality.get(reportKey);
      if (lastReportAt !== undefined && now - lastReportAt < cooldownMs) {
        return false;
      }

      lastReportAtByParticipantAndQuality.set(reportKey, now);

      return true;
    },

    removeParticipant(participantIdentity) {
      qualityByParticipant.delete(participantIdentity);
      lastReportAtByParticipantAndQuality.delete(`${participantIdentity}:${ConnectionQuality.Poor}`);
      lastReportAtByParticipantAndQuality.delete(`${participantIdentity}:${ConnectionQuality.Lost}`);
    },
  };
}
