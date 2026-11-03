import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { userSchema } from "@readymeet/shared";
import { act, cleanup, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import { useState } from "react";

import {
  SUSPENDED_WORKSPACE_RETRY_COOLDOWN_MS,
  useSuspendedWorkspaceRecovery,
} from "../../composition/use-suspended-workspace-recovery";
import type { AuthSession } from "../../domain/types";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const USER_ID = "00000000-0000-4000-8000-00000000000a";
const SUSPENDED_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";
const REPLACEMENT_WORKSPACE_ID = "00000000-0000-4000-8000-0000000000bb";
const START_TIME_MS = 1_000_000;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const REFRESH_TIMEOUT_MESSAGE = "session refresh timed out";

const sessionFor = (input: { workspaceId: string; token: string }): AuthSession => ({
  token: input.token,
  user: userSchema.parse({
    id: USER_ID,
    email: "suspended@example.com",
    displayName: "Suspended Test",
    avatarUrl: null,
    workspaceId: input.workspaceId,
    createdAt: "2026-10-01T00:00:00.000Z",
  }),
});

function createSuspendedWorkspaceBus() {
  const listeners = new Set<(token: string) => void>();

  return {
    subscribe: (listener: (token: string) => void) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    emit: (token: string) => {
      listeners.forEach((listener) => {
        listener(token);
      });
    },
  };
}

function setup(input: { resolveTo: (attempt: { current: AuthSession; count: number }) => AuthSession | null }) {
  const bus = createSuspendedWorkspaceBus();
  const refreshes = { count: 0 };
  const clock = { nowMs: START_TIME_MS };
  function Harness() {
    const [session, setSession] = useState<AuthSession>(
      sessionFor({ workspaceId: SUSPENDED_WORKSPACE_ID, token: "token-1" }),
    );
    useSuspendedWorkspaceRecovery({
      session,
      subscribe: bus.subscribe,
      now: () => clock.nowMs,
      refreshSession: async () => {
        refreshes.count += 1;
        const next = input.resolveTo({ current: session, count: refreshes.count });
        if (next !== null) {
          setSession(next);
        }

        return next;
      },
    });

    return <span data-testid="workspace">{session.user.workspaceId}</span>;
  }
  const screen = render(<Harness />);

  return { bus, clock, refreshes, screen };
}

void test("a workspace_suspended rejection for the current token moves the session to the resolved workspace", async () => {
  const { bus, refreshes, screen } = setup({
    resolveTo: () => sessionFor({ workspaceId: REPLACEMENT_WORKSPACE_ID, token: "token-2" }),
  });
  try {
    await act(async () => {
      bus.emit("token-1");
      bus.emit("token-1");
    });
    assert.equal(refreshes.count, FIRST_ATTEMPT);
    assert.equal(screen.getByTestId("workspace").textContent, REPLACEMENT_WORKSPACE_ID);
  } finally {
    cleanup();
  }
});

void test("a late rejection for an older token does not re-resolve the session", async () => {
  const { bus, refreshes, screen } = setup({
    resolveTo: () => sessionFor({ workspaceId: REPLACEMENT_WORKSPACE_ID, token: "token-2" }),
  });
  try {
    await act(async () => {
      bus.emit("token-old");
    });
    assert.equal(refreshes.count, 0);
    assert.equal(screen.getByTestId("workspace").textContent, SUSPENDED_WORKSPACE_ID);
  } finally {
    cleanup();
  }
});

void test("a server that keeps the workspace cannot cause a loop: the next try waits for the cooldown", async () => {
  const { bus, clock, refreshes, screen } = setup({ resolveTo: ({ current }) => current });
  try {
    await act(async () => {
      bus.emit("token-1");
    });
    await act(async () => {
      bus.emit("token-1");
    });
    assert.equal(refreshes.count, FIRST_ATTEMPT);
    clock.nowMs += SUSPENDED_WORKSPACE_RETRY_COOLDOWN_MS;
    await act(async () => {
      bus.emit("token-1");
    });
    assert.equal(refreshes.count, SECOND_ATTEMPT);
    assert.equal(screen.getByTestId("workspace").textContent, SUSPENDED_WORKSPACE_ID);
  } finally {
    cleanup();
  }
});

void test("a refresh that returns no session does not block a later recovery after the cooldown", async () => {
  const { bus, clock, refreshes, screen } = setup({
    resolveTo: ({ count }) =>
      count === FIRST_ATTEMPT ? null : sessionFor({ workspaceId: REPLACEMENT_WORKSPACE_ID, token: "token-2" }),
  });
  try {
    await act(async () => {
      bus.emit("token-1");
    });
    await act(async () => {
      bus.emit("token-1");
    });
    assert.equal(refreshes.count, FIRST_ATTEMPT);
    assert.equal(screen.getByTestId("workspace").textContent, SUSPENDED_WORKSPACE_ID);
    clock.nowMs += SUSPENDED_WORKSPACE_RETRY_COOLDOWN_MS;
    await act(async () => {
      bus.emit("token-1");
    });
    assert.equal(refreshes.count, SECOND_ATTEMPT);
    assert.equal(screen.getByTestId("workspace").textContent, REPLACEMENT_WORKSPACE_ID);
  } finally {
    cleanup();
  }
});

void test("a refresh that throws does not block a later recovery after the cooldown", async () => {
  const { bus, clock, refreshes, screen } = setup({
    resolveTo: ({ count }) => {
      if (count === FIRST_ATTEMPT) {
        throw new Error(REFRESH_TIMEOUT_MESSAGE);
      }

      return sessionFor({ workspaceId: REPLACEMENT_WORKSPACE_ID, token: "token-2" });
    },
  });
  try {
    await act(async () => {
      bus.emit("token-1");
    });
    assert.equal(refreshes.count, FIRST_ATTEMPT);
    assert.equal(screen.getByTestId("workspace").textContent, SUSPENDED_WORKSPACE_ID);
    clock.nowMs += SUSPENDED_WORKSPACE_RETRY_COOLDOWN_MS;
    await act(async () => {
      bus.emit("token-1");
    });
    assert.equal(refreshes.count, SECOND_ATTEMPT);
    assert.equal(screen.getByTestId("workspace").textContent, REPLACEMENT_WORKSPACE_ID);
  } finally {
    cleanup();
  }
});
