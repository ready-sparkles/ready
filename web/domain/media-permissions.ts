export type MediaPermissionKind = "microphone" | "camera";

function getErrorName(error: unknown): string {
  if (error !== null && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") {
      return name;
    }
  }

  return "";
}

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function getFallbackErrorMessage(input: { error: unknown; fallback: string }): string {
  if (input.error !== null && typeof input.error === "object" && "displayMessage" in input.error) {
    const displayMessage = (input.error as { displayMessage?: unknown }).displayMessage;
    if (typeof displayMessage === "string" && displayMessage !== "") {
      return displayMessage;
    }
  }

  return input.error instanceof Error ? input.error.message : input.fallback;
}

export function isMediaPermissionBlockedError(error: unknown): boolean {
  const name = getErrorName(error);
  const message = getErrorText(error);

  return (
    name === "NotAllowedError" || name === "SecurityError" || /permission|denied|blocked|notallowed/i.test(message)
  );
}

export function getMediaPermissionErrorMessage(input: { kind: MediaPermissionKind; error: unknown }): string {
  const label = input.kind === "microphone" ? "Microphone" : "Camera";
  const lowerLabel = label.toLowerCase();
  const name = getErrorName(input.error);

  if (isMediaPermissionBlockedError(input.error)) {
    return `${label} access is blocked. Allow ${lowerLabel} access in your browser, then click ${lowerLabel} again.`;
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return `No ${lowerLabel} was found. Connect one, then click ${lowerLabel} again.`;
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return `${label} is already in use or unavailable. Close other apps using it, then click ${lowerLabel} again.`;
  }

  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return `The selected ${lowerLabel} is unavailable. Choose another ${lowerLabel} in Settings.`;
  }

  return getFallbackErrorMessage({ error: input.error, fallback: `Failed to start ${lowerLabel}.` });
}
