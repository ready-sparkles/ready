import { userSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { withSessionMemoryCapability } from "../../application/session-memory-capability";

const HTTP_STATUS_UNAUTHORIZED = 401;
const UNEXPECTED_FETCH_MESSAGE = "unexpected";
const OFFLINE_ERROR_MESSAGE = "offline";

const user = userSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  email: "memory@example.com",
  displayName: "Memory Test",
  avatarUrl: null,
  workspaceId: "00000000-0000-4000-8000-000000000002",
  createdAt: "2026-10-01T00:00:00.000Z",
});

const memoryAvailabilityCases = [{ isMemoryAvailable: true }, { isMemoryAvailable: false }] as const;

memoryAvailabilityCases.forEach(({ isMemoryAvailable }) => {
  void test(`upgrades an old session with server availability ${isMemoryAvailable} without replacing its profile`, async (t) => {
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
        assert.equal(url, "https://api.example.com/v1/auth/me");
        assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-token");

        return Response.json({
          user: {
            ...user,
            displayName: "Changed",
            /** @external existing memory capability wire field */
            memoryAvailable: isMemoryAvailable,
          },
        });
      },
    );
    const upgraded = await withSessionMemoryCapability({
      user,
      apiToken: "test-token",
      apiBaseUrl: "https://api.example.com",
    });
    assert.deepEqual(upgraded, {
      ...user,
      /** @external existing memory capability wire field */
      memoryAvailable: isMemoryAvailable,
    });
    await withSessionMemoryCapability({
      user: upgraded,
      apiToken: "test-token",
      apiBaseUrl: "https://api.example.com",
    });
    assert.equal(fetchMock.mock.callCount(), 1);
  });
});

void test("guests do not request full-user capability data", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error(UNEXPECTED_FETCH_MESSAGE);
  });
  const guest = { ...user, source: "guest" as const };
  assert.equal(
    await withSessionMemoryCapability({
      user: guest,
      apiToken: "token",
      apiBaseUrl: "https://api.example.com",
    }),
    guest,
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

const authPreservationScenarios = ["network", "unauthorized", "invalid", "different-user", "old-api"] as const;

authPreservationScenarios.forEach((scenario) => {
  void test(`preserves existing authentication on ${scenario}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      if (scenario === "network") {
        throw new Error(OFFLINE_ERROR_MESSAGE);
      }
      if (scenario === "unauthorized") {
        return new Response(null, { status: HTTP_STATUS_UNAUTHORIZED });
      }
      if (scenario === "invalid") {
        return Response.json({});
      }

      return Response.json({
        user:
          scenario === "old-api"
            ? user
            : {
                ...user,
                id: user.workspaceId,
                /** @external existing memory capability wire field */
                memoryAvailable: true,
              },
      });
    });
    assert.equal(
      await withSessionMemoryCapability({ user, apiToken: "token", apiBaseUrl: "https://api.example.com" }),
      user,
    );
  });
});
