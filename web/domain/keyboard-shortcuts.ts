export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

// Match Alt+Shift combos via event.code: on macOS Option+Shift+<letter> types a
// special character, so event.key never equals the letter itself.
export function isAltShiftShortcut(input: { event: KeyboardEvent; code: string }): boolean {
  const { event, code } = input;

  return event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && event.code === code;
}
