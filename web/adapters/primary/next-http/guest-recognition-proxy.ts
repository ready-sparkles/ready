import {
  GUEST_RECOGNITION_COOKIE,
  GUEST_RECOGNITION_EXPIRES_HEADER,
  GUEST_RECOGNITION_HEADER,
} from "@readymeet/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { serverEnv } from "../../../application/server-env";
import { createHash, createHmac } from "../../../composition/node-crypto";

const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_BAD_GATEWAY = 502;
const GUEST_PROXY_UPSTREAM_TIMEOUT_MS = 15_000;
const GUEST_RECOGNITION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_REQUEST_ORIGIN_MESSAGE = "Invalid request origin";
const MEETING_SERVICE_UNAVAILABLE_MESSAGE = "Could not contact the meeting service. Please try again.";
const GUEST_PROXY_CLIENT_UNKNOWN = "unknown";
const GUEST_RECOGNITION_CLEAR_TOKEN = "clear";

const guestRecognitionCookieOptions = {
  // @external httpOnly
  httpOnly: true,
  // @external secure
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

function isInvalidCrossOriginRequest(input: { request: NextRequest; protocol: string; host: string }): boolean {
  return input.request.method !== "GET" && input.request.headers.get("origin") !== `${input.protocol}//${input.host}`;
}

function buildGuestProxySignatureHeaders(input: { request: NextRequest; path: string }): Headers {
  const { request, path } = input;
  const headers = new Headers();
  const secret = process.env.GUEST_RECOGNITION_PROXY_SECRET;
  if (secret === undefined || secret === "") {
    return headers;
  }
  // Use the nearest proxy's client address; the deployment ingress must sanitize forwarding headers.
  const address = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? GUEST_PROXY_CLIENT_UNKNOWN;
  const client = createHash("sha256").update(address).digest("hex");
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret)
    .update(`${request.method}:/v1${path}:${timestamp}:${client}`)
    .digest("hex");
  headers.set("x-ready-guest-proxy", `${timestamp}.${client}.${signature}`);

  return headers;
}

function applyGuestRecognitionRequestHeaders(input: { request: NextRequest; headers: Headers }): void {
  const { request, headers } = input;
  const token = request.cookies.get(GUEST_RECOGNITION_COOKIE)?.value;
  if (token !== undefined && token !== "" && GUEST_RECOGNITION_TOKEN_PATTERN.test(token)) {
    headers.set(GUEST_RECOGNITION_HEADER, token);
  }
  const authorization = request.headers.get("authorization");
  if (authorization !== null && authorization !== "") {
    headers.set("authorization", authorization);
  }
  if (request.method === "POST") {
    headers.set("content-type", "application/json");
  }
}

function applyGuestRecognitionResponseCookies(input: {
  request: NextRequest;
  response: NextResponse;
  upstream: Response;
}): void {
  const nextToken = input.upstream.headers.get(GUEST_RECOGNITION_HEADER);
  if (!input.upstream.ok) {
    return;
  }
  if (input.request.method === "DELETE" || nextToken === GUEST_RECOGNITION_CLEAR_TOKEN) {
    input.response.cookies.set(GUEST_RECOGNITION_COOKIE, "", { ...guestRecognitionCookieOptions, maxAge: 0 });

    return;
  }
  if (nextToken === null || nextToken === "" || !GUEST_RECOGNITION_TOKEN_PATTERN.test(nextToken)) {
    return;
  }
  const expires = new Date(input.upstream.headers.get(GUEST_RECOGNITION_EXPIRES_HEADER) ?? "");
  if (Number.isNaN(expires.getTime())) {
    return;
  }
  input.response.cookies.set(GUEST_RECOGNITION_COOKIE, nextToken, {
    ...guestRecognitionCookieOptions,
    expires,
  });
}

/** Only allowlisted endpoints call this proxy; never forward arbitrary URLs or cookies. */
export async function proxyGuestRequest(params: { request: NextRequest; path: string }): Promise<NextResponse> {
  const { request, path } = params;
  // Next may normalize the URL hostname behind a reverse proxy; Host retains the browser authority.
  const host = request.headers.get("host") ?? request.nextUrl.host;
  const protocol = guestRecognitionCookieOptions.secure ? "https:" : request.nextUrl.protocol;
  if (isInvalidCrossOriginRequest({ request, protocol, host })) {
    return NextResponse.json({ message: INVALID_REQUEST_ORIGIN_MESSAGE }, { status: HTTP_STATUS_FORBIDDEN });
  }
  const headers = buildGuestProxySignatureHeaders({ request, path });
  applyGuestRecognitionRequestHeaders({ request, headers });
  try {
    const upstream = await fetch(`${serverEnv.INTERNAL_API_BASE_URL}/v1${path}`, {
      method: request.method,
      headers,
      cache: "no-store",
      redirect: "error",
      body: request.method === "POST" ? await request.text() : undefined,
      signal: AbortSignal.timeout(GUEST_PROXY_UPSTREAM_TIMEOUT_MS),
    });
    const response = new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
    applyGuestRecognitionResponseCookies({ request, response, upstream });

    return response;
  } catch (error) {
    if (error instanceof Error) {
      return NextResponse.json({ message: MEETING_SERVICE_UNAVAILABLE_MESSAGE }, { status: HTTP_STATUS_BAD_GATEWAY });
    }
    throw error;
  }
}
