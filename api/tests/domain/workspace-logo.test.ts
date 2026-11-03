import assert from "node:assert/strict";
import test from "node:test";

import { MAX_LOGO_BYTES, validateWorkspaceLogoDataUrl } from "../../domain/workspace-logo";

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex");
const SUPPORTED_LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

function dataUrl(input: { mime: string; bytes: Buffer }) {
  return `data:${input.mime};base64,${input.bytes.toString("base64")}`;
}

void test("accepts supported image types within the size limit", () => {
  SUPPORTED_LOGO_MIME_TYPES.forEach((mime) => {
    const result = validateWorkspaceLogoDataUrl(dataUrl({ mime, bytes: PNG_BYTES }));
    assert.equal(result.ok, true, mime);
    assert.equal(result.mimeType, mime);
    assert.equal(result.bytes, PNG_BYTES.length);
  });
});

void test("rejects unsupported types, oversize payloads, and malformed data URLs", () => {
  const svg = validateWorkspaceLogoDataUrl(dataUrl({ mime: "image/svg+xml", bytes: Buffer.from("<svg/>") }));
  assert.equal(svg.ok, false);
  assert.equal(svg.reason, "unsupported_type");

  const oversize = validateWorkspaceLogoDataUrl(
    dataUrl({ mime: "image/png", bytes: Buffer.alloc(MAX_LOGO_BYTES + 1) }),
  );
  assert.equal(oversize.ok, false);
  assert.equal(oversize.reason, "too_large");

  assert.equal(validateWorkspaceLogoDataUrl("not-a-data-url").ok, false);
  assert.equal(validateWorkspaceLogoDataUrl("data:image/png;base64,").ok, false);
  assert.equal(validateWorkspaceLogoDataUrl("https://example.com/logo.png").ok, false);
});
