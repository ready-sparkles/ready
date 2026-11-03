import type { FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";

import { apiEnv } from "../../../../ports/api-env";

const GUEST_RECOGNITION_PROXY_MAX_AGE_MS = 60_000;

export function guestRecognitionRateKey(request: FastifyRequest): string {
  const secret = apiEnv().GUEST_RECOGNITION_PROXY_SECRET;
  const value = request.headers["x-ready-guest-proxy"];
  const hasSecret = secret !== undefined && secret !== "";
  if (!hasSecret || typeof value !== "string") {
    return request.ip;
  }
  const [timestamp, client, signature] = value.split(".");
  const hasTimestamp = timestamp !== undefined && timestamp !== "";
  const hasClient = client !== undefined && client !== "";
  const hasSignature = signature !== undefined && signature !== "";
  if (
    !hasTimestamp ||
    !hasClient ||
    !hasSignature ||
    Math.abs(Date.now() - Number(timestamp)) > GUEST_RECOGNITION_PROXY_MAX_AGE_MS ||
    !Number.isFinite(Number(timestamp)) ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    return request.ip;
  }
  const expected = createHmac("sha256", secret)
    .update(`${request.method}:${request.url}:${timestamp}:${client}`)
    .digest();

  return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? `guest-proxy:${client}` : request.ip;
}
