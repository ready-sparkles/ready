import "../../../composition/env";

import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import assert from "node:assert/strict";
import test from "node:test";

import { livekitRoutes } from "../../../adapters/primary/http/routes/livekit";
import { meetingRoutes } from "../../../adapters/primary/http/routes/meetings/index";
import {
  getDeclaredMeetingAccessLevel,
  getDeclaredMeetingAllowsWorkspaceViewer,
} from "../../../adapters/primary/http/support/meeting-access";

// Routes that operate on a specific meeting but cannot use the
// requireMeetingAccess factory must be reviewed and listed here explicitly.
const REVIEWED_EXCEPTIONS = new Set<string>([]);
const MIN_MEETING_SCOPED_ROUTE_COUNT = 20;
const MEETING_DIAGNOSTICS_RATE_LIMIT_MAX = 120;
const MIN_DIAGNOSTICS_PRE_HANDLER_COUNT = 3;

function declaredAccessLevel(route: RouteOptions) {
  const preHandlers = Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : [];

  return preHandlers.map((handler) => getDeclaredMeetingAccessLevel(handler)).find((level) => level !== undefined);
}

function declaredAllowsWorkspaceViewer(route: RouteOptions) {
  const preHandlers = Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : [];

  return preHandlers
    .map((handler) => getDeclaredMeetingAllowsWorkspaceViewer(handler))
    .find((isWorkspaceViewerAllowed) => isWorkspaceViewerAllowed !== undefined);
}

async function collectMeetingScopedRoutes(): Promise<RouteOptions[]> {
  const app: FastifyInstance = Fastify();
  const routeCollector = { routes: [] as RouteOptions[] };
  app.addHook("onRoute", (route) => {
    routeCollector.routes = [...routeCollector.routes, route];
  });

  await app.register(rateLimit, { global: false });
  await app.register(meetingRoutes, { prefix: "/v1" });
  await app.register(livekitRoutes, { prefix: "/v1" });
  await app.ready();
  await app.close();

  return routeCollector.routes.filter(
    (route) => route.url.startsWith("/v1/meetings/:meetingId") || route.url === "/v1/livekit/token",
  );
}

function assertNoUndeclaredMeetingRoutes(meetingScopedRoutes: RouteOptions[]): void {
  const undeclared = meetingScopedRoutes
    .filter((route) => declaredAccessLevel(route) === undefined)
    .map((route) => `${String(route.method)} ${route.url}`)
    .filter((key) => !REVIEWED_EXCEPTIONS.has(key));

  assert.deepEqual(
    undeclared,
    [],
    `Meeting-scoped routes must declare an access level via requireMeetingAccess: ${undeclared.join(", ")}`,
  );
}

function assertDiagnosticsRateLimit(input: { route: RouteOptions; label: string }): void {
  const rateLimitConfig = input.route.config?.rateLimit;
  assert.ok(
    rateLimitConfig !== undefined && typeof rateLimitConfig === "object",
    `${input.label} must retain a server-side request cap as a log-volume backstop`,
  );
  assert.equal(rateLimitConfig.max, MEETING_DIAGNOSTICS_RATE_LIMIT_MAX);
  assert.equal(rateLimitConfig.keyGenerator, undefined);
  assert.equal(rateLimitConfig.groupId, "meeting-diagnostics-ip");
  assert.ok(Array.isArray(input.route.preHandler));
  assert.ok(input.route.preHandler.length >= MIN_DIAGNOSTICS_PRE_HANDLER_COUNT);
}

function assertGuestAndAmbientRoutes(meetingScopedRoutes: RouteOptions[]): void {
  const guestNotesRoute = meetingScopedRoutes.find((route) => route.url === "/v1/meetings/:meetingId/guest-notes");
  assert.ok(guestNotesRoute, "guest notes route must be registered");
  assert.equal(declaredAccessLevel(guestNotesRoute), "joined-guest");
  assert.equal(declaredAllowsWorkspaceViewer(guestNotesRoute), false);

  const trackerRoute = meetingScopedRoutes.find((route) => route.url === "/v1/meetings/:meetingId/tracker");
  assert.ok(trackerRoute);
  assert.equal(declaredAccessLevel(trackerRoute), "joined-guest");
  assert.equal(declaredAllowsWorkspaceViewer(trackerRoute), false);

  const ambientRetryRoute = meetingScopedRoutes.find(
    (route) =>
      route.url === "/v1/meetings/:meetingId/ambient-context/:itemId/retry" &&
      (Array.isArray(route.method) ? route.method : [route.method]).includes("POST"),
  );
  assert.ok(ambientRetryRoute, "ambient context retry route must be registered");
  assert.equal(
    declaredAccessLevel(ambientRetryRoute),
    "participant",
    "joined guests must not be able to trigger paid context research retries",
  );

  const ambientPrivateRoute = meetingScopedRoutes.find(
    (route) =>
      route.url === "/v1/meetings/:meetingId/ambient-context/:itemId/private" &&
      (Array.isArray(route.method) ? route.method : [route.method]).includes("GET"),
  );
  assert.ok(ambientPrivateRoute, "ambient context private details route must be registered");
  assert.equal(
    declaredAccessLevel(ambientPrivateRoute),
    "participant",
    "guests, including a candidate in the call, must never see memory or Ashby details",
  );
  assert.equal(declaredAllowsWorkspaceViewer(ambientPrivateRoute), false);

  const peopleMemoryRoute = meetingScopedRoutes.find((route) => route.url === "/v1/meetings/:meetingId/people-memory");
  assert.ok(peopleMemoryRoute);
  assert.equal(declaredAccessLevel(peopleMemoryRoute), "participant");
  assert.equal(declaredAllowsWorkspaceViewer(peopleMemoryRoute), false);
}

