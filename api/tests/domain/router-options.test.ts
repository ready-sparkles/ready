import Fastify from "fastify";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { API_ROUTER_OPTIONS } from "../../adapters/primary/http/router-options";
import { integrationRoutes } from "../../adapters/primary/http/routes/integrations";

const SHORT_CALENDAR_EVENT_ID_LENGTH = 32;
const MEDIUM_CALENDAR_EVENT_ID_LENGTH = 256;
const LONG_CALENDAR_EVENT_ID_LENGTH = 1024;
const CALENDAR_EVENT_ID_LENGTHS = [
  SHORT_CALENDAR_EVENT_ID_LENGTH,
  MEDIUM_CALENDAR_EVENT_ID_LENGTH,
  LONG_CALENDAR_EVENT_ID_LENGTH,
] as const;
const UNAUTHORIZED_STATUS_CODE = 401;
const MISSING_BEARER_TOKEN_MESSAGE = "Missing bearer token";
const CALENDAR_ACCOUNT_ID = "273f69f4-078c-4075-bee7-9f2ebc647494";
const CALENDAR_EVENT_ID_PADDING = "6";

const unauthorizedResponseSchema = z.object({
  message: z.string(),
});

void test("long calendar event IDs reach the real authenticated add-call route", async () => {
  const app = Fastify({ routerOptions: API_ROUTER_OPTIONS });
  try {
    await app.register(integrationRoutes, { prefix: "/v1" });
    await Promise.all(
      CALENDAR_EVENT_ID_LENGTHS.map(async (length) => {
        const result = await app.inject({
          method: "POST",
          url: `/v1/me/calendar/accounts/${CALENDAR_ACCOUNT_ID}/events/_${CALENDAR_EVENT_ID_PADDING.repeat(length - 1)}/ready-meeting`,
          payload: {},
        });
        assert.equal(result.statusCode, UNAUTHORIZED_STATUS_CODE);
        const parsed = unauthorizedResponseSchema.parse(result.json());
        assert.equal(parsed.message, MISSING_BEARER_TOKEN_MESSAGE);
      }),
    );
  } finally {
    await app.close();
  }
});
