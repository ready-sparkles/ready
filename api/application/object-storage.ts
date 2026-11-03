import { createHash, createHmac } from "node:crypto";

import { apiEnv } from "../ports/api-env";

const SERVICE = "s3";
const MAIL_OBJECT_STORAGE_ATTEMPTS = 3;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_SERVER_ERROR_MIN = 500;
const STORAGE_RETRY_BASE_MS = 250;
const STORAGE_RETRY_EXPONENT_BASE = 2;
const STORAGE_RETRY_MAX_MS = 2_000;
const STORAGE_RETRY_JITTER_MAX_MS = 150;
const AMZ_DATE_STAMP_LENGTH = 8;
const DELETE_OBJECT_TIMEOUT_MS = 10_000;
const HTTP_STATUS_NOT_FOUND = 404;

const MAIL_OBJECT_STORAGE_NOT_CONFIGURED_MESSAGE = "Mail object storage is not configured";

async function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTransientStorageStatus(status: number) {
  return status === HTTP_STATUS_TOO_MANY_REQUESTS || status >= HTTP_STATUS_SERVER_ERROR_MIN;
}

function storageRetryDelayMs(attemptIndex: number) {
  return (
    Math.min(STORAGE_RETRY_BASE_MS * STORAGE_RETRY_EXPONENT_BASE ** attemptIndex, STORAGE_RETRY_MAX_MS) +
    Math.floor(Math.random() * STORAGE_RETRY_JITTER_MAX_MS)
  );
}

function isNonEmptyEnvString(value: string) {
  return value.length > 0;
}

