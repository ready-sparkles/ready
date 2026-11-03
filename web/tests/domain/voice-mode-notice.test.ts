import assert from "node:assert/strict";
import test from "node:test";

import {
  isVoiceServiceOutageNotice,
  voiceContextPausedMessage,
  voiceModeFailureMessage,
} from "../../domain/voice-mode-notice";

const MESSAGE_PROVIDER_COULD_NOT_CONTINUE = /provider could not continue/;
const MESSAGE_START_IT_AGAIN = /start it again/;
const MESSAGE_UNTIL_VOICE_RECONNECTS = /until voice reconnects/;
const MESSAGE_SENSITIVE = /sensitive/;
const MESSAGE_PRIVATE = /private/;
const FIXTURE_SENSITIVE_PROVIDER_DETAILS = "sensitive provider details";
const FIXTURE_PRIVATE_MESSAGE = "private";

void test("voice failure notices are scoped to the affected owner and never display provider text", () => {
  const notice = {
    type: "voice_mode_failed",
    reason: "content_filter",
    assistantOwnerParticipantIdentity: "personbr",
    message: FIXTURE_SENSITIVE_PROVIDER_DETAILS,
  };
  const samFailureMessage = voiceModeFailureMessage({ value: notice, ownerIdentity: "personbr" });
  assert.notEqual(samFailureMessage, null);
  assert.ok(samFailureMessage !== null);
  assert.match(samFailureMessage, MESSAGE_PROVIDER_COULD_NOT_CONTINUE);
  assert.doesNotMatch(samFailureMessage, MESSAGE_SENSITIVE);
  assert.equal(voiceModeFailureMessage({ value: notice, ownerIdentity: "personbd" }), null);
  const invalidVoiceFailureNotices = [
    null,
    {},
    { ...notice, type: "other" },
    { ...notice, assistantOwnerParticipantIdentity: undefined },
  ];
  invalidVoiceFailureNotices.forEach((badNotice) => {
    assert.equal(voiceModeFailureMessage({ value: badNotice, ownerIdentity: "personbr" }), null);
  });
  const modelUnavailableMessage = voiceModeFailureMessage({
    value: { ...notice, reason: "model_unavailable" },
    ownerIdentity: "personbr",
  });
  assert.notEqual(modelUnavailableMessage, null);
  assert.ok(modelUnavailableMessage !== null);
  assert.match(modelUnavailableMessage, MESSAGE_START_IT_AGAIN);
  assert.equal(isVoiceServiceOutageNotice({ ...notice, reason: "model_unavailable" }), true);
  assert.equal(isVoiceServiceOutageNotice(notice), false);
  assert.equal(isVoiceServiceOutageNotice({ type: "voice_context_paused", reason: "context_delivery_timeout" }), true);
  assert.equal(isVoiceServiceOutageNotice({ type: "voice_context_paused", reason: "context_rejected" }), false);
});

void test("context pause is owner-scoped and does not become a voice failure", () => {
  const notice = {
    type: "voice_context_paused",
    assistantOwnerParticipantIdentity: "personbr",
    message: FIXTURE_PRIVATE_MESSAGE,
  };
  const samPauseMessage = voiceContextPausedMessage({ value: notice, ownerIdentity: "personbr" });
  assert.notEqual(samPauseMessage, null);
  assert.ok(samPauseMessage !== null);
  assert.match(samPauseMessage, MESSAGE_UNTIL_VOICE_RECONNECTS);
  assert.doesNotMatch(samPauseMessage, MESSAGE_PRIVATE);
  assert.equal(voiceContextPausedMessage({ value: notice, ownerIdentity: "other" }), null);
  assert.equal(voiceModeFailureMessage({ value: notice, ownerIdentity: "personbr" }), null);
  const invalidPauseNotices = [null, {}, { ...notice, type: "voice_mode_failed" }];
  invalidPauseNotices.forEach((badNotice) => {
    assert.equal(voiceContextPausedMessage({ value: badNotice, ownerIdentity: "personbr" }), null);
  });
});
