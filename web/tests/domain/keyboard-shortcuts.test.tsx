import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import test from "node:test";

import { isAltShiftShortcut } from "../../domain/keyboard-shortcuts";

GlobalRegistrator.register();

const KEY_CODE_Q = "KeyQ";
const KEY_CODE_C = "KeyC";
const MAC_OPTION_SHIFT_Q_KEY = "Œ";
const PLAIN_SHIFT_Q_KEY = "Q";
const MAC_OPTION_Q_KEY = "œ";
const MAC_OPTION_SHIFT_C_KEY = "Ç";

function keyboardEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    key: init.key ?? "",
    code: init.code ?? "",
  });
}

void test("matches Option+Shift+Q on macOS where event.key is the typed character", () => {
  // On a US layout macOS keyboard, Option+Shift+Q types "Œ" — event.key never equals "q".
  const event = keyboardEvent({ altKey: true, shiftKey: true, key: MAC_OPTION_SHIFT_Q_KEY, code: KEY_CODE_Q });
  assert.equal(isAltShiftShortcut({ event, code: KEY_CODE_Q }), true);
});

void test("matches on non-mac layouts where event.key stays the plain letter", () => {
  const event = keyboardEvent({ altKey: true, shiftKey: true, key: PLAIN_SHIFT_Q_KEY, code: KEY_CODE_Q });
  assert.equal(isAltShiftShortcut({ event, code: KEY_CODE_Q }), true);
});

void test("requires both alt and shift", () => {
  assert.equal(
    isAltShiftShortcut({
      event: keyboardEvent({ altKey: true, key: MAC_OPTION_Q_KEY, code: KEY_CODE_Q }),
      code: KEY_CODE_Q,
    }),
    false,
  );
  assert.equal(
    isAltShiftShortcut({
      event: keyboardEvent({ shiftKey: true, key: PLAIN_SHIFT_Q_KEY, code: KEY_CODE_Q }),
      code: KEY_CODE_Q,
    }),
    false,
  );
});

void test("does not fire when meta or ctrl are also held", () => {
  assert.equal(
    isAltShiftShortcut({
      event: keyboardEvent({ altKey: true, shiftKey: true, metaKey: true, code: KEY_CODE_Q }),
      code: KEY_CODE_Q,
    }),
    false,
  );
  assert.equal(
    isAltShiftShortcut({
      event: keyboardEvent({ altKey: true, shiftKey: true, ctrlKey: true, code: KEY_CODE_Q }),
      code: KEY_CODE_Q,
    }),
    false,
  );
});

void test("does not fire for a different key", () => {
  const event = keyboardEvent({ altKey: true, shiftKey: true, key: MAC_OPTION_SHIFT_C_KEY, code: KEY_CODE_C });
  assert.equal(isAltShiftShortcut({ event, code: KEY_CODE_Q }), false);
});