function isObjectStorageConfigured() {
  return (
    isNonEmptyEnvString(apiEnv().MAIL_OBJECT_STORAGE_ENDPOINT) &&
    isNonEmptyEnvString(apiEnv().MAIL_OBJECT_STORAGE_BUCKET) &&
    isNonEmptyEnvString(apiEnv().MAIL_OBJECT_STORAGE_ACCESS_KEY_ID) &&
    isNonEmptyEnvString(apiEnv().MAIL_OBJECT_STORAGE_SECRET_ACCESS_KEY)
  );
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function toDateStamp(amzDate: string) {
  return amzDate.slice(0, AMZ_DATE_STAMP_LENGTH);
}

function sha256Hex(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(input: { key: Buffer | string; value: string }) {
  return createHmac("sha256", input.key).update(input.value).digest();
}

function signingKey(dateStamp: string) {
  const dateKey = hmac({
    key: `AWS4${apiEnv().MAIL_OBJECT_STORAGE_SECRET_ACCESS_KEY}`,
    value: dateStamp,
  });
  const regionKey = hmac({ key: dateKey, value: apiEnv().MAIL_OBJECT_STORAGE_REGION });
  const serviceKey = hmac({ key: regionKey, value: SERVICE });

  return hmac({ key: serviceKey, value: "aws4_request" });
}

function objectUrl(key: string) {
  const endpoint = new URL(apiEnv().MAIL_OBJECT_STORAGE_ENDPOINT);
  const normalizedKey = key.split("/").map(encodeURIComponent).join("/");
  endpoint.pathname = [
    endpoint.pathname.replace(/\/+$/, ""),
    encodeURIComponent(apiEnv().MAIL_OBJECT_STORAGE_BUCKET),
    normalizedKey,
  ]
    .filter(Boolean)
    .join("/");

  return endpoint;
}

function mailObjectStorageWriteFailedMessage(input: { method: string; status: number; payload: string }) {
  return `Mail object storage ${input.method} failed (${input.status}): ${input.payload}`;
}

function mailObjectStorageGetFailedMessage(input: { status: number; detail: string }) {
  return `Mail object storage GET failed (${input.status}): ${input.detail}`;
}

function signedHeaders(input: { method: "DELETE" | "GET" | "PUT"; key: string; body?: Buffer; contentType?: string }) {
  if (!isObjectStorageConfigured()) {
    throw new Error(MAIL_OBJECT_STORAGE_NOT_CONFIGURED_MESSAGE);
  }

  const url = objectUrl(input.key);
  const amzDate = toAmzDate(new Date());
  const dateStamp = toDateStamp(amzDate);
  const payloadHash = sha256Hex(input.body ?? Buffer.alloc(0));
  const contentType = input.contentType ?? "application/octet-stream";
  const canonicalUri = url.pathname.length > 0 ? url.pathname : "/";
  const canonicalQuery = "";
  const canonicalHeaders = `${[`host:${url.host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`].join("\n")}\n`;
  const signedHeaderNames = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${apiEnv().MAIL_OBJECT_STORAGE_REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(dateStamp)).update(stringToSign).digest("hex");
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${apiEnv().MAIL_OBJECT_STORAGE_ACCESS_KEY_ID}/${credentialScope}`,
    `SignedHeaders=${signedHeaderNames}`,
    `Signature=${signature}`,
  ].join(", ");

  return {
    url,
    headers: {
      authorization,
      "content-type": contentType,
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
  };
}

type ObjectStorageStatusWireResult = {
  /** @external mail object storage status wire */
  configured: boolean;
  bucket: string | null;
};

export function objectStorageStatus(): ObjectStorageStatusWireResult {
  const bucket = apiEnv().MAIL_OBJECT_STORAGE_BUCKET;

  return {
    configured: isObjectStorageConfigured(),
    bucket: isNonEmptyEnvString(bucket) ? bucket : null,
  };
}

async function sendStoredObject(input: {
  method: "DELETE" | "PUT";
  url: URL;
  headers: HeadersInit;
  body?: Uint8Array<ArrayBuffer>;
  signal?: AbortSignal;
  success: (response: Response) => boolean;
}) {
  const attempts = Array.from({ length: MAIL_OBJECT_STORAGE_ATTEMPTS }, (_, attempt) => attempt);
  await attempts.reduce(async (previous, attempt) => {
    if (await previous) {
      return true;
    }

    const response = await (async () => {
      try {
        return await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          signal: input.signal,
        });
      } catch (error) {
        if (attempt + 1 < MAIL_OBJECT_STORAGE_ATTEMPTS) {
          await sleep(storageRetryDelayMs(attempt));

          return undefined;
        }

        throw error;
      }
    })();

    if (response === undefined) {
      return false;
    }

    if (input.success(response)) {
      return true;
    }

    const payload = await response.text();
    if (attempt + 1 < MAIL_OBJECT_STORAGE_ATTEMPTS && isTransientStorageStatus(response.status)) {
      await sleep(storageRetryDelayMs(attempt));

      return false;
    }

    throw Object.assign(
      new Error(mailObjectStorageWriteFailedMessage({ method: input.method, status: response.status, payload })),
      {
        status: response.status,
        payload,
      },
    );
  }, Promise.resolve(false));
}

export async function putStoredObject(input: {
  key: string;
  content: string | Buffer;
  contentType?: string;
}): Promise<void> {
  const body = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
  const { url, headers } = signedHeaders({
    method: "PUT",
    key: input.key,
    body,
    contentType: input.contentType ?? "application/octet-stream",
  });
  await sendStoredObject({
    method: "PUT",
    url,
    headers,
    body: new Uint8Array(body),
    success: (response) => response.ok,
  });
}

export async function deleteStoredObject(key: string): Promise<void> {
  const { url, headers } = signedHeaders({ method: "DELETE", key });
  await sendStoredObject({
    method: "DELETE",
    url,
    headers,
    signal: AbortSignal.timeout(DELETE_OBJECT_TIMEOUT_MS),
    success: (response) => response.ok || response.status === HTTP_STATUS_NOT_FOUND,
  });
}

export async function getStoredObjectBuffer(key: string): Promise<Buffer> {
  const { url, headers } = signedHeaders({ method: "GET", key });
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(mailObjectStorageGetFailedMessage({ status: response.status, detail: await response.text() }));
  }

  return Buffer.from(await response.arrayBuffer());
}
