import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LOGIN_CALLBACK_URL, isOutlookAddonCallback, normalizeCallbackUrl } from "../../domain/login-callback";

void test("missing and unsafe login callbacks use the default destination", () => {
  [
    null,
    "",
    "workspace",
    "https://example.com",
    "https://example.com/workspace",
    "//example.com",
    "/login",
    "/signup",
    "/login?next=1",
  ].forEach((value) => {
    assert.equal(normalizeCallbackUrl(value), DEFAULT_LOGIN_CALLBACK_URL, JSON.stringify(value));
  });
});

void test("callbacks that a browser would send to another site use the default destination", () => {
  [
    "/\\evil.example",
    "/\\/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n/evil.example",
    // "." / ".." removal leaves a protocol-relative path the browser sends off-site.
    "/.//evil.example",
    "/a/..//evil.example",
    "/%2e//evil.example",
    "/%2E%2E//evil.example",
    "/x/%2e%2e//evil.example",
    "/a\\..\\\\evil.example",
    "/./\\evil.example",
    "/././\\/evil.example",
  ].forEach((value) => {
    assert.equal(normalizeCallbackUrl(value), DEFAULT_LOGIN_CALLBACK_URL, JSON.stringify(value));
  });
});

void test("callbacks are returned as the parsed path, not the raw input", () => {
  assert.equal(normalizeCallbackUrl("/a\\b"), "/a/b");
  assert.equal(normalizeCallbackUrl("/work\tspace"), "/workspace");
  assert.equal(normalizeCallbackUrl("/a/../workspace"), "/workspace");
});

void test("safe internal callbacks are preserved and Outlook dialog callbacks are recognized", () => {
  assert.equal(normalizeCallbackUrl("/workspace?view=upcoming"), "/workspace?view=upcoming");
  assert.equal(normalizeCallbackUrl("/meet?requestAccess=1"), "/meet?requestAccess=1");
  assert.equal(normalizeCallbackUrl("/abc-defg-hij"), "/abc-defg-hij");
  assert.equal(normalizeCallbackUrl("/workspace/meeting-123"), "/workspace/meeting-123");
  assert.equal(normalizeCallbackUrl("/outlook/dialog.html#nonce=a%2Fb"), "/outlook/dialog.html#nonce=a%2Fb");
  assert.equal(isOutlookAddonCallback("/outlook/dialog.html#state=123"), true);
  assert.equal(isOutlookAddonCallback("/workspace"), false);
});
