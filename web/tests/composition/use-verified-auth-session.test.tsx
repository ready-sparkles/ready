import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { userSchema } from "@readymeet/shared";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import { useEffect } from "react";

import { useVerifiedAuthSession, verifyBrowserSession } from "../../composition/use-verified-auth-session";
import type { AuthSessionStatus } from "../../domain/auth-session-continuity";
import type { AuthSession } from "../../domain/types";
import { ReadyQueryScope } from "../../presentation/components/query-provider";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT_A_ID = "00000000-0000-4000-8000-00000000000a";
const ACCOUNT_B_ID = "00000000-0000-4000-8000-00000000000b";
const WORKSPACE_A_ID = "00000000-0000-4000-8000-0000000000aa";
const WORKSPACE_B_ID = "00000000-0000-4000-8000-0000000000bb";
const FOCUS_BURST = 3;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const INITIAL_NOW_MS = 1000;
const COOLDOWN_ELAPSED_MS = 30_001;
const SECOND_ATTEMPT = 2;
const STOPS_AFTER_REPLACEMENT = 2;
const OFFLINE_MESSAGE = "offline";
const LIVE_MEDIA_LABEL = "Live media";
const TEMPORARY_FAILURE_STATUSES = [
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS,
] as const;

const account = ({ id, workspaceId, token }: { id: string; workspaceId: string; token: string }): AuthSession => ({
  token,
  user: userSchema.parse({
    id,
    email: `${id}@example.com`,
    displayName: "Session Test",
    avatarUrl: null,
    workspaceId,
    createdAt: "2026-10-01T00:00:00.000Z",
  }),
});

const accountA = account({ id: ACCOUNT_A_ID, workspaceId: WORKSPACE_A_ID, token: "token-a" });
const accountB = account({ id: ACCOUNT_B_ID, workspaceId: WORKSPACE_B_ID, token: "token-b" });

function setup(verify: typeof verifyBrowserSession) {
  const lifecycle = { mounts: 0, stops: 0 };
  function LiveMeeting() {
    useEffect(() => {
      lifecycle.mounts += 1;

      return () => {
        lifecycle.stops += 1;
      };
    }, []);

    return <div>{LIVE_MEDIA_LABEL}</div>;
  }
  function Harness({ session, status }: { session: AuthSession | null; status: AuthSessionStatus }) {
    const auth = useVerifiedAuthSession({ currentSession: session, status, verify });

    return (
      <>
        <button onClick={auth.clearForSignOut}>Sign out</button>
        <span data-testid="user">{auth.session?.user.id ?? "none"}</span>
        <ReadyQueryScope userId={auth.session?.user.id ?? null} workspaceId={auth.session?.user.workspaceId ?? null}>
          <LiveMeeting />
        </ReadyQueryScope>
      </>
    );
  }
  const screen = render(<Harness session={accountA} status="authenticated" />);

  return {
    screen,
    counts: () => ({ mounts: lifecycle.mounts, stops: lifecycle.stops }),
    update: ({ session, status }: { session: AuthSession | null; status: AuthSessionStatus }) =>
      screen.rerender(<Harness session={session} status={status} />),
  };
}

(["network-error", "same-account", "signed-out"] as const).forEach((outcome) => {
  void test(`ambiguous session loss keeps media mounted until verification (${outcome})`, async (t) => {
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "warn", () => {});
    const pending: {
      resolve: (session: AuthSession | null) => void;
      reject: (error: Error) => void;
    } = {
      resolve: () => {},
      reject: () => {},
    };
    const stats = { calls: 0 };
    const verify = () => {
      stats.calls += 1;

      return new Promise<AuthSession | null>((yes, no) => {
        pending.resolve = yes;
        pending.reject = no;
      });
    };
    const view = setup(verify);
    try {
      await act(async () => {});
      view.update({ session: null, status: "loading" });
      view.update({ session: null, status: "unauthenticated" });
      assert.equal(view.screen.getByTestId("user").textContent, ACCOUNT_A_ID);
      assert.deepEqual(view.counts(), { mounts: 1, stops: 0 });
      await act(async () => {
        if (outcome === "network-error") {
          pending.reject(new TypeError(OFFLINE_MESSAGE));
        } else {
          pending.resolve(outcome === "same-account" ? accountA : null);
        }
      });
      if (outcome === "signed-out") {
        assert.equal(view.screen.getByTestId("user").textContent, "none");
        assert.equal(view.counts().stops, 1);
      } else {
        assert.equal(view.screen.getByTestId("user").textContent, ACCOUNT_A_ID);
        assert.deepEqual(view.counts(), { mounts: 1, stops: 0 });
        Array.from({ length: FOCUS_BURST }).forEach(() => {
          fireEvent(window, new Event("focus"));
        });
        assert.equal(stats.calls, 1, "no automatic retry loop or rapid focus retries");
        view.update({ session: accountA, status: "authenticated" });
        assert.deepEqual(view.counts(), { mounts: 1, stops: 0 });
      }
    } finally {
      cleanup();
    }
  });
});

