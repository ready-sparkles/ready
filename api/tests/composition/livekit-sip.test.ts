import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { createCallInHoldingSipDispatchRule, deleteSipDispatchRule } from "../../adapters/secondary/livekit/livekit";

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

const LIVEKIT_TWIRP_NOT_FOUND_CODE = "not_found";
const LIVEKIT_OBJECT_CANNOT_BE_FOUND_MESSAGE = "object cannot be found";
const NETWORK_UNAVAILABLE_MESSAGE = "network unavailable";

const sipDeleteRequestBodySchema = z.object({
  sip_dispatch_rule_id: z.string(),
});

const sipCreateDispatchRuleRequestBodySchema = z.object({
  dispatch_rule: z.object({
    rule: z.object({
      dispatch_rule_individual: z.object({
        room_prefix: z.string(),
        pin: z.string(),
      }),
    }),
    name: z.string(),
    metadata: z.string(),
    attributes: z.record(z.string(), z.string()),
    numbers: z.array(z.string()),
  }),
});

function readRequestInitBody(params: { init: RequestInit }): string {
  if (typeof params.init.body === "string") {
    return params.init.body;
  }
  if (params.init.body === undefined || params.init.body === null) {
    return "";
  }

  return JSON.stringify(params.init.body);
}

function parseSipDeleteRequestBody(params: { init: RequestInit }) {
  return sipDeleteRequestBodySchema.parse(JSON.parse(readRequestInitBody(params)));
}

function parseSipCreateDispatchRuleRequestBody(params: { init: RequestInit }) {
  return sipCreateDispatchRuleRequestBodySchema.parse(JSON.parse(readRequestInitBody(params)));
}

void test("deleting an already-missing SIP rule succeeds without hiding other failures", async (t) => {
  const request = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.deepEqual(parseSipDeleteRequestBody({ init }), { sip_dispatch_rule_id: "SDR_missing" });
    assert.ok(init.signal instanceof AbortSignal);

    return Response.json(
      { code: LIVEKIT_TWIRP_NOT_FOUND_CODE, msg: LIVEKIT_OBJECT_CANNOT_BE_FOUND_MESSAGE },
      { status: HTTP_STATUS_NOT_FOUND },
    );
  });
  assert.equal(await deleteSipDispatchRule("SDR_missing"), null);
  await (
    [
      [HTTP_STATUS_UNAUTHORIZED, "unauthenticated"],
      [HTTP_STATUS_FORBIDDEN, "permission_denied"],
      [HTTP_STATUS_INTERNAL_SERVER_ERROR, "internal"],
      [HTTP_STATUS_NOT_FOUND, "bad_route"],
    ] as const
  ).reduce<Promise<void>>(async (previous, [status, code]) => {
    await previous;
    request.mock.mockImplementation(async () => Response.json({ code }, { status }));
    await assert.rejects(deleteSipDispatchRule("SDR_missing"), new RegExp(String(status)));
  }, Promise.resolve());
  request.mock.mockImplementation(async () => new Response("Not found", { status: HTTP_STATUS_NOT_FOUND }));
  await assert.rejects(deleteSipDispatchRule("SDR_missing"), /404/);
  request.mock.mockImplementation(async () => {
    throw new Error(NETWORK_UNAVAILABLE_MESSAGE);
  });
  await assert.rejects(deleteSipDispatchRule("SDR_missing"), /network unavailable/);
});

void test("call-in rules preserve PIN, destination number and host-gated holding rooms", async (t) => {
  // Simulate an already-expired client deadline. Creates must still retrieve
  // the committed provider ID instead of aborting and leaving an orphan.
  const deadline = t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort());
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.ok(url.endsWith("/CreateSIPDispatchRule"));
    assert.equal(init.signal, undefined, "Creation must not lose a committed rule ID to a client timeout");
    const body = parseSipCreateDispatchRuleRequestBody({ init });
    assert.deepEqual(body.dispatch_rule, {
      rule: { dispatch_rule_individual: { room_prefix: "holding-fixture", pin: "123456" } },
      name: "Test call-in",
      metadata: '{"meetingLinkId":"fixture"}',
      attributes: { "ready.meetingLinkId": "fixture" },
      numbers: ["+15555550100"],
    });

    return Response.json({ sip_dispatch_rule_id: "SDR_created" });
  });
  assert.deepEqual(
    await createCallInHoldingSipDispatchRule({
      phoneNumber: "+15555550100",
      holdingRoomPrefix: "holding-fixture",
      pin: "123456",
      name: "Test call-in",
      metadata: { meetingLinkId: "fixture" },
      attributes: { "ready.meetingLinkId": "fixture" },
    }),
    { sip_dispatch_rule_id: "SDR_created" },
  );
  assert.equal(deadline.mock.callCount(), 0);
});
