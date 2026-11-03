import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { updateSavedCalendarDescription } from "../../application/calendar-description-worker";

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_PRECONDITION_FAILED = 412;

const calendarPatchBodySchema = z.object({
  description: z.string(),
});

const input = {
  accessToken: "fixture-token",
  email: "owner@example.test",
  calendarId: "primary",
  eventId: "event",
  joinUrl: "https://ready.app/dgy-kbna-crt",
  callIn: { phoneNumber: "+12025550123", pin: "123456" },
};
const identity = {
  email: input.email,
  /** @external Google OAuth verified_email */
  verified_email: true,
};
const event = {
  etag: '"revision1"',
  description: "<p>Original agenda &amp; notes</p>",
  conferenceData: { entryPoints: [{ entryPointType: "video", uri: input.joinUrl }] },
};

function readRequestInitBody(params: { init: RequestInit }): string {
  if (typeof params.init.body === "string") {
    return params.init.body;
  }
  if (params.init.body === undefined || params.init.body === null) {
    return "";
  }

  return JSON.stringify(params.init.body);
}

function readIfMatchHeader(params: { init: RequestInit }): string | null {
  return new Headers(params.init.headers).get("if-match");
}

void test("saved event gets the compact block, preserving agenda and requesting no emails", async (t) => {
  const patchRecord = { description: "", count: 0 };
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/userinfo")) {
      return Response.json(identity);
    }
    if (init?.method !== "PATCH") {
      return Response.json({
        ...event,
        description: patchRecord.description.length === 0 ? event.description : patchRecord.description,
      });
    }
    patchRecord.count += 1;
    assert.ok(url.endsWith("?sendUpdates=none"));
    assert.equal(readIfMatchHeader({ init }), event.etag);
    const body = calendarPatchBodySchema.parse(JSON.parse(readRequestInitBody({ init })));
    assert.deepEqual(Object.keys(body), ["description"]);
    patchRecord.description = body.description;

    return Response.json({});
  });
  assert.equal(await updateSavedCalendarDescription(input), "done");
  assert.ok(patchRecord.description.startsWith(event.description));
  assert.ok(patchRecord.description.includes("Join meeting: https://ready.app/dgy-kbna-crt"));
  assert.ok(patchRecord.description.includes("Dial-in: (US) +1 202-555-0123 PIN: 123456#"));
  assert.equal(await updateSavedCalendarDescription(input), "done");
  assert.equal(patchRecord.count, 1, "Retry after a successful patch does not write again");
});

(["unsaved", "removed", "replaced", "cancelled", "identity-mismatch", "expired-token", "conflict"] as const).forEach(
  (scenario) => {
    void test(`description refresh handles ${scenario} without overwriting or retrying inline`, async (t) => {
      const patches = { count: 0 };
      t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (url.endsWith("/userinfo")) {
          if (scenario === "expired-token") {
            return Response.json({}, { status: HTTP_STATUS_UNAUTHORIZED });
          }

          return Response.json({
            ...identity,
            email: scenario === "identity-mismatch" ? "other@example.test" : identity.email,
          });
        }
        if (init?.method === "PATCH") {
          patches.count += 1;
          assert.equal(scenario, "conflict");

          return Response.json({}, { status: HTTP_STATUS_PRECONDITION_FAILED });
        }
        if (scenario === "unsaved") {
          return Response.json({}, { status: HTTP_STATUS_NOT_FOUND });
        }

        return Response.json({
          ...event,
          status: scenario === "cancelled" ? "cancelled" : "confirmed",
          conferenceData:
            scenario === "removed"
              ? undefined
              : scenario === "replaced"
                ? { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/other" }] }
                : event.conferenceData,
        });
      });
      const expected = ["unsaved", "removed", "conflict"].includes(scenario) ? "pending" : "cancelled";
      assert.equal(await updateSavedCalendarDescription(input), expected);
      assert.equal(patches.count, scenario === "conflict" ? 1 : 0);
    });
  },
);

(["https://www.ready.app", "https://staging.ready.app"] as const).forEach((base) => {
  void test(`matches meeting code using add-on origin ${base}`, async (t) => {
    const patches = { count: 0 };
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/userinfo")) {
        return Response.json(identity);
      }
      if (init?.method === "PATCH") {
        patches.count += 1;

        return Response.json({});
      }

      return Response.json({
        ...event,
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: `${base}/dgy-kbna-crt/?source=calendar` }] },
      });
    });
    assert.equal(await updateSavedCalendarDescription({ ...input, joinUrl: `${base}/dgy-kbna-crt` }), "done");
    assert.equal(patches.count, 1);
  });
});
(["https://evil.example/dgy-kbna-crt", "https://ready.app/other-code"] as const).forEach((uri) => {
  void test(`does not overwrite a different conference: ${uri}`, async (t) => {
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      assert.notEqual(init?.method, "PATCH");

      return Response.json(
        url.endsWith("/userinfo")
          ? identity
          : {
              ...event,
              conferenceData: { entryPoints: [{ entryPointType: "video", uri }] },
            },
      );
    });
    assert.equal(await updateSavedCalendarDescription(input), "cancelled");
  });
});
