// Ashby's API is RPC-style: every call is a JSON POST to /<category>.<method>,
// authenticated with HTTP Basic auth using the API key as the username.
// https://developers.ashbyhq.com/docs/introduction

import { z } from "zod";

const ASHBY_API_BASE_URL = "https://api.ashbyhq.com";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 30_000;

const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_SERVER_ERROR_MIN = 500;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;

const MILLISECONDS_PER_SECOND = 1000;
const RETRY_AFTER_MAX_MS = 60_000;
const RETRY_BACKOFF_BASE_MS = 1000;
const RETRY_BACKOFF_EXPONENT_BASE = 2;
const RETRY_BACKOFF_MAX_MS = 16_000;
const CANDIDATE_SEARCH_LIMIT = 100;

const MESSAGE_ASHBY_NETWORK_ERROR = "Network error";
const MESSAGE_ASHBY_INVALID_RESPONSE = "Invalid response";
const MESSAGE_ASHBY_REQUEST_FAILED = "Request failed";

const ashbyEnvelopeErrorItemSchema = z.union([z.string(), z.object({ message: z.string().optional() })]);

const ashbyEnvelopeSchema = z.object({
  /** @external ashby envelope success wire field */
  success: z.boolean().optional(),
  results: z
    .union([z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown()), z.null()])
    .optional(),
  /** @external ashby envelope more data available wire field */
  moreDataAvailable: z.boolean().optional(),
  nextCursor: z.union([z.string(), z.null()]).optional(),
  errors: z.array(ashbyEnvelopeErrorItemSchema).optional(),
  errorInfo: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

type AshbyParsedEnvelope = z.infer<typeof ashbyEnvelopeSchema>;

export type AshbyErrorKind =
  | "invalid_key"
  | "missing_permission"
  | "not_available"
  | "rate_limited"
  | "server"
  | "request";

const ASHBY_ERROR_KIND_SERVER: AshbyErrorKind = "server";

export class AshbyApiError extends Error {
  readonly kind: AshbyErrorKind;
  readonly endpoint: string;
  readonly status: number | null;

  constructor(...args: [kind: AshbyErrorKind, endpoint: string, message: string, status?: number | null]) {
    const [kind, endpoint, message, status = null] = args;
    super(`Ashby ${endpoint}: ${message}`);
    this.name = "AshbyApiError";
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = status;
  }

  /** Failures worth retrying later; key and permission problems need an admin instead. @external ashby api error retryable indicator */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server";
  }
}

/** A candidate as returned by candidate.search; only the fields Ready reads. */
export type AshbyCandidate = {
  id: string;
  name: string;
  primaryEmailAddress?: { value: string } | null;
  emailAddresses?: { value: string }[];
  profileUrl?: string | null;
  applicationIds?: string[];
};

/** An application as returned by application.info; only the fields Ready shows. */
export type AshbyApplication = {
  id: string;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  candidate?: { id: string } | null;
  job?: { id?: string; title?: string | null } | null;
  currentInterviewStage?: { id?: string; title?: string | null; type?: string; interviewPlanId?: string } | null;
  source?: { title?: string | null } | null;
  archiveReason?: { text?: string | null } | null;
  hiringTeam?: { firstName?: string | null; lastName?: string | null; role?: string | null }[];
};

type AshbyEnvelope<T> = {
  /** @external ashby envelope success wire field */
  success?: boolean;
  results?: T;
  /** @external ashby envelope more data available wire field */
  moreDataAvailable?: boolean;
  nextCursor?: string | null;
  errors?: (string | { message?: string })[];
  errorInfo?: { code?: string; message?: string };
};

export type AshbyClientOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

function envelopeFromParsed<T>(parsed: AshbyParsedEnvelope): AshbyEnvelope<T> {
  const envelope: AshbyEnvelope<T> = {
    success: parsed.success,
    moreDataAvailable: parsed.moreDataAvailable,
    nextCursor: parsed.nextCursor,
    errors: parsed.errors,
    errorInfo: parsed.errorInfo,
  };
  if (parsed.results !== undefined) {
    // Wire JSON results are validated structurally; call-site generics describe the expected Ashby shape.
    // @ts-expect-error Ashby RPC results are typed at each call site.
    envelope.results = parsed.results;
  }

  return envelope;
}

function errorMessage(envelope: AshbyParsedEnvelope | AshbyEnvelope<unknown> | null) {
  const messages = (envelope?.errors ?? [])
    .map((error) => (typeof error === "string" ? error : error.message))
    .filter(Boolean);

  const joined = messages.join("; ");

  return envelope?.errorInfo?.message ?? (joined !== "" ? joined : MESSAGE_ASHBY_REQUEST_FAILED);
}