void test("explicit sign-out and account replacement win over late session verification", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const pending: { resolve: (session: AuthSession | null) => void } = { resolve: () => {} };
  const view = setup(
    () =>
      new Promise<AuthSession | null>((yes) => {
        pending.resolve = yes;
      }),
  );
  try {
    await act(async () => {});
    view.update({ session: null, status: "unauthenticated" });
    view.update({ session: accountB, status: "authenticated" });
    await act(async () => pending.resolve(accountA));
    assert.equal(view.screen.getByTestId("user").textContent, ACCOUNT_B_ID);
    assert.equal(view.counts().stops, 1);
    fireEvent.click(view.screen.getByRole("button", { name: "Sign out" }));
    assert.equal(view.screen.getByTestId("user").textContent, "none");
    assert.equal(view.counts().stops, STOPS_AFTER_REPLACEMENT);
  } finally {
    cleanup();
  }
});

void test("the verification endpoint distinguishes temporary failures from confirmed sign-out", async (t) => {
  const signal = new AbortController().signal;
  await TEMPORARY_FAILURE_STATUSES.reduce(async (previous, status) => {
    await previous;
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status }));
    await assert.rejects(verifyBrowserSession(signal));
    mock.mock.restore();
  }, Promise.resolve());
  await [
    new Response("null"),
    new Response("{}"),
    new Response("", { status: HTTP_UNAUTHORIZED }),
    new Response("", { status: HTTP_FORBIDDEN }),
  ].reduce(async (previous, response) => {
    await previous;
    const mock = t.mock.method(globalThis, "fetch", async () => response);
    assert.equal(await verifyBrowserSession(signal), null);
    mock.mock.restore();
  }, Promise.resolve());
});

void test("failed verification retries only on a recovery event after cooldown, including loading cycles", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const clock = { now: INITIAL_NOW_MS };
  t.mock.method(Date, "now", () => clock.now);
  const stats = { calls: 0 };
  const view = setup(async () => {
    stats.calls += 1;
    if (stats.calls === 1) {
      throw new TypeError(OFFLINE_MESSAGE);
    }

    return null;
  });
  try {
    await act(async () => {});
    view.update({ session: null, status: "unauthenticated" });
    await act(async () => {});
    view.update({ session: null, status: "loading" });
    view.update({ session: null, status: "unauthenticated" });
    await act(async () => {});
    assert.equal(stats.calls, 1);
    clock.now += COOLDOWN_ELAPSED_MS;
    assert.equal(stats.calls, 1, "elapsed time alone does not schedule retries");
    await act(async () => {
      fireEvent(window, new Event("online"));
    });
    assert.equal(stats.calls, SECOND_ATTEMPT);
    assert.equal(view.screen.getByTestId("user").textContent, "none");
  } finally {
    cleanup();
  }
});

void test("a late successful verification cannot undo explicit sign-out", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const pending: { resolve: (session: AuthSession | null) => void } = { resolve: () => {} };
  const view = setup(
    () =>
      new Promise<AuthSession | null>((yes) => {
        pending.resolve = yes;
      }),
  );
  try {
    await act(async () => {});
    view.update({ session: null, status: "unauthenticated" });
    fireEvent.click(view.screen.getByRole("button", { name: "Sign out" }));
    await act(async () => pending.resolve(accountA));
    assert.equal(view.screen.getByTestId("user").textContent, "none");
    assert.equal(view.counts().stops, 1);
  } finally {
    cleanup();
  }
});
