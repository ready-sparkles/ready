import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { READY_THEME_STORAGE_KEY } from "../../../domain/theme";
import { ThemeProvider, useTheme } from "../../../presentation/components/theme-provider";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function ThemeValue() {
  const { theme } = useTheme();

  return <span data-testid="theme-value">{theme}</span>;
}

void test("cross-tab removal or corruption resets the theme to light", () => {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.classList.add("dark");
  window.localStorage.setItem(READY_THEME_STORAGE_KEY, "dark");

  const view = render(
    <ThemeProvider>
      <ThemeValue />
    </ThemeProvider>,
  );

  assert.equal(view.getByTestId("theme-value").textContent, "dark");

  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: READY_THEME_STORAGE_KEY,
        newValue: null,
      }),
    );
  });

  assert.equal(view.getByTestId("theme-value").textContent, "light");
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(document.documentElement.classList.contains("dark"), false);

  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: READY_THEME_STORAGE_KEY,
        newValue: "unexpected-theme",
      }),
    );
  });

  assert.equal(view.getByTestId("theme-value").textContent, "light");

  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: READY_THEME_STORAGE_KEY,
        newValue: "dark",
      }),
    );
  });

  assert.equal(view.getByTestId("theme-value").textContent, "dark");

  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: null,
        newValue: null,
      }),
    );
  });

  assert.equal(view.getByTestId("theme-value").textContent, "light");
  view.unmount();
  window.localStorage.clear();
});

void test("public routes force light without discarding the stored app preference", () => {
  window.localStorage.setItem(READY_THEME_STORAGE_KEY, "dark");

  const view = render(
    <ThemeProvider appearanceEnabled={false}>
      <ThemeValue />
    </ThemeProvider>,
  );

  assert.equal(view.getByTestId("theme-value").textContent, "light");
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(window.localStorage.getItem(READY_THEME_STORAGE_KEY), "dark");

  view.rerender(
    <ThemeProvider appearanceEnabled>
      <ThemeValue />
    </ThemeProvider>,
  );

  assert.equal(view.getByTestId("theme-value").textContent, "dark");
  assert.equal(document.documentElement.dataset.theme, "dark");

  view.rerender(
    <ThemeProvider appearanceEnabled={false}>
      <ThemeValue />
    </ThemeProvider>,
  );

  assert.equal(view.getByTestId("theme-value").textContent, "light");
  assert.equal(window.localStorage.getItem(READY_THEME_STORAGE_KEY), "dark");
  view.unmount();
  window.localStorage.clear();
});
