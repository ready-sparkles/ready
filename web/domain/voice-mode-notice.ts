const VOICE_MODE_FAILED_TYPE = "voice_mode_failed";
const VOICE_CONTEXT_PAUSED_TYPE = "voice_context_paused";
const CONTENT_FILTER_REASON = "content_filter";
const VOICE_MODE_OUTAGE_REASON = "model_unavailable";
const VOICE_CONTEXT_OUTAGE_REASONS = new Set(["context_delivery_timeout", "context_send_failed"]);

const VOICE_MODE_CONTENT_FILTER_MESSAGE =
  "Voice chat with Ready stopped because the voice provider could not continue this conversation.";
const VOICE_MODE_CONNECTION_LOST_MESSAGE = "Voice chat with Ready lost its connection. You can start it again.";
const VOICE_CONTEXT_PAUSED_MESSAGE =
  "Background meeting updates are paused until voice reconnects. You can still speak and ask questions about the saved transcript.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function voiceModeFailureMessage(input: { value: unknown; ownerIdentity: string }): string | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const notice = input.value;
  if (notice.type !== VOICE_MODE_FAILED_TYPE || notice.assistantOwnerParticipantIdentity !== input.ownerIdentity) {
    return null;
  }

  return notice.reason === CONTENT_FILTER_REASON
    ? VOICE_MODE_CONTENT_FILTER_MESSAGE
    : VOICE_MODE_CONNECTION_LOST_MESSAGE;
}

export function isVoiceServiceOutageNotice(value: unknown): boolean {
  if (!isRecord(value) || typeof value.reason !== "string") {
    return false;
  }
  if (value.type === VOICE_MODE_FAILED_TYPE) {
    return value.reason === VOICE_MODE_OUTAGE_REASON;
  }
  if (value.type === VOICE_CONTEXT_PAUSED_TYPE) {
    return VOICE_CONTEXT_OUTAGE_REASONS.has(value.reason);
  }

  return false;
}

export function voiceContextPausedMessage(input: { value: unknown; ownerIdentity: string }): string | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const notice = input.value;
  if (notice.type !== VOICE_CONTEXT_PAUSED_TYPE || notice.assistantOwnerParticipantIdentity !== input.ownerIdentity) {
    return null;
  }

  return VOICE_CONTEXT_PAUSED_MESSAGE;
}
