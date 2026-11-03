import { InsufficientAiCreditsError, PaidPlanRequiredForCreditsError } from "@readymeet/db/domain/persistence-errors";
import { INSUFFICIENT_CREDITS_CODE, INSUFFICIENT_CREDITS_USER_MESSAGE } from "@readymeet/shared";
import Fastify from "fastify";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { apiErrorResponse } from "../../../../adapters/primary/http/error-handler";
import { InsufficientProviderCreditsError, ProviderAdmissionError } from "../../../../application/metered-provider";

const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
const LEAKY_TEXT =
  "Invalid `db.aiCreditUsageEvents.create()` invocation in\n/srv/app/db/adapters/secondary/postgres/repositories.ts:3853:7";
const UPSTREAM_500_TEXT = `Assistant service error (500): ${LEAKY_TEXT}`;
const PRISMA_ERROR_NAME = "PrismaClientKnownRequestError";
const PRISMA_ERROR_CODE = "P2039";
const INTERNAL_SERVER_ERROR_TEXT = "Internal Server Error";
const CONFLICT_TEXT = "Conflict";
const SERVICE_UNAVAILABLE_TEXT = "Service Unavailable";
const RETRY_CHECKOUT_MESSAGE = "Retry your original checkout.";
const BILLING_NOT_CONFIGURED_MESSAGE = "Billing is not configured on this server.";
const HTTP_PAYMENT_REQUIRED = 402;
const PAYMENT_REQUIRED_TEXT = "Payment Required";
const PROVIDER_FAILURE_TEXT = "Provider admission failed.";
const creditErrorBodySchema = z
  .object({ statusCode: z.number(), code: z.string(), error: z.string(), message: z.string() })
  .strict();
const errorBodySchema = z.object({ statusCode: z.number(), error: z.string(), message: z.string() }).strict();

class StatusError extends Error {
  readonly statusCode: number;

  constructor(input: { message: string; statusCode: number }) {
    super(input.message);
    this.statusCode = input.statusCode;
  }
}

async function respond(error: Error): Promise<{ statusCode: number; body: z.infer<typeof errorBodySchema> }> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((caught, request, reply) => apiErrorResponse({ error: caught, request, reply }));
  app.get("/boom", async () => {
    throw error;
  });
  try {
    const response = await app.inject({ method: "GET", url: "/boom" });

    return { statusCode: response.statusCode, body: errorBodySchema.parse(JSON.parse(response.body)) };
  } finally {
    await app.close();
  }
}

const GENERIC_500 = {
  statusCode: HTTP_INTERNAL_SERVER_ERROR,
  error: INTERNAL_SERVER_ERROR_TEXT,
  message: INTERNAL_SERVER_ERROR_TEXT,
};

void test("a Prisma error becomes a generic 500 without its message, path or code", async () => {
  // Same shape as Prisma's PrismaClientKnownRequestError: a code but no HTTP status.
  const prismaError = Object.assign(new Error(LEAKY_TEXT), { name: PRISMA_ERROR_NAME, code: PRISMA_ERROR_CODE });
  const response = await respond(prismaError);

  assert.equal(response.statusCode, HTTP_INTERNAL_SERVER_ERROR);
  assert.deepEqual(response.body, GENERIC_500);
});

void test("a ZodError and a plain Error become generic 500s", async () => {
  const zodResult = z.string().safeParse(1);
  assert.ok(!zodResult.success);

  assert.deepEqual((await respond(zodResult.error)).body, GENERIC_500);
  assert.deepEqual((await respond(new Error(LEAKY_TEXT))).body, GENERIC_500);
});

void test("an upstream error that sets statusCode 500 still hides its text", async () => {
  const response = await respond(
    new StatusError({ message: UPSTREAM_500_TEXT, statusCode: HTTP_INTERNAL_SERVER_ERROR }),
  );

  assert.deepEqual(response.body, GENERIC_500);
});

void test("deliberate 4xx and 503 errors keep their user-facing message", async () => {
  const conflict = await respond(new StatusError({ message: RETRY_CHECKOUT_MESSAGE, statusCode: HTTP_CONFLICT }));
  assert.equal(conflict.statusCode, HTTP_CONFLICT);
  assert.deepEqual(conflict.body, { statusCode: HTTP_CONFLICT, error: CONFLICT_TEXT, message: RETRY_CHECKOUT_MESSAGE });

  const unavailable = await respond(
    new StatusError({ message: BILLING_NOT_CONFIGURED_MESSAGE, statusCode: HTTP_SERVICE_UNAVAILABLE }),
  );
  assert.equal(unavailable.statusCode, HTTP_SERVICE_UNAVAILABLE);
  assert.deepEqual(unavailable.body, {
    statusCode: HTTP_SERVICE_UNAVAILABLE,
    error: SERVICE_UNAVAILABLE_TEXT,
    message: BILLING_NOT_CONFIGURED_MESSAGE,
  });
});

async function respondRaw(error: Error): Promise<{ statusCode: number; body: z.infer<typeof creditErrorBodySchema> }> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((caught, request, reply) => apiErrorResponse({ error: caught, request, reply }));
  app.get("/boom", async () => {
    throw error;
  });
  try {
    const response = await app.inject({ method: "GET", url: "/boom" });

    return { statusCode: response.statusCode, body: creditErrorBodySchema.parse(JSON.parse(response.body)) };
  } finally {
    await app.close();
  }
}

void test("every credit or plan denial is the same 402 body built from the shared code and message", async () => {
  const denials = [
    new InsufficientProviderCreditsError(),
    new InsufficientAiCreditsError(),
    new PaidPlanRequiredForCreditsError(),
  ];
  const responses = await Promise.all(denials.map(async (denial) => respondRaw(denial)));

  responses.forEach((response) => {
    assert.deepEqual(response, {
      statusCode: HTTP_PAYMENT_REQUIRED,
      body: {
        statusCode: HTTP_PAYMENT_REQUIRED,
        code: INSUFFICIENT_CREDITS_CODE,
        error: PAYMENT_REQUIRED_TEXT,
        message: INSUFFICIENT_CREDITS_USER_MESSAGE,
      },
    });
  });
});

void test("a provider admission error that is not a credit denial stays a generic 500", async () => {
  const response = await respond(new ProviderAdmissionError(PROVIDER_FAILURE_TEXT));

  assert.equal(response.statusCode, HTTP_INTERNAL_SERVER_ERROR);
  assert.deepEqual(response.body, GENERIC_500);
});
