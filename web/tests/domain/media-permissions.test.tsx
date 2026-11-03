import assert from "node:assert/strict";
import test from "node:test";

import {
  getMediaPermissionErrorMessage,
  isMediaPermissionBlockedError,
  type MediaPermissionKind,
} from "../../domain/media-permissions";

const DENIED_BY_USER_MESSAGE = "The request was denied by the user";
const DEVICE_EXPLODED_MESSAGE = "Device exploded quietly";

function errorWithName(input: { name: string; message?: string }) {
  const error = new Error(input.message ?? "");
  error.name = input.name;

  return error;
}

void test("media permission blocked detection includes browser permission failures", () => {
  assert.equal(isMediaPermissionBlockedError(errorWithName({ name: "NotAllowedError" })), true);
  assert.equal(isMediaPermissionBlockedError(errorWithName({ name: "SecurityError" })), true);
  assert.equal(isMediaPermissionBlockedError(new Error(DENIED_BY_USER_MESSAGE)), true);
  assert.equal(isMediaPermissionBlockedError(errorWithName({ name: "NotReadableError" })), false);
});

void test("media permission copy maps blocked errors per device kind", () => {
  assert.equal(
    getMediaPermissionErrorMessage({ kind: "microphone", error: errorWithName({ name: "NotAllowedError" }) }),
    "Microphone access is blocked. Allow microphone access in your browser, then click microphone again.",
  );
  assert.equal(
    getMediaPermissionErrorMessage({ kind: "camera", error: errorWithName({ name: "SecurityError" }) }),
    "Camera access is blocked. Allow camera access in your browser, then click camera again.",
  );
});

void test("media permission copy maps hardware and constraint errors", () => {
  const cases: [MediaPermissionKind, Error, string][] = [
    [
      "microphone",
      errorWithName({ name: "NotFoundError" }),
      "No microphone was found. Connect one, then click microphone again.",
    ],
    [
      "camera",
      errorWithName({ name: "DevicesNotFoundError" }),
      "No camera was found. Connect one, then click camera again.",
    ],
    [
      "microphone",
      errorWithName({ name: "NotReadableError" }),
      "Microphone is already in use or unavailable. Close other apps using it, then click microphone again.",
    ],
    [
      "camera",
      errorWithName({ name: "TrackStartError" }),
      "Camera is already in use or unavailable. Close other apps using it, then click camera again.",
    ],
    [
      "microphone",
      errorWithName({ name: "OverconstrainedError" }),
      "The selected microphone is unavailable. Choose another microphone in Settings.",
    ],
    [
      "camera",
      errorWithName({ name: "ConstraintNotSatisfiedError" }),
      "The selected camera is unavailable. Choose another camera in Settings.",
    ],
  ];

  cases.forEach(([kind, error, expected]) => {
    assert.equal(getMediaPermissionErrorMessage({ kind, error }), expected);
  });
});

void test("media permission copy falls back to display or error messages", () => {
  assert.equal(
    getMediaPermissionErrorMessage({ kind: "microphone", error: { displayMessage: "Custom device message" } }),
    "Custom device message",
  );
  assert.equal(
    getMediaPermissionErrorMessage({ kind: "camera", error: new Error(DEVICE_EXPLODED_MESSAGE) }),
    DEVICE_EXPLODED_MESSAGE,
  );
  assert.equal(getMediaPermissionErrorMessage({ kind: "camera", error: null }), "Failed to start camera.");
});
