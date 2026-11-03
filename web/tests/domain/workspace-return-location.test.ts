import assert from "node:assert/strict";
import test from "node:test";

import { readWorkspaceReturnLocation, rememberWorkspaceLocation } from "../../domain/workspace-return-location";

const MESSAGE_STORAGE_UNAVAILABLE = "Storage unavailable";

void test("settings returns to the last workspace view, including filters, scoped to the account and workspace", () => {
  const values = new Map<string, string>();
  const storage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  const href = "/workspace/memory/people?q=Personbd&category=sales";
  rememberWorkspaceLocation({ storage, userId: "personbr", workspaceId: "ready", location: href });
  rememberWorkspaceLocation({
    storage,
    userId: "personbr",
    workspaceId: "ready",
    location: "/workspace/settings?tab=memory",
  });
  assert.equal(readWorkspaceReturnLocation({ storage, userId: "personbr", workspaceId: "ready" }), href);
  assert.equal(readWorkspaceReturnLocation({ storage, userId: "personbd", workspaceId: "ready" }), "/workspace");
  assert.equal(readWorkspaceReturnLocation({ storage, userId: "personbr", workspaceId: "other" }), "/workspace");
  rememberWorkspaceLocation({
    storage,
    userId: "personbr",
    workspaceId: "ready",
    location: "/workspace?view=tasks&tab=done",
  });
  assert.equal(
    readWorkspaceReturnLocation({ storage, userId: "personbr", workspaceId: "ready" }),
    "/workspace?view=tasks&tab=done",
  );
  const invalidLocations = ["https://example.com", "//example.com", "/workspace/../login", "/workspace/settings"];
  invalidLocations.forEach((invalid) => {
    Array.from(values.keys()).forEach((key) => {
      values.set(key, invalid);
    });
    assert.equal(readWorkspaceReturnLocation({ storage, userId: "personbr", workspaceId: "ready" }), "/workspace");
  });
});

void test("unavailable storage falls back without blocking navigation", () => {
  const storage: Pick<Storage, "getItem" | "setItem"> = {
    getItem() {
      throw new Error(MESSAGE_STORAGE_UNAVAILABLE);
    },
    setItem() {
      throw new Error(MESSAGE_STORAGE_UNAVAILABLE);
    },
  };
  rememberWorkspaceLocation({
    storage,
    userId: "personbr",
    workspaceId: "ready",
    location: "/workspace?view=past",
  });
  assert.equal(readWorkspaceReturnLocation({ storage, userId: "personbr", workspaceId: "ready" }), "/workspace");
});
