import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { userSchema } from "@readymeet/shared";
import { act, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import type { AuthSession } from "../../../domain/types";
import {
  JOINED_WORKSPACE_REFRESH_RETRY_MS,
  useJoinedWorkspaceSession,
} from "../../../presentation/hooks/use-joined-workspace-session";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH_COOLDOWN_MS = 30_000;
const STALE_WORKSPACE_RETRY_COUNT = 3;
const SECOND_REFRESH_CALL_COUNT = 2;
const TEMPORARY_OUTAGE_MESSAGE = "Temporary outage";
const IN_FLIGHT_REFRESH_ERROR = "Expected an in-flight refresh";

const session: AuthSession = {
  token: "fresh",
  user: userSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    email: "personbr@example.com",
    displayName: "Personbr",
    avatarUrl: null,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-01-01T00:00:00Z",
  }),
};

[false, true].forEach((isThrowingRefresh) => {
  void test(`refresh recovers after auth cooldown without blocking the joined state (throws=${isThrowingRefresh})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const calls = { count: 0 };
    const syncedState = { list: [] as AuthSession[] };
    const input = {
      /** @external joined workspace session hook contract */
      enabled: false,
      userId: session.user.id,
      expectedWorkspaceId: session.user.workspaceId,
      refreshSession: async () => {
        calls.count += 1;
        if (calls.count === 1) {
          if (isThrowingRefresh) {
            throw new Error(TEMPORARY_OUTAGE_MESSAGE);
          }

          return null;
        }

        return session;
      },
      onSynced: (value: AuthSession) => {
        syncedState.list = [...syncedState.list, value];
      },
    };
    const view = renderHook((props) => useJoinedWorkspaceSession(props), { initialProps: input });
    assert.equal(calls.count, 0, "no session exchange before join completion");
    await act(async () => {
      view.rerender({ ...input, enabled: true });
    });
    assert.equal(calls.count, 1);
    assert.deepEqual(syncedState.list, []);
    await act(async () => {
      t.mock.timers.tick(AUTH_COOLDOWN_MS);
    });
    assert.equal(calls.count, 1, "do not burn retries during the authentication cooldown");
    await act(async () => {
      t.mock.timers.tick(JOINED_WORKSPACE_REFRESH_RETRY_MS - AUTH_COOLDOWN_MS);
    });
    assert.deepEqual(syncedState.list, [session]);
    await act(async () => {
      t.mock.timers.tick(JOINED_WORKSPACE_REFRESH_RETRY_MS);
    });
    assert.equal(calls.count, SECOND_REFRESH_CALL_COUNT, "successful refresh stops retries");
    view.unmount();
  });
});

void test("a stale workspace retries until the joined workspace is returned", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stale = { ...session, user: { ...session.user, workspaceId: "33333333-3333-4333-8333-333333333333" } };
  const calls = { count: 0 };
  const syncedState = { list: [] as AuthSession[] };
  const view = renderHook(() =>
    useJoinedWorkspaceSession({
      /** @external joined workspace session hook contract */
      enabled: true,
      userId: session.user.id,
      expectedWorkspaceId: session.user.workspaceId,
      refreshSession: async () => {
        calls.count += 1;

        return calls.count < STALE_WORKSPACE_RETRY_COUNT ? stale : session;
      },
      onSynced: (value) => {
        syncedState.list = [...syncedState.list, value];
      },
    }),
  );
  await act(async () => {});
  assert.deepEqual(syncedState.list, [], "same user with the wrong workspace is not synchronized");
  await act(async () => {
    t.mock.timers.tick(JOINED_WORKSPACE_REFRESH_RETRY_MS);
  });
  assert.deepEqual(syncedState.list, [], "repeated stale responses keep retrying");
  await act(async () => {
    t.mock.timers.tick(JOINED_WORKSPACE_REFRESH_RETRY_MS);
  });
  assert.deepEqual(syncedState.list, [session]);
  await act(async () => {
    t.mock.timers.tick(JOINED_WORKSPACE_REFRESH_RETRY_MS);
  });
  assert.equal(calls.count, STALE_WORKSPACE_RETRY_COUNT);
  view.unmount();
});

void test("leaving cancels retry and ignores an in-flight refresh result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pendingRefresh: { resolve: ((value: AuthSession | null) => void) | null } = { resolve: null };
  const calls = { count: 0 };
  const syncedState = { list: [] as AuthSession[] };
  const input = {
    /** @external joined workspace session hook contract */
    enabled: true,
    userId: session.user.id,
    expectedWorkspaceId: session.user.workspaceId,
    refreshSession: () => {
      calls.count += 1;

      return new Promise<AuthSession | null>((done) => {
        pendingRefresh.resolve = done;
      });
    },
    onSynced: (value: AuthSession) => {
      syncedState.list = [...syncedState.list, value];
    },
  };
  const view = renderHook((props) => useJoinedWorkspaceSession(props), { initialProps: input });
  view.rerender({ ...input, enabled: false });
  const resolveRefresh = pendingRefresh.resolve;
  if (!resolveRefresh) {
    throw new Error(IN_FLIGHT_REFRESH_ERROR);
  }
  await act(async () => {
    resolveRefresh(session);
  });
  assert.deepEqual(syncedState.list, []);
  await act(async () => {
    t.mock.timers.tick(JOINED_WORKSPACE_REFRESH_RETRY_MS);
  });
  assert.equal(calls.count, 1);
  view.unmount();
});
