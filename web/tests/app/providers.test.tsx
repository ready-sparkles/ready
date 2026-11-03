import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientContext } from "@tanstack/react-query";
import { fireEvent, render } from "@testing-library/react";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { SessionContext } from "next-auth/react";
import assert from "node:assert/strict";
import test from "node:test";
import { useContext } from "react";

import { Providers } from "../../app/providers";
import { isIsolatedPreviewPath } from "../../domain/isolated-preview-path";
import { useTheme } from "../../presentation/components/theme-provider";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIEW_PROBE_LIGHT_LABEL = "Example in light";
const PREVIEW_PROBE_DARK_LABEL = "Example in dark";
const UNEXPECTED_PREVIEW_REQUEST_MESSAGE = "Unexpected preview request.";

const ISOLATED_PREVIEW_PATHS = [
  "/demo-spaces",
  "/demo-spaces/preview",
  "/updates/preview/guests",
  "/updates/preview/people",
  "/updates/preview/summary",
  "/demo/workspace",
  "/demo/workspace/dark-notes",
] as const;

const NON_ISOLATED_PATHS = [
  "/updates",
  "/updates/2026-09-30-remember-me-next-time",
  "/updates/preview-other",
  "/workspace",
  "/",
  null,
] as const;

function PreviewProbe() {
  const session = useContext(SessionContext);
  const queryClient = useContext(QueryClientContext);
  const { theme } = useTheme();
  assert.equal(session, undefined, "preview must not mount account sessions");
  assert.equal(queryClient, undefined, "preview must not restore the real query cache");

  return <span>{theme === "dark" ? PREVIEW_PROBE_DARK_LABEL : PREVIEW_PROBE_LIGHT_LABEL}</span>;
}

function previewProbeLabel(pathname: string): string {
  return pathname.endsWith("/dark-notes") ? PREVIEW_PROBE_DARK_LABEL : PREVIEW_PROBE_LIGHT_LABEL;
}

function previewTheme(pathname: string): "dark" | "light" {
  return pathname.endsWith("/dark-notes") ? "dark" : "light";
}

async function assertPreviewPath(pathname: string): Promise<void> {
  const requestCounter = { count: 0 };
  const fetchState = {
    original: globalThis.fetch,
    replacement: async () => {
      requestCounter.count += 1;
      throw new Error(UNEXPECTED_PREVIEW_REQUEST_MESSAGE);
    },
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchState.replacement,
  });
  const renderedView = { current: undefined as ReturnType<typeof render> | undefined };
  try {
    renderedView.current = render(
      <PathnameContext.Provider value={pathname}>
        <Providers>
          <PreviewProbe />
        </Providers>
      </PathnameContext.Provider>,
    );
    assert.notEqual(renderedView.current.getByText(previewProbeLabel(pathname)), null);
    assert.equal(document.documentElement.dataset.theme, previewTheme(pathname));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    assert.equal(requestCounter.count, 0);
  } finally {
    renderedView.current?.unmount();
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: fetchState.original,
    });
  }
}

ISOLATED_PREVIEW_PATHS.forEach((pathname) => {
  void test(`${pathname} renders without account providers or requests`, async () => {
    await assertPreviewPath(pathname);
  });
});

void test("isolation does not apply to articles, the feed, or signed-in app routes", () => {
  NON_ISOLATED_PATHS.forEach((pathname) => {
    assert.equal(isIsolatedPreviewPath(pathname), false, String(pathname));
  });
});

void test("the dark preview cannot change the saved appearance", () => {
  function ThemeControl() {
    const { theme, setTheme } = useTheme();

    return <button onClick={() => setTheme("light")}>{theme}</button>;
  }
  window.localStorage.setItem("ready:appearance", "light");
  const view = render(
    <PathnameContext.Provider value="/demo/workspace/dark-notes">
      <Providers>
        <ThemeControl />
      </Providers>
    </PathnameContext.Provider>,
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "dark" }));
    assert.equal(document.documentElement.dataset.theme, "dark");
    assert.equal(window.localStorage.getItem("ready:appearance"), "light");
  } finally {
    view.unmount();
    window.localStorage.removeItem("ready:appearance");
  }
});
