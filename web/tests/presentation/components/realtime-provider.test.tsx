import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, render } from "@testing-library/react";
import type Ably from "ably";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import type { AuthSession } from "../../../domain/types";
import { RealtimeClientProvider } from "../../../presentation/components/realtime-provider";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const randomTokenRadix = 36;
const randomTokenSliceStart = 2;
const sessionRefetchCount = 5;
const workspaceSwitchCreatedClientCount = 2;

function makeSession(overrides: Partial<AuthSession["user"]> = {}): AuthSession {
  return {
    token: `token-${Math.random().toString(randomTokenRadix).slice(randomTokenSliceStart)}`,
    user: z
      .custom<AuthSession["user"]>((_value): _value is AuthSession["user"] => true)
      .parse({
        id: "user-1",
        email: "personbr@example.com",
        displayName: "Personbs",
        workspaceId: "workspace-1",
        ...overrides,
      }),
  };
}

function makeFakeClientFactory() {
  const created: { values: { options: Ably.ClientOptions; isClosed: boolean }[] } = { values: [] };
  const createClient = (options: Ably.ClientOptions) => {
    const entry = { options, isClosed: false };
    created.values = [...created.values, entry];

    return z
      .custom<Ably.Realtime>((_value): _value is Ably.Realtime => true)
      .parse({
        channels: { all: {} },
        connect: () => undefined,
        close: () => {
          entry.isClosed = true;
        },
      });
  };

  return { created, createClient };
}

void test("session refetch with the same user does not recreate the Ably client", () => {
  const { created, createClient } = makeFakeClientFactory();
  const session = makeSession();

  const view = render(
    <RealtimeClientProvider createClient={createClient} refreshSession={async () => session} session={session}>
      <div />
    </RealtimeClientProvider>,
  );
  assert.equal(created.values.length, 1);

  // Simulate NextAuth session refetches (window focus, polling, update()):
  // same user and workspace, but fresh session object and fresh
  // refreshSession identity on every render.
  Array.from({ length: sessionRefetchCount }, () => makeSession()).forEach((refetchedSession) => {
    act(() => {
      view.rerender(
        <RealtimeClientProvider
          createClient={createClient}
          refreshSession={async () => refetchedSession}
          session={refetchedSession}
        >
          <div />
        </RealtimeClientProvider>,
      );
    });
  });

  assert.equal(created.values.length, 1, "session refetch must not recreate the Ably client");
  const originalClient = created.values[0];
  assert.ok(originalClient);
  assert.equal(originalClient.isClosed, false, "the original connection must stay open");
  view.unmount();
  assert.equal(originalClient.isClosed, true, "unmount must close the connection");
});

void test("a real user or workspace change recreates the client and closes the old one", () => {
  const { created, createClient } = makeFakeClientFactory();
  const session = makeSession();

  const view = render(
    <RealtimeClientProvider createClient={createClient} refreshSession={async () => session} session={session}>
      <div />
    </RealtimeClientProvider>,
  );
  assert.equal(created.values.length, 1);

  const switched = makeSession({ workspaceId: "workspace-2" });
  act(() => {
    view.rerender(
      <RealtimeClientProvider createClient={createClient} refreshSession={async () => switched} session={switched}>
        <div />
      </RealtimeClientProvider>,
    );
  });

  assert.equal(
    created.values.length,
    workspaceSwitchCreatedClientCount,
    "a workspace switch must create a fresh client",
  );
  const previousClient = created.values[0];
  const nextClient = created.values[1];
  assert.ok(previousClient);
  assert.ok(nextClient);
  assert.equal(previousClient.isClosed, true, "the previous connection must be closed");
  assert.equal(nextClient.isClosed, false);
  view.unmount();
});
