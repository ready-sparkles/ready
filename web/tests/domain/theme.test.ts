import { GlobalRegistrator } from "@happy-dom/global-registrator";
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReadyTheme,
  isReadyTheme,
  readStoredTheme,
  READY_THEME_STORAGE_KEY,
  supportsReadyAppearance,
} from "../../domain/theme";

GlobalRegistrator.register();

const BLOCKED_STORAGE_MESSAGE = "blocked";

const PUBLIC_ROUTE_PATHS = [
  "/",
  "/about",
  "/admin",
  "/docs",
  "/docs/getting-started",
  "/pricing",
  "/privacy",
  "/terms",
  "/login",
  "/signup",
] as const;

void test("recognizes only supported Ready themes", () => {
  assert.equal(isReadyTheme("light"), true);
  assert.equal(isReadyTheme("dark"), true);
  assert.equal(isReadyTheme("system"), false);
  assert.equal(isReadyTheme(null), false);
});

void test("reads a stored theme and falls back safely", () => {
  assert.equal(readStoredTheme({ getItem: () => "dark" }), "dark");
  assert.equal(readStoredTheme({ getItem: () => "system" }), "light");
  assert.equal(
    readStoredTheme({
      getItem: () => {
        throw new Error(BLOCKED_STORAGE_MESSAGE);
      },
    }),
    "light",
  );
  assert.equal(readStoredTheme(null), "light");
});

void test("uses the stable appearance storage key", () => {
  assert.equal(READY_THEME_STORAGE_KEY, "ready:appearance");
});

void test("keeps public, support, admin, and authentication routes fixed to light mode", () => {
  PUBLIC_ROUTE_PATHS.forEach((pathname) => {
    assert.equal(supportsReadyAppearance(pathname), false, pathname);
  });

  assert.equal(supportsReadyAppearance("/workspace"), true);
  assert.equal(supportsReadyAppearance("/workspace/settings"), true);
  assert.equal(supportsReadyAppearance("/meet"), true);
});

void test("applies the theme to the document root contract", () => {
  const root = document.createElement("div");

  applyReadyTheme({ root, theme: "dark" });
  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(root.classList.contains("dark"), true);

  applyReadyTheme({ root, theme: "light" });
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  assert.equal(root.classList.contains("dark"), false);
});
