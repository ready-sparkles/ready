const ALLOWED_LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export const MAX_LOGO_BYTES = 1_048_576;

const DATA_URL_PATTERN = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i;

type WorkspaceLogoValidation =
  | {
      /** @external workspace logo validation result */
      ok: true;
      dataUrl: string;
      mimeType: string;
      bytes: number;
    }
  | {
      /** @external workspace logo validation result */
      ok: false;
      reason: "invalid_data_url" | "unsupported_type" | "too_large";
    };

/**
 * Validates an uploaded logo (sent as a base64 data URL). Accepts PNG, JPEG,
 * WebP, and GIF up to 1 MB decoded; anything else is rejected before it
 * reaches the database.
 */
export function validateWorkspaceLogoDataUrl(dataUrl: string): WorkspaceLogoValidation {
  const match = DATA_URL_PATTERN.exec(dataUrl.trim());
  const mimeCapture = match?.[1];
  const base64Capture = match?.[2];
  if (mimeCapture === undefined || base64Capture === undefined) {
    return {
      /** @external workspace logo validation result */
      ok: false,
      reason: "invalid_data_url",
    };
  }
  const mimeType = mimeCapture.toLowerCase();
  const base64 = base64Capture;
  if (!ALLOWED_LOGO_MIME_TYPES.has(mimeType)) {
    return {
      /** @external workspace logo validation result */
      ok: false,
      reason: "unsupported_type",
    };
  }

  const decoded = decodeLogoBase64(base64);
  if (decoded === null) {
    return {
      /** @external workspace logo validation result */
      ok: false,
      reason: "invalid_data_url",
    };
  }
  if (decoded.length === 0) {
    return {
      /** @external workspace logo validation result */
      ok: false,
      reason: "invalid_data_url",
    };
  }
  if (decoded.length > MAX_LOGO_BYTES) {
    return {
      /** @external workspace logo validation result */
      ok: false,
      reason: "too_large",
    };
  }

  return {
    /** @external workspace logo validation result */
    ok: true,
    dataUrl: `data:${mimeType};base64,${decoded.toString("base64")}`,
    mimeType,
    bytes: decoded.length,
  };
}

function decodeLogoBase64(base64: string): Buffer | null {
  try {
    return Buffer.from(base64, "base64");
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}