function assertTaskAndDiagnosticsRoutes(meetingScopedRoutes: RouteOptions[]): void {
  const taskStatusRoute = meetingScopedRoutes.find(
    (route) =>
      route.url === "/v1/meetings/:meetingId/tasks/status" &&
      (Array.isArray(route.method) ? route.method : [route.method]).includes("GET"),
  );
  const taskMutationRoute = meetingScopedRoutes.find(
    (route) =>
      route.url === "/v1/meetings/:meetingId/tasks/:taskId" &&
      (Array.isArray(route.method) ? route.method : [route.method]).includes("PATCH"),
  );
  const taskRenderedRoute = meetingScopedRoutes.find(
    (route) =>
      route.url === "/v1/meetings/:meetingId/tasks/:taskId/rendered" &&
      (Array.isArray(route.method) ? route.method : [route.method]).includes("POST"),
  );
  const mediaDiagnosticsRoute = meetingScopedRoutes.find(
    (route) =>
      route.url === "/v1/meetings/:meetingId/media-diagnostics" &&
      (Array.isArray(route.method) ? route.method : [route.method]).includes("POST"),
  );
  const clientDiagnosticsRoute = meetingScopedRoutes.find(
    (route) =>
      route.url === "/v1/meetings/:meetingId/client-diagnostics" &&
      (Array.isArray(route.method) ? route.method : [route.method]).includes("POST"),
  );
  assert.ok(taskStatusRoute, "meeting task status route must be registered");
  assert.ok(taskMutationRoute, "meeting task mutation route must be registered");
  assert.ok(taskRenderedRoute, "meeting task rendered route must be registered");
  assert.ok(mediaDiagnosticsRoute, "meeting media diagnostics route must be registered");
  assert.ok(clientDiagnosticsRoute, "meeting client diagnostics route must be registered");
  assert.equal(
    declaredAccessLevel(mediaDiagnosticsRoute),
    "admitted-guest",
    "admitted guests must be able to report device failures before join bookkeeping completes",
  );
  assertDiagnosticsRateLimit({ route: mediaDiagnosticsRoute, label: "media diagnostics" });
  assert.equal(
    declaredAccessLevel(clientDiagnosticsRoute),
    "admitted-guest",
    "admitted guests must be able to report join diagnostics before join bookkeeping completes",
  );
  assertDiagnosticsRateLimit({ route: clientDiagnosticsRoute, label: "client diagnostics" });
  assert.equal(declaredAccessLevel(taskStatusRoute), "joined-guest");
  assert.equal(declaredAllowsWorkspaceViewer(taskStatusRoute), true);
  assert.equal(declaredAccessLevel(taskRenderedRoute), "joined-guest");
  assert.equal(
    declaredAllowsWorkspaceViewer(taskRenderedRoute),
    false,
    "workspace viewers must not be able to submit participant render telemetry",
  );
  assert.equal(
    declaredAccessLevel(taskMutationRoute),
    "participant",
    "joined guests may subscribe and read live tasks but must remain read-only",
  );
}

void test("every meeting-scoped route declares a meeting access level", async () => {
  const meetingScopedRoutes = await collectMeetingScopedRoutes();

  assert.ok(
    meetingScopedRoutes.length >= MIN_MEETING_SCOPED_ROUTE_COUNT,
    `Expected at least ${MIN_MEETING_SCOPED_ROUTE_COUNT} meeting-scoped routes, found ${meetingScopedRoutes.length}`,
  );

  assertNoUndeclaredMeetingRoutes(meetingScopedRoutes);
  assertGuestAndAmbientRoutes(meetingScopedRoutes);
  assertTaskAndDiagnosticsRoutes(meetingScopedRoutes);
});
