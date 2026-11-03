import { createOutlookAddonConferenceRequestSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import { test } from "node:test";

import { isOutlookAddonCallback } from "../../domain/login-callback";
import { isOutlookDialogRequest } from "../../domain/outlook-addon-request";

const OUTLOOK_TITLE_MAX_LENGTH = 256;

void test("cookie-authenticated conference writes reject cross-origin, missing-origin and form requests", () => {
  const request = (input: { origin?: string; contentType?: string }) =>
    new Request("https://ready.app/api/outlook/conference", {
      method: "POST",
      headers: {
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        "content-type": input.contentType ?? "application/json",
      },
    });
  assert.equal(isOutlookDialogRequest(request({ origin: "https://ready.app" })), true);
  assert.equal(isOutlookDialogRequest(request({ origin: "https://evil.test" })), false);
  assert.equal(isOutlookDialogRequest(request({})), false);
  assert.equal(isOutlookDialogRequest(request({ origin: "null" })), false);
  assert.equal(isOutlookDialogRequest(request({ origin: "https://ready.app", contentType: "text/plain" })), false);
  assert.equal(
    isOutlookDialogRequest(
      new Request("http://localhost:3012/api/outlook/conference", {
        method: "POST",
        headers: { host: "127.0.0.1:3012", origin: "http://127.0.0.1:3012", "content-type": "application/json" },
      }),
    ),
    true,
  );
});

void test("Outlook requests bound input and cannot claim another Ready identity", () => {
  const valid = { title: "Meeting", requestId: "20a9792f-729c-4a96-8292-b52b1c5e7cbb" };
  assert.equal(createOutlookAddonConferenceRequestSchema.safeParse(valid).success, true);
  const invalidOutlookPayloads = [
    { ...valid, title: " " },
    { ...valid, title: "x".repeat(OUTLOOK_TITLE_MAX_LENGTH) },
    { ...valid, requestId: "invalid" },
    { ...valid, userId: "another-user" },
    { ...valid, workspaceId: "another-workspace" },
  ];
  invalidOutlookPayloads.forEach((payload) => {
    assert.equal(createOutlookAddonConferenceRequestSchema.safeParse(payload).success, false);
  });
});

void test("Outlook reauthentication uses the provider account chooser without changing ordinary login", () => {
  assert.equal(isOutlookAddonCallback("/outlook/dialog.html#requestId=one&nonce=two"), true);
  const invalidCallbacks = ["/workspace", "/outlook/dialog.html.evil#x", "https://evil.test/outlook/dialog.html#x"];
  invalidCallbacks.forEach((callback) => {
    assert.equal(isOutlookAddonCallback(callback), false);
  });
});
