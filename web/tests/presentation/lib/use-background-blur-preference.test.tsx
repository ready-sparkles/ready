import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { canToggleBackgroundBlur } from "../../../presentation/lib/background-blur";
import { useBackgroundBlurPreference } from "../../../presentation/lib/use-background-blur-preference";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

void test("saved blur stays on until explicitly disabled even when the browser cannot enable blur", async (t) => {
  t.after(cleanup);
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      preferences: {
        /** @external API response */
        backgroundBlurEnabled: true,
      },
    }),
  );
  const hook = renderHook(() => useBackgroundBlurPreference("unsupported-browser-session"));
  await act(async () => {});
  assert.equal(hook.result.current.isBackgroundBlurPreferenceReady, true);
  assert.equal(hook.result.current.isBackgroundBlurEnabled, true, "do not silently reveal raw camera output");
  assert.equal(
    canToggleBackgroundBlur({ ...hook.result.current, isBackgroundBlurSupported: false }),
    true,
    "the saved preference must not trap the user behind a disabled blur-off control",
  );
  await act(async () => {
    hook.result.current.setBackgroundBlurEnabled(false);
  });
  assert.equal(hook.result.current.isBackgroundBlurEnabled, false, "carry the explicit blur-off choice into join");
  assert.equal(canToggleBackgroundBlur({ ...hook.result.current, isBackgroundBlurSupported: false }), false);
  assert.equal(canToggleBackgroundBlur({ ...hook.result.current, isBackgroundBlurSupported: true }), true);
});

void test("auth resolving after mount keeps preview and join preference pending until that session loads", async (t) => {
  t.after(cleanup);
  const responses: { pending: ((response: Response) => void)[] } = { pending: [] };
  t.mock.method(
    globalThis,
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        responses.pending = [...responses.pending, resolve];
      }),
  );
  const hook = renderHook(({ token }: { token: string | undefined }) => useBackgroundBlurPreference(token), {
    initialProps: { token: undefined as string | undefined },
  });
  assert.equal(hook.result.current.isBackgroundBlurPreferenceReady, true);
  hook.rerender({ token: "signed-in" });
  assert.equal(hook.result.current.isBackgroundBlurPreferenceReady, false);
  await act(async () => {
    responses.pending[0]?.(
      Response.json({
        preferences: {
          /** @external API response */
          backgroundBlurEnabled: true,
        },
      }),
    );
  });
  assert.equal(hook.result.current.isBackgroundBlurPreferenceReady, true);
  assert.equal(hook.result.current.isBackgroundBlurEnabled, true);
  hook.rerender({ token: "another-session" });
  assert.equal(hook.result.current.isBackgroundBlurPreferenceReady, false);
  await act(async () => {
    hook.result.current.setBackgroundBlurEnabled(false);
  });
  assert.equal(hook.result.current.isBackgroundBlurPreferenceReady, true);
  await act(async () => {
    responses.pending[1]?.(
      Response.json({
        preferences: {
          /** @external API response */
          backgroundBlurEnabled: true,
        },
      }),
    );
  });
  assert.equal(hook.result.current.isBackgroundBlurEnabled, false, "explicit choice wins a late saved preference");
});
