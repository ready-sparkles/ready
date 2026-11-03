import "../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";

import { broadcastMemoryForget } from "../../composition/memory-cache-updates";
import type { MemoryListData } from "../../composition/memory-list-sync";
import { useMemoryNavigationCache } from "../../composition/use-memory-navigation-cache";

const CLIENT_COUNT = 3;
const OTHER_USER_INDEX = 2;
const OFFLINE_MESSAGE = "offline";

after(async () => GlobalRegistrator.unregister());
void test("Forget reaches another tab in the same scope, including when refresh is offline", async (t) => {
  const channels = new Set<FakeChannel>();
  class FakeChannel {
    listeners: ((event: MessageEvent) => void)[] = [];
    constructor(public name: string) {
      channels.add(this);
    }

    addEventListener(...args: [_type: string, listener: (event: MessageEvent) => void]) {
      const [, listener] = args;
      this.listeners = [...this.listeners, listener];
    }

    removeEventListener(...args: [_type: string, listener: (event: MessageEvent) => void]) {
      const [, listener] = args;
      this.listeners = this.listeners.filter((candidate) => candidate !== listener);
    }

    postMessage(value: unknown) {
      [...channels].forEach((other) => {
        if (other === this || other.name !== this.name) {
          return;
        }
        other.listeners.forEach((listener) => {
          listener(new MessageEvent("message", { data: value }));
        });
      });
    }

    close() {
      channels.delete(this);
    }
  }
  t.mock.method(globalThis, "BroadcastChannel", function (name: string) {
    return new FakeChannel(name);
  });
  const network = { isOffline: false };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    if (network.isOffline) {
      throw new Error(OFFLINE_MESSAGE);
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    return Response.json(
      url.includes("/people") ? { people: [] } : { memories: [{ id: "forgotten" }], nextCursor: null },
    );
  });
  const clients = Array.from(
    { length: CLIENT_COUNT },
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  function Tab({ userId }: { userId: string }) {
    useMemoryNavigationCache({ session: { userId, token: "token", workspaceId: "ws" }, isEnabled: true });

    return null;
  }
  render(
    <>
      {clients.map((client, index) => (
        <QueryClientProvider key={index} client={client}>
          <Tab userId={index === OTHER_USER_INDEX ? "other" : "user"} />
        </QueryClientProvider>
      ))}
    </>,
  );
  t.after(() => {
    cleanup();
    clients.forEach((client) => {
      client.clear();
    });
  });
  const rows = (index: number) => {
    const client = clients.at(index);
    if (client === undefined) {
      return undefined;
    }

    return client.getQueriesData<MemoryListData>({
      queryKey: ["relationship-memory", index === OTHER_USER_INDEX ? "other" : "user", "ws", "list"],
    })[0]?.[1]?.pages[0]?.memories;
  };
  await waitFor(() => assert.equal(rows(1)?.length, 1));
  await waitFor(() => assert.equal(rows(OTHER_USER_INDEX)?.length, 1));
  network.isOffline = true;
  await act(async () => {
    broadcastMemoryForget({ userId: "user", workspaceId: "ws", ids: ["forgotten"] });
  });
  await waitFor(() => assert.equal(rows(1)?.length, 0));
  assert.equal(rows(OTHER_USER_INDEX)?.length, 1);
  assert.equal(channels.size, CLIENT_COUNT);
});