function classify(input: {
  status: number;
  envelope: AshbyParsedEnvelope | AshbyEnvelope<unknown> | null;
}): AshbyErrorKind {
  const code = input.envelope?.errorInfo?.code ?? "";
  const message = errorMessage(input.envelope).toLowerCase();
  if (input.status === HTTP_STATUS_UNAUTHORIZED) {
    return "invalid_key";
  }
  if (input.status === HTTP_STATUS_TOO_MANY_REQUESTS) {
    return "rate_limited";
  }
  if (input.status >= HTTP_STATUS_SERVER_ERROR_MIN) {
    return "server";
  }
  if (code.includes("permission") || message.includes("permission")) {
    return "missing_permission";
  }
  if (input.status === HTTP_STATUS_FORBIDDEN) {
    return message.includes("api key") ? "invalid_key" : "missing_permission";
  }
  if (input.status === HTTP_STATUS_NOT_FOUND || code.includes("not_available") || message.includes("not available")) {
    return "not_available";
  }

  return "request";
}

async function readAshbyEnvelope(response: Response): Promise<AshbyParsedEnvelope | null> {
  try {
    const jsonPayload: unknown = await response.json();
    const parsed = ashbyEnvelopeSchema.safeParse(jsonPayload);
    if (!parsed.success) {
      return null;
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }

    return null;
  }
}

function retryAfterMs(input: { response: Response; attempt: number }) {
  const header = Number(input.response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) {
    return Math.min(header * MILLISECONDS_PER_SECOND, RETRY_AFTER_MAX_MS);
  }

  return Math.min(RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_EXPONENT_BASE ** input.attempt, RETRY_BACKOFF_MAX_MS);
}

export function createAshbyClient(
  ...args: [apiKey: string, options?: AshbyClientOptions]
): ReturnType<typeof buildAshbyClient> {
  const [apiKey, options = {}] = args;

  return buildAshbyClient({ apiKey, options });
}

function buildAshbyClient(input: { apiKey: string; options: AshbyClientOptions }) {
  const fetchImpl = input.options.fetch ?? fetch;
  const baseUrl = input.options.baseUrl ?? ASHBY_API_BASE_URL;
  const sleep =
    input.options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const authorization = `Basic ${Buffer.from(`${input.apiKey}:`).toString("base64")}`;

  async function call<T>(
    ...callArgs: [endpoint: string, body?: Record<string, unknown>, shouldRetry?: boolean]
  ): Promise<AshbyEnvelope<T>> {
    const [endpoint, body = {}, shouldRetry = true] = callArgs;

    const request = async (attempt: number): Promise<Response | null> => {
      try {
        return await fetchImpl(`${baseUrl}/${endpoint}`, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal: input.options.signal
            ? AbortSignal.any([input.options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
            : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        input.options.signal?.throwIfAborted();
        if (shouldRetry && attempt + 1 < MAX_ATTEMPTS) {
          await sleep(Math.min(RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_EXPONENT_BASE ** attempt, RETRY_BACKOFF_MAX_MS));

          return null;
        }
        throw new AshbyApiError(
          ASHBY_ERROR_KIND_SERVER,
          endpoint,
          error instanceof Error ? error.message : MESSAGE_ASHBY_NETWORK_ERROR,
        );
      }
    };
    const attemptCall = async (attempt: number): Promise<AshbyEnvelope<T>> => {
      input.options.signal?.throwIfAborted();
      const response = await request(attempt);
      if (response === null) {
        return attemptCall(attempt + 1);
      }
      const parsedEnvelope = await readAshbyEnvelope(response);
      if (response.ok && parsedEnvelope?.success === true) {
        return envelopeFromParsed<T>(parsedEnvelope);
      }
      if (response.ok && (!parsedEnvelope || typeof parsedEnvelope.success !== "boolean")) {
        throw new AshbyApiError(ASHBY_ERROR_KIND_SERVER, endpoint, MESSAGE_ASHBY_INVALID_RESPONSE);
      }
      const kind = classify({ status: response.status, envelope: parsedEnvelope });
      if (shouldRetry && (kind === "rate_limited" || kind === "server") && attempt + 1 < MAX_ATTEMPTS) {
        await sleep(retryAfterMs({ response, attempt }));

        return attemptCall(attempt + 1);
      }
      throw new AshbyApiError(kind, endpoint, errorMessage(parsedEnvelope), response.status);
    };

    return attemptCall(0);
  }

  return {
    call,
    /** Writes are never retried: a lost response may already have committed. */
    async write<T>(...writeArgs: [endpoint: string, body: Record<string, unknown>]) {
      const [endpoint, body] = writeArgs;

      return call<T>(endpoint, body, false);
    },
    /** Candidates whose email or name matches. Ashby caps results at 100. */
    async searchCandidates(query: { email: string } | { name: string }) {
      const envelope = await call<AshbyCandidate[] | null>("candidate.search", {
        ...query,
        limit: CANDIDATE_SEARCH_LIMIT,
      });

      return envelope.results ?? [];
    },
    async application(applicationId: string) {
      return (await call<AshbyApplication | null>("application.info", { applicationId })).results ?? null;
    },
  };
}

export type AshbyClient = ReturnType<typeof createAshbyClient>;

/** Confirms a key works and can read candidates, with the smallest read that needs candidatesRead. */
export async function verifyAshbyKey(...args: [client: AshbyClient]): Promise<void> {
  const [client] = args;
  await client.call("candidate.list", { limit: 1 });
}
