import type { AmbientContextEntityKind } from "@readymeet/shared";
import { createHash } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { repositories } from "../ports/repository-runtime";

import { getStoredObjectBuffer, objectStorageStatus, putStoredObject } from "./object-storage";

type AmbientJsonValue = string | number | boolean | null | AmbientJsonValue[] | { [key: string]: AmbientJsonValue };

const ambientJsonValueSchema: z.ZodType<AmbientJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ambientJsonValueSchema),
    z.record(z.string(), ambientJsonValueSchema),
  ]),
);

const ambientWebManifestIconSchema = z.object({
  src: z.string().optional(),
  purpose: z.string().optional(),
});

const ambientWebManifestSchema = z.object({
  icons: z.array(z.union([z.null(), ambientWebManifestIconSchema])).optional(),
});

const MAX_PAGE_BYTES = 600_000;
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const MAX_IDENTITY_PAGES = 5;
const MAX_COMPANY_IMAGE_CANDIDATES = 5;
const MAX_PERSON_IMAGE_CANDIDATES = 6;
const MAX_MANIFEST_IMAGE_CANDIDATES = 6;
const MAX_MANIFEST_URLS = 2;
const MAX_IMAGE_FETCH_ATTEMPTS = 8;
const MAX_MANIFEST_RESPONSE_BYTES = 200_000;
const EMBEDDED_RECORD_TAIL_BYTES = 4_000;
const MEDIA_FETCH_TIMEOUT_MS = 7_000;
const LOCAL_DIR_MODE = 0o700;
const LOCAL_FILE_MODE = 0o600;
const IP_VERSION_4 = 4;
const IP_VERSION_6 = 6;
const IPV4_OCTET_10 = 10;
const IPV4_OCTET_127 = 127;
const IPV4_OCTET_169 = 169;
const IPV4_OCTET_172 = 172;
const IPV4_OCTET_192 = 192;
const IPV4_OCTET_100 = 100;
const IPV4_OCTET_254 = 254;
const IPV4_OCTET_168 = 168;
const IPV4_PRIVATE_172_MIN = 16;
const IPV4_PRIVATE_172_MAX = 31;
const IPV4_PRIVATE_100_MIN = 64;
const IPV4_PRIVATE_100_MAX = 127;
const IPV4_MULTICAST_MIN = 224;
const HTTP_STATUS_MOVED_PERMANENTLY = 301;
const HTTP_STATUS_FOUND = 302;
const HTTP_STATUS_SEE_OTHER = 303;
const HTTP_STATUS_TEMPORARY_REDIRECT = 307;
const HTTP_STATUS_PERMANENT_REDIRECT = 308;
const AMBIENT_IMAGE_REDIRECT_STATUSES = new Set([
  HTTP_STATUS_MOVED_PERMANENTLY,
  HTTP_STATUS_FOUND,
  HTTP_STATUS_SEE_OTHER,
  HTTP_STATUS_TEMPORARY_REDIRECT,
  HTTP_STATUS_PERMANENT_REDIRECT,
]);
const TOUCH_ICON_SCORE_BONUS = 1_000;
const MAX_LINK_ICON_DIMENSION = 512;
const URL_SCORE_GITHUB = 400;
const URL_SCORE_WIKIPEDIA = 380;
const URL_SCORE_IDENTITY_PATH = 220;
const URL_SCORE_PERSON_PROFILE_PATH = 120;
const MIN_COMPANY_IMAGE_DIMENSION = 16;
const MIN_PERSON_IMAGE_DIMENSION = 32;
const MAX_IMAGE_DIMENSION = 4096;
const PERSON_ASPECT_RATIO_MIN = 0.65;
const PERSON_ASPECT_RATIO_MAX = 1.5;
const ICO_DIMENSION_ZERO_MEANS = 256;
const ICO_DIRECTORY_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_MIN_FRAME_BYTES = 24;
const ICO_MIN_DIB_BYTES = 40;
const ICO_DIB_HEIGHT_MASK_FACTOR = 2;
const ICO_MIN_FILE_BYTES = 22;
const ICO_IMAGE_TYPE_ICON = 1;
const ICO_RESERVED_FIELD_OFFSET = 0;
const ICO_IMAGE_TYPE_OFFSET = 2;
const ICO_ICON_COUNT_OFFSET = 4;
const ICO_OFFSET_WIDTH = 4;
const ICO_OFFSET_HEIGHT = 8;
const ICO_ENTRY_LENGTH_OFFSET = 8;
const ICO_ENTRY_IMAGE_OFFSET = 12;
const JPEG_MIN_SEGMENT_BYTES = 9;
const JPEG_MARKER_BYTE = 0xff;
const JPEG_SEGMENT_LENGTH_BYTES = 2;
const JPEG_DIMENSION_WIDTH_OFFSET = 7;
const JPEG_DIMENSION_HEIGHT_OFFSET = 5;
const JPEG_START_OFFSET = 2;
const JPEG_SOI_BYTE_1 = 0xd8;
const JPEG_MARKER_SOF_0XC0 = 0xc0;
const JPEG_MARKER_SOF_0XC1 = 0xc1;
const JPEG_MARKER_SOF_0XC2 = 0xc2;
const JPEG_MARKER_SOF_0XC3 = 0xc3;
const JPEG_MARKER_SOF_0XC5 = 0xc5;
const JPEG_MARKER_SOF_0XC6 = 0xc6;
const JPEG_MARKER_SOF_0XC7 = 0xc7;
const JPEG_MARKER_SOF_0XC9 = 0xc9;
const JPEG_MARKER_SOF_0XCA = 0xca;
const JPEG_MARKER_SOF_0XCB = 0xcb;
const JPEG_MARKER_SOF_0XCD = 0xcd;
const JPEG_MARKER_SOF_0XCE = 0xce;
const JPEG_MARKER_SOF_0XCF = 0xcf;
const JPEG_SOF_MARKERS = new Set([
  JPEG_MARKER_SOF_0XC0,
  JPEG_MARKER_SOF_0XC1,
  JPEG_MARKER_SOF_0XC2,
  JPEG_MARKER_SOF_0XC3,
  JPEG_MARKER_SOF_0XC5,
  JPEG_MARKER_SOF_0XC6,
  JPEG_MARKER_SOF_0XC7,
  JPEG_MARKER_SOF_0XC9,
  JPEG_MARKER_SOF_0XCA,
  JPEG_MARKER_SOF_0XCB,
  JPEG_MARKER_SOF_0XCD,
  JPEG_MARKER_SOF_0XCE,
  JPEG_MARKER_SOF_0XCF,
]);
const PNG_MIN_BYTES = 24;
const PNG_SIGNATURE_LENGTH = 8;
const PNG_SIGNATURE_BYTE_0 = 137;
const PNG_SIGNATURE_BYTE_1 = 80;
const PNG_SIGNATURE_BYTE_2 = 78;
const PNG_SIGNATURE_BYTE_3 = 71;
const PNG_SIGNATURE_BYTE_4 = 13;
const PNG_SIGNATURE_BYTE_5 = 10;
const PNG_SIGNATURE_BYTE_6 = 26;
const PNG_SIGNATURE_BYTE_7 = 10;
const PNG_SIGNATURE_BYTES = Object.freeze([
  PNG_SIGNATURE_BYTE_0,
  PNG_SIGNATURE_BYTE_1,
  PNG_SIGNATURE_BYTE_2,
  PNG_SIGNATURE_BYTE_3,
  PNG_SIGNATURE_BYTE_4,
  PNG_SIGNATURE_BYTE_5,
  PNG_SIGNATURE_BYTE_6,
  PNG_SIGNATURE_BYTE_7,
]);
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const GIF_MIN_BYTES = 10;
const GIF_HEADER_LENGTH = 6;
const GIF_WIDTH_OFFSET = 6;
const GIF_HEIGHT_OFFSET = 8;
const WEBP_MIN_BYTES = 30;
const WEBP_RIFF_LENGTH = 4;
const WEBP_CHUNK_START = 8;
const WEBP_CHUNK_END = 12;
const WEBP_EXTENDED_START = 12;
const WEBP_EXTENDED_END = 16;
const WEBP_DIMENSION_OFFSET = 24;
const WEBP_DIMENSION_BYTES = 3;
const WEBP_DIMENSION_ADJUSTMENT = 1;
const MESSAGE_INVALID_LOCAL_AMBIENT_CONTEXT_IMAGE_KEY = "Invalid local ambient context image key";
const MESSAGE_OBJECT_STORAGE_NOT_CONFIGURED = "Object storage is not configured for ambient context images";
const MESSAGE_AMBIENT_IMAGE_URL_MUST_BE_PUBLIC_HTTPS = "Ambient image URL must be public HTTPS";
const MESSAGE_AMBIENT_IMAGE_URL_PRIVATE_HOSTNAME = "Ambient image URL targets a private hostname";
const MESSAGE_AMBIENT_IMAGE_URL_NOT_PUBLIC = "Ambient image URL did not resolve to a public address";
const MESSAGE_AMBIENT_IMAGE_REDIRECT_UNSAFE = "Ambient image redirect could not be followed safely";
function ambientMediaExceedsBytesMessage(maxBytes: number): string {
  return ["Ambient media response exceeds ", String(maxBytes), " bytes"].join("");
}

function ambientMediaFetchFailedMessage(status: number): string {
  return ["Ambient media fetch failed (", String(status), ")"].join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.length > 0;
}

type AmbientSafeFetch = (...args: [string, string]) => Promise<{ response: Response; finalUrl: URL }>;

type ScoredLinkHref = { href: string; score: number; index: number };

type ScoredPageUrl = { value: string; score: number; index: number };

function compareByScoreThenIndex<T extends { score: number; index: number }>(left: T, right: T): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  return left.index - right.index;
}

const ICO_IMAGE_TYPES = new Set(["image/x-icon", "image/vnd.microsoft.icon"]);
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", ...ICO_IMAGE_TYPES]);
const LOCAL_STORAGE_PREFIX = "local:";
function localStorageRoot(): string {
  return path.join(tmpdir(), "readymeet-ambient-context");
}

function localAmbientImagePath(storageKey: string) {
  if (!storageKey.startsWith(LOCAL_STORAGE_PREFIX)) {
    return null;
  }
  const relative = storageKey.slice(LOCAL_STORAGE_PREFIX.length);
  const resolved = path.resolve(localStorageRoot(), relative);
  if (!resolved.startsWith(`${path.resolve(localStorageRoot())}${path.sep}`)) {
    throw new Error(MESSAGE_INVALID_LOCAL_AMBIENT_CONTEXT_IMAGE_KEY);
  }

  return resolved;
}

async function storeAmbientContextImageObject(input: { key: string; content: Buffer; mimeType: string }) {
  const ciphertext = await repositories().encryptMeetingObject({
    storageKey: input.key,
    contentBase64: input.content.toString("base64"),
  });
  if (objectStorageStatus().configured) {
    await putStoredObject({ key: input.key, content: ciphertext, contentType: "application/octet-stream" });

    return input.key;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(MESSAGE_OBJECT_STORAGE_NOT_CONFIGURED);
  }
  const storageKey = `${LOCAL_STORAGE_PREFIX}${input.key}`;
  const localPath = localAmbientImagePath(storageKey);
  if (localPath === null) {
    throw new Error(MESSAGE_INVALID_LOCAL_AMBIENT_CONTEXT_IMAGE_KEY);
  }
  await mkdir(path.dirname(localPath), { recursive: true, mode: LOCAL_DIR_MODE });
  await writeFile(localPath, ciphertext, { mode: LOCAL_FILE_MODE });

  return storageKey;
}

export async function readAmbientContextImageObject(storageKey: string): Promise<Buffer> {
  const localPath = localAmbientImagePath(storageKey);

  const stored = localPath !== null ? await readFile(localPath) : await getStoredObjectBuffer(storageKey);
  const plaintext = await repositories().decryptMeetingObject({
    storageKey: storageKey.replace(/^local:/u, ""),
    ciphertext: stored.toString("utf8"),
  });

  return Buffer.from(plaintext, "base64");
}

function isIpv4LinkLocal(octets: number[]): boolean {
  return octets[0] === IPV4_OCTET_169 && octets[1] === IPV4_OCTET_254;
}

function isIpv4Private172(octets: number[]): boolean {
  const secondOctet = octets[1] ?? 0;

  return octets[0] === IPV4_OCTET_172 && secondOctet >= IPV4_PRIVATE_172_MIN && secondOctet <= IPV4_PRIVATE_172_MAX;
}

function isIpv4Private192(octets: number[]): boolean {
  return octets[0] === IPV4_OCTET_192 && octets[1] === IPV4_OCTET_168;
}

function isIpv4CarrierGradeNat(octets: number[]): boolean {
  const secondOctet = octets[1] ?? 0;

  return octets[0] === IPV4_OCTET_100 && secondOctet >= IPV4_PRIVATE_100_MIN && secondOctet <= IPV4_PRIVATE_100_MAX;
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const firstOctet = octets[0] ?? 0;

  return (
    firstOctet === IPV4_OCTET_10 ||
    firstOctet === IPV4_OCTET_127 ||
    firstOctet === 0 ||
    isIpv4LinkLocal(octets) ||
    isIpv4Private172(octets) ||
    isIpv4Private192(octets) ||
    isIpv4CarrierGradeNat(octets) ||
    firstOctet >= IPV4_MULTICAST_MIN
  );
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase();

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

async function cancelUnreadBody(input: {
  body: { cancel: (reason?: string) => Promise<void> } | null | undefined;
  reason?: string;
}) {
  if (input.body === null || input.body === undefined) {
    return;
  }
  try {
    await input.body.cancel(input.reason);
  } catch (error) {
    if (!(error instanceof Error)) {
      return;
    }
  }
}

async function resolvedAddresses(hostname: string) {
  const ipv4 = await (async () => {
    try {
      return await resolve4(hostname);
    } catch (error) {
      if (!(error instanceof Error)) {
        return [] as string[];
      }

      return [] as string[];
    }
  })();
  const ipv6 = await (async () => {
    try {
      return await resolve6(hostname);
    } catch (error) {
      if (!(error instanceof Error)) {
        return [] as string[];
      }

      return [] as string[];
    }
  })();

  return [...ipv4, ...ipv6];
}

function isPublicImageAddress(address: string): boolean {
  const version = isIP(address);

  return version === IP_VERSION_4
    ? !isPrivateIpv4(address)
    : version === IP_VERSION_6
      ? !isPrivateIpv6(address)
      : false;
}

async function assertPublicHttpsUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "https:" || Boolean(url.username) || Boolean(url.password)) {
    throw new Error(MESSAGE_AMBIENT_IMAGE_URL_MUST_BE_PUBLIC_HTTPS);
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw new Error(MESSAGE_AMBIENT_IMAGE_URL_PRIVATE_HOSTNAME);
  }
  const literalVersion = isIP(url.hostname);
  const addresses = literalVersion !== 0 ? [url.hostname] : await resolvedAddresses(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicImageAddress(address))) {
    throw new Error(MESSAGE_AMBIENT_IMAGE_URL_NOT_PUBLIC);
  }

  return url;
}

async function safeFetchNamed(input: {
  value: string;
  accept: string;
}): Promise<{ response: Response; finalUrl: URL }> {
  const follow = async (followInput: {
    url: URL;
    redirect: number;
  }): Promise<{ response: Response; finalUrl: URL }> => {
    const response = await fetch(followInput.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
      headers: { accept: input.accept, "user-agent": "ReadyAmbientContext/1.0" },
    });
    if (AMBIENT_IMAGE_REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await cancelUnreadBody({ body: response.body, reason: "Ambient media redirect body is not consumed" });
      if (location === null || location.length === 0 || followInput.redirect === MAX_REDIRECTS) {
        throw new Error(MESSAGE_AMBIENT_IMAGE_REDIRECT_UNSAFE);
      }

      return follow({
        url: await assertPublicHttpsUrl(new URL(location, followInput.url).toString()),
        redirect: followInput.redirect + 1,
      });
    }
    if (!response.ok) {
      await cancelUnreadBody({ body: response.body, reason: "Ambient media error body is not consumed" });
      throw new Error(ambientMediaFetchFailedMessage(response.status));
    }

    return { response, finalUrl: followInput.url };
  };

  return follow({ url: await assertPublicHttpsUrl(input.value), redirect: 0 });
}

const safeFetch: AmbientSafeFetch = (...args: [string, string]) => safeFetchNamed({ value: args[0], accept: args[1] });

async function readAmbientResponseBufferNamed(input: { response: Response; maxBytes: number }): Promise<Buffer> {
  const declaredByteLength = Number(input.response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredByteLength) && declaredByteLength > input.maxBytes) {
    await cancelUnreadBody({
      body: input.response.body,
      reason: "Ambient media response exceeded its declared byte limit",
    });
    throw new Error(ambientMediaExceedsBytesMessage(input.maxBytes));
  }
  if (input.response.body === null) {
    return Buffer.alloc(0);
  }

  const reader = input.response.body.getReader();
  const readChunks = async (receivedBytes: number): Promise<Uint8Array[]> => {
    const { done: isDone, value } = await reader.read();
    if (isDone) {
      return [];
    }
    const nextBytes = receivedBytes + value.byteLength;
    if (nextBytes > input.maxBytes) {
      await cancelUnreadBody({ body: reader, reason: "Ambient media response exceeded its byte limit" });
      throw new Error(ambientMediaExceedsBytesMessage(input.maxBytes));
    }

    return [value, ...(await readChunks(nextBytes))];
  };
  try {
    const chunks = await readChunks(0);

    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

async function readAmbientResponseBuffer(...args: [Response, number]): Promise<Buffer> {
  return readAmbientResponseBufferNamed({ response: args[0], maxBytes: args[1] });
}

function absoluteCandidate(input: { value: string; base: URL }): string | null {
  try {
    return new URL(
      input.value
        .replace(/&amp;/gi, "&")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003d/gi, "=")
        .replace(/\\\//g, "/"),
      input.base,
    ).toString();
  } catch (error) {
    if (!(error instanceof Error)) {
      return null;
    }

    return null;
  }
}

function normalizedIdentity(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLinkedInHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^www\./, "");

  return (
    normalized === "linkedin.com" ||
    normalized.endsWith(".linkedin.com") ||
    normalized === "licdn.com" ||
    normalized.endsWith(".licdn.com")
  );
}

function normalizedSiteHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isSameSite(input: { left: string; right: string }): boolean {
  const normalizedLeft = normalizedSiteHostname(input.left);
  const normalizedRight = normalizedSiteHostname(input.right);

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`.${normalizedRight}`) ||
    normalizedRight.endsWith(`.${normalizedLeft}`)
  );
}

function htmlTagAttributes(tag: string) {
  return [...tag.matchAll(/\s([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)].reduce<
    Record<string, string>
  >((attributes, match) => {
    const name = match[1];
    if (name === undefined || name.length === 0) {
      return attributes;
    }

    return { ...attributes, [name.toLowerCase()]: match[2] ?? match[3] ?? match[4] ?? "" };
  }, {});
}

function structuredImageValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(structuredImageValues);
  }
  if (!isRecord(value)) {
    return [];
  }

  return [value.url, value.contentUrl].flatMap(structuredImageValues);
}

const JSON_LD_NAMED_PAGE_TYPES = new Set(["Article", "NewsArticle", "ProfilePage", "AboutPage"]);

function jsonLdRecordTypes(record: Record<string, unknown>): string[] {
  return (Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]]).filter(
    (value): value is string => typeof value === "string",
  );
}

function jsonLdRecordDisplayName(record: Record<string, unknown>): string {
  if (typeof record.name === "string") {
    return record.name;
  }
  if (typeof record.headline === "string") {
    return record.headline;
  }

  return "";
}

function isJsonLdNameMatched(input: { recordName: string; identity: string }): boolean {
  if (input.recordName.length === 0) {
    return false;
  }

  return (
    input.recordName === input.identity ||
    input.recordName.includes(input.identity) ||
    input.identity.includes(input.recordName)
  );
}

function jsonLdDirectImageValues(input: {
  record: Record<string, unknown>;
  kind: AmbientContextEntityKind;
  isIdentityRecord: boolean;
  isNamedIdentityPage: boolean;
}): string[] {
  if (!input.isIdentityRecord && !input.isNamedIdentityPage) {
    return [];
  }

  return structuredImageValues(
    input.kind === "company" ? (input.record.logo ?? input.record.image) : input.record.image,
  );
}

function jsonLdImageCandidates(input: {
  value: unknown;
  kind: AmbientContextEntityKind;
  displayName: string;
}): string[] {
  if (Array.isArray(input.value)) {
    return input.value.flatMap((value) => jsonLdImageCandidates({ ...input, value }));
  }
  if (!isRecord(input.value)) {
    return [];
  }
  const record = input.value;
  const types = jsonLdRecordTypes(record);
  const identity = normalizedIdentity(input.displayName);
  const recordName = normalizedIdentity(jsonLdRecordDisplayName(record));
  const isNameMatched = isJsonLdNameMatched({ recordName, identity });
  const expectedType = input.kind === "person" ? "Person" : "Organization";
  const isIdentityRecord = types.includes(expectedType) && isNameMatched;
  const isNamedIdentityPage = types.some((type) => JSON_LD_NAMED_PAGE_TYPES.has(type)) && isNameMatched;
  const direct = jsonLdDirectImageValues({
    record,
    kind: input.kind,
    isIdentityRecord,
    isNamedIdentityPage,
  });

  return [...direct, ...Object.values(record).flatMap((value) => jsonLdImageCandidates({ ...input, value }))];
}

function namedEmbeddedPersonImageCandidates(input: { html: string; displayName: string }): string[] {
  const decoded = input.html
    .replace(/&quot;/gi, '"')
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
  const identity = normalizedIdentity(input.displayName);
  const imageFieldPattern =
    /["'](?:avatarUrl|avatar_url|profileImage|profile_image|headshot|photoUrl|photo_url|imageUrl|image_url)["']\s*:\s*["']([^"']+)["']/gi;
  const imageFields = [...decoded.matchAll(imageFieldPattern)];
  const candidates = imageFields.flatMap((match, index) => {
    if (match[1] === undefined || match[1].length === 0) {
      return [];
    }
    const valueEnd = match.index + match[0].length;
    const nextFieldStart = imageFields[index + 1]?.index ?? decoded.length;
    const recordTail = decoded.slice(valueEnd, Math.min(nextFieldStart, valueEnd + EMBEDDED_RECORD_TAIL_BYTES));
    const recordName = recordTail.match(/["']name["']\s*:\s*["']([^"']+)["']/i)?.[1] ?? "";

    return normalizedIdentity(recordName) === identity ? [match[1]] : [];
  });
  const imageSources = [...decoded.matchAll(/<img\b[^>]*>/gi)].flatMap((tag) => {
    const attributes = htmlTagAttributes(tag[0]);
    if (!normalizedIdentity(attributes.alt ?? "").includes(identity)) {
      return [];
    }
    const source = attributes.src ?? attributes["data-src"] ?? attributes.srcset?.split(/[\s,]/)[0];

    return source !== undefined && source.length !== 0 ? [source] : [];
  });

  return [...candidates, ...imageSources];
}

function parseJsonLdScriptText(text: string): AmbientJsonValue | null {
  try {
    const parsed = ambientJsonValueSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return null;
    }

    return parsed.data;
  } catch (error) {
    // Malformed page metadata is ignored; imagery is optional.
    if (!(error instanceof Error)) {
      return null;
    }

    return null;
  }
}

function jsonLdCandidatesFromHtml(input: {
  html: string;
  kind: AmbientContextEntityKind;
  displayName: string;
}): string[] {
  const jsonLdBlocks = [
    ...input.html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ];

  return jsonLdBlocks.flatMap((block) => {
    const text = block[1]?.trim();
    if (text === undefined || text.length === 0) {
      return [];
    }
    const parsed = parseJsonLdScriptText(text);
    if (parsed === null) {
      return [];
    }

    return jsonLdImageCandidates({
      value: parsed,
      kind: input.kind,
      displayName: input.displayName,
    });
  });
}

function personOpenGraphImageCandidates(input: {
  html: string;
  displayName: string;
  jsonLdCandidates: string[];
  embeddedPersonImages: string[];
}): string[] {
  const personMetadata = [...input.html.matchAll(/<meta\b[^>]*>/gi)].map((tag) => htmlTagAttributes(tag[0]));
  const personMeta = (key: string) =>
    personMetadata.find((attributes) => (attributes.property ?? attributes.name)?.toLowerCase() === key)?.content;
  const ogType = personMeta("og:type")?.toLowerCase();
  const ogImage = personMeta("og:image") ?? personMeta("twitter:image");
  const ogImageAlt = personMeta("og:image:alt") ?? personMeta("twitter:image:alt");
  const normalizedName = input.displayName.toLowerCase().replace(/\s+/g, " ").trim();
  const normalizedAlt = ogImageAlt?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";
  const hasOgImage = ogImage !== undefined && ogImage.length > 0;
  const shouldUseOgImage =
    hasOgImage &&
    (ogType === "profile" ||
      normalizedAlt.includes(normalizedName) ||
      input.jsonLdCandidates.length !== 0 ||
      input.embeddedPersonImages.length !== 0);
  if (!shouldUseOgImage) {
    return input.embeddedPersonImages;
  }

  return [...input.embeddedPersonImages, ogImage];
}

function companyLinkedIconCandidates(html: string): string[] {
  const scored: ScoredLinkHref[] = [...html.matchAll(/<link\b[^>]*>/gi)].flatMap((match, index) => {
    const attributes = htmlTagAttributes(match[0]);
    const rel = (attributes.rel ?? "").toLowerCase().split(/\s+/);
    const href = attributes.href;
    const isTouchIcon = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!isNonEmptyString(href) || (!rel.includes("icon") && !isTouchIcon)) {
      return [];
    }
    const size = Math.max(
      0,
      ...(attributes.sizes ?? "").split(/\s+/).map((value) => {
        const sizeMatch = value.match(/^(\d+)x(\d+)$/i);

        return sizeMatch ? Math.min(Number(sizeMatch[1]), Number(sizeMatch[2]), MAX_LINK_ICON_DIMENSION) : 0;
      }),
    );
    const score = (isTouchIcon ? TOUCH_ICON_SCORE_BONUS : 0) + size;

    return [{ href, score, index }];
  });

  return scored
    .slice()
    .sort(compareByScoreThenIndex)
    .map(({ href }) => href);
}

function ambientIdentityPageImageCandidates(input: {
  html: string;
  pageUrl: URL;
  kind: AmbientContextEntityKind;
  displayName: string;
}): string[] {
  const jsonLdCandidates = jsonLdCandidatesFromHtml(input);
  const embeddedPersonImages =
    input.kind === "person"
      ? namedEmbeddedPersonImageCandidates({ html: input.html, displayName: input.displayName })
      : [];
  const personCandidates =
    input.kind === "person"
      ? personOpenGraphImageCandidates({
          html: input.html,
          displayName: input.displayName,
          jsonLdCandidates,
          embeddedPersonImages,
        })
      : [];
  const linkedIcons = input.kind === "company" ? companyLinkedIconCandidates(input.html) : [];
  const candidates = [
    ...jsonLdCandidates,
    ...personCandidates,
    ...(input.kind === "company" ? [...linkedIcons, "/favicon.ico"] : []),
  ];

  const resolved = [
    ...new Set(
      candidates.flatMap((candidate) => {
        const absolute = absoluteCandidate({ value: candidate, base: input.pageUrl });

        return isNonEmptyString(absolute) ? [absolute] : [];
      }),
    ),
  ];
  if (input.kind === "company") {
    const favicon = new URL("/favicon.ico", input.pageUrl).toString();

    return [...resolved.filter((candidate) => candidate !== favicon).slice(0, MAX_COMPANY_IMAGE_CANDIDATES), favicon];
  }

  return resolved.slice(0, MAX_PERSON_IMAGE_CANDIDATES);
}

function prioritizeAmbientIdentityPageUrls(input: {
  preferredPageUrl: string | null;
  fallbackPageUrls: string[];
  kind: AmbientContextEntityKind;
  displayName: string;
}): string[] {
  const preferred =
    input.preferredPageUrl !== null
      ? (() => {
          try {
            const url = new URL(input.preferredPageUrl);

            return url.protocol === "https:" && !isLinkedInHostname(url.hostname) ? [url.toString()] : [];
          } catch (error) {
            if (!(error instanceof Error)) {
              return [];
            }

            return [];
          }
        })()
      : [];
  const preferredHostname = preferred[0] !== undefined ? new URL(preferred[0]).hostname : null;
  const identityPath = normalizedIdentity(input.displayName).replace(/\s+/g, "-");
  const fallbackScored: ScoredPageUrl[] = [...new Set(input.fallbackPageUrls)].flatMap((value, index) => {
    try {
      const url = new URL(value);
      const isMissingPreferredSite =
        preferredHostname === null || !isSameSite({ left: url.hostname, right: preferredHostname });
      if (
        url.protocol !== "https:" ||
        isLinkedInHostname(url.hostname) ||
        (input.kind === "company" && isMissingPreferredSite)
      ) {
        return [];
      }
      const hostname = url.hostname.toLowerCase();
      const pathname = url.pathname.toLowerCase();
      const score =
        (hostname === "github.com" ? URL_SCORE_GITHUB : 0) +
        (hostname.endsWith(".wikipedia.org") ? URL_SCORE_WIKIPEDIA : 0) +
        (pathname.includes(identityPath) ? URL_SCORE_IDENTITY_PATH : 0) +
        (input.kind === "person" && /\/(?:author|authors|people|person|profile|team)\//.test(pathname)
          ? URL_SCORE_PERSON_PROFILE_PATH
          : 0);

      return [{ value: url.toString(), score, index }];
    } catch (error) {
      if (!(error instanceof Error)) {
        return [];
      }

      return [];
    }
  });
  const fallback = fallbackScored
    .slice()
    .sort(compareByScoreThenIndex)
    .map(({ value }) => value);
  const homepage =
    input.kind === "company" && preferred[0] !== undefined ? [new URL("/", preferred[0]).toString()] : [];

  return [...new Set([...preferred, ...homepage, ...fallback])].slice(0, MAX_IDENTITY_PAGES);
}

function companyManifestUrlsNamed(input: { html: string; pageUrl: URL }): string[] {
  return [
    ...new Set(
      [...input.html.matchAll(/<link\b[^>]*>/gi)].flatMap((match) => {
        const attributes = htmlTagAttributes(match[0]);
        if (!(attributes.rel ?? "").toLowerCase().split(/\s+/).includes("manifest")) {
          return [];
        }
        const absolute = isNonEmptyString(attributes.href)
          ? absoluteCandidate({ value: attributes.href, base: input.pageUrl })
          : null;

        return isNonEmptyString(absolute) ? [absolute] : [];
      }),
    ),
  ].slice(0, MAX_MANIFEST_URLS);
}

function companyManifestUrls(...args: [string, URL]): string[] {
  return companyManifestUrlsNamed({ html: args[0], pageUrl: args[1] });
}

async function manifestImageCandidates(input: { urls: string[]; fetchMedia: AmbientSafeFetch }): Promise<string[]> {
  const candidates = await input.urls.reduce<Promise<string[]>>(async (previous, url) => {
    const collected = await previous;
    try {
      const { response, finalUrl } = await input.fetchMedia(url, "application/manifest+json, application/json");
      const buffer = await readAmbientResponseBuffer(response, MAX_MANIFEST_RESPONSE_BYTES);
      const parsed = ambientWebManifestSchema.safeParse(JSON.parse(buffer.toString("utf8")));
      if (!parsed.success) {
        return collected;
      }

      return [...collected, ...ambientManifestImageCandidates({ value: parsed.data, manifestUrl: finalUrl })];
    } catch (error) {
      // Invalid or unavailable manifests do not block text or other icons.
      if (!(error instanceof Error)) {
        return collected;
      }

      return collected;
    }
  }, Promise.resolve([]));

  return [...new Set(candidates)].slice(0, MAX_MANIFEST_IMAGE_CANDIDATES);
}

function ambientManifestImageCandidates(input: { value: unknown; manifestUrl: URL }): string[] {
  const parsed = ambientWebManifestSchema.safeParse(input.value);
  if (!parsed.success) {
    return [];
  }
  const icons = parsed.data.icons;
  if (icons === undefined) {
    return [];
  }

  return [
    ...new Set(
      icons.flatMap((icon) => {
        if (icon === null || typeof icon.src !== "string") {
          return [];
        }
        const purposes = typeof icon.purpose === "string" ? icon.purpose.toLowerCase().split(/\s+/) : [];
        // Maskable PWA artwork is an application launch icon with a safe-zone,
        // not necessarily the organization's canonical brand mark.
        if (purposes.includes("maskable")) {
          return [];
        }
        const absolute = absoluteCandidate({ value: icon.src, base: input.manifestUrl });

        return isNonEmptyString(absolute) ? [absolute] : [];
      }),
    ),
  ];
}

function icoDimensionByte(raw: number | undefined): number {
  return raw === undefined || raw === 0 ? ICO_DIMENSION_ZERO_MEANS : raw;
}

function icoEntrySize(input: { buffer: Buffer; index: number; directoryEnd: number }) {
  const entry = ICO_DIRECTORY_HEADER_BYTES + input.index * ICO_ENTRY_BYTES;
  const width = icoDimensionByte(input.buffer[entry]);
  const height = icoDimensionByte(input.buffer[entry + 1]);
  const length = input.buffer.readUInt32LE(entry + ICO_ENTRY_LENGTH_OFFSET);
  const offset = input.buffer.readUInt32LE(entry + ICO_ENTRY_IMAGE_OFFSET);
  if (offset < input.directoryEnd || length < ICO_MIN_FRAME_BYTES || offset + length > input.buffer.length) {
    return null;
  }
  const frame = input.buffer.subarray(offset, offset + length);
  const png = imageDimensions({ buffer: frame, mimeType: "image/png" });
  // ICO embeds either a PNG or a DIB whose height includes its transparency mask.
  const isDib =
    frame.length >= ICO_MIN_DIB_BYTES &&
    frame.readUInt32LE(0) >= ICO_MIN_DIB_BYTES &&
    frame.readUInt32LE(0) <= frame.length &&
    frame.readInt32LE(ICO_OFFSET_WIDTH) === width &&
    frame.readInt32LE(ICO_OFFSET_HEIGHT) === height * ICO_DIB_HEIGHT_MASK_FACTOR;
  if (png !== null ? png.width !== width || png.height !== height : !isDib) {
    return null;
  }

  return { width, height };
}

function icoDimensions(buffer: Buffer) {
  if (
    buffer.length < ICO_MIN_FILE_BYTES ||
    buffer.readUInt16LE(ICO_RESERVED_FIELD_OFFSET) !== 0 ||
    buffer.readUInt16LE(ICO_IMAGE_TYPE_OFFSET) !== ICO_IMAGE_TYPE_ICON
  ) {
    return null;
  }
  const count = buffer.readUInt16LE(ICO_ICON_COUNT_OFFSET);
  const directoryEnd = ICO_DIRECTORY_HEADER_BYTES + count * ICO_ENTRY_BYTES;
  if (count === 0 || directoryEnd > buffer.length) {
    return null;
  }
  const entries = Array.from({ length: count }, (_, index) => icoEntrySize({ buffer, index, directoryEnd }));
  if (entries.some((entry) => entry === null)) {
    return null;
  }
  const sized = entries.filter((entry): entry is { width: number; height: number } => entry !== null);
  const first = sized[0];
  if (first === undefined) {
    return null;
  }

  return sized.reduce(
    (largest, entry) => (entry.width * entry.height > largest.width * largest.height ? entry : largest),
    first,
  );
}

function jpegDimensions(input: { buffer: Buffer; offset: number }): { width: number; height: number } | null {
  if (input.offset + JPEG_MIN_SEGMENT_BYTES >= input.buffer.length || input.buffer[input.offset] !== JPEG_MARKER_BYTE) {
    return null;
  }
  const marker = input.buffer[input.offset + 1] ?? 0;
  const length = input.buffer.readUInt16BE(input.offset + JPEG_SEGMENT_LENGTH_BYTES);
  if (JPEG_SOF_MARKERS.has(marker)) {
    return {
      width: input.buffer.readUInt16BE(input.offset + JPEG_DIMENSION_WIDTH_OFFSET),
      height: input.buffer.readUInt16BE(input.offset + JPEG_DIMENSION_HEIGHT_OFFSET),
    };
  }
  if (length < JPEG_SEGMENT_LENGTH_BYTES) {
    return null;
  }

  return jpegDimensions({
    buffer: input.buffer,
    offset: input.offset + JPEG_SEGMENT_LENGTH_BYTES + length,
  });
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length < PNG_MIN_BYTES ||
    !buffer.subarray(0, PNG_SIGNATURE_LENGTH).equals(Buffer.from(PNG_SIGNATURE_BYTES))
  ) {
    return null;
  }

  return { width: buffer.readUInt32BE(PNG_WIDTH_OFFSET), height: buffer.readUInt32BE(PNG_HEIGHT_OFFSET) };
}

function gifDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < GIF_MIN_BYTES || !/^GIF8[79]a$/.test(buffer.toString("ascii", 0, GIF_HEADER_LENGTH))) {
    return null;
  }

  return { width: buffer.readUInt16LE(GIF_WIDTH_OFFSET), height: buffer.readUInt16LE(GIF_HEIGHT_OFFSET) };
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (
    buffer.length < WEBP_MIN_BYTES ||
    buffer.toString("ascii", 0, WEBP_RIFF_LENGTH) !== "RIFF" ||
    buffer.toString("ascii", WEBP_CHUNK_START, WEBP_CHUNK_END) !== "WEBP" ||
    buffer.toString("ascii", WEBP_EXTENDED_START, WEBP_EXTENDED_END) !== "VP8X"
  ) {
    return null;
  }

  return {
    width: WEBP_DIMENSION_ADJUSTMENT + buffer.readUIntLE(WEBP_DIMENSION_OFFSET, WEBP_DIMENSION_BYTES),
    height:
      WEBP_DIMENSION_ADJUSTMENT + buffer.readUIntLE(WEBP_DIMENSION_OFFSET + WEBP_DIMENSION_BYTES, WEBP_DIMENSION_BYTES),
  };
}

function jpegFileDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer[0] !== JPEG_MARKER_BYTE || buffer[1] !== JPEG_SOI_BYTE_1) {
    return null;
  }

  return jpegDimensions({ buffer, offset: JPEG_START_OFFSET });
}

function imageDimensions(input: { buffer: Buffer; mimeType: string }) {
  if (ICO_IMAGE_TYPES.has(input.mimeType)) {
    return icoDimensions(input.buffer);
  }
  if (input.mimeType === "image/png") {
    return pngDimensions(input.buffer);
  }
  if (input.mimeType === "image/gif") {
    return gifDimensions(input.buffer);
  }
  if (input.mimeType === "image/webp") {
    return webpDimensions(input.buffer);
  }
  if (input.mimeType === "image/jpeg") {
    return jpegFileDimensions(input.buffer);
  }

  return null;
}

function hasValidAmbientImageDimensions(input: {
  dimensions: { width: number; height: number };
  kind?: AmbientContextEntityKind;
}): boolean {
  const minDimension = input.kind === "company" ? MIN_COMPANY_IMAGE_DIMENSION : MIN_PERSON_IMAGE_DIMENSION;
  const aspectRatio = input.dimensions.width / input.dimensions.height;

  return (
    input.dimensions.width >= minDimension &&
    input.dimensions.height >= minDimension &&
    input.dimensions.width <= MAX_IMAGE_DIMENSION &&
    input.dimensions.height <= MAX_IMAGE_DIMENSION &&
    (input.kind !== "person" || (aspectRatio >= PERSON_ASPECT_RATIO_MIN && aspectRatio <= PERSON_ASPECT_RATIO_MAX))
  );
}

function ambientImageBufferIsValid(input: {
  content: Buffer;
  mimeType: string;
  declaredByteLength?: number;
  kind?: AmbientContextEntityKind;
}): boolean {
  if (!ALLOWED_IMAGE_TYPES.has(input.mimeType)) {
    return false;
  }
  if ((input.declaredByteLength ?? 0) > MAX_IMAGE_BYTES) {
    return false;
  }
  if (input.content.length === 0 || input.content.length > MAX_IMAGE_BYTES) {
    return false;
  }
  const dimensions = imageDimensions({ buffer: input.content, mimeType: input.mimeType });
  if (dimensions === null) {
    return false;
  }

  return hasValidAmbientImageDimensions({ dimensions, kind: input.kind });
}

type AmbientImageInput = {
  kind: AmbientContextEntityKind;
  verifiedPageUrl: string | null;
  fallbackPageUrls?: string[];
  meetingId: string;
  itemId: string;
  displayName: string;
};

async function loadIdentityPage(input: { pageUrl: string; fetchMedia: AmbientSafeFetch }) {
  const initialUrl = new URL(input.pageUrl);
  try {
    const { response, finalUrl } = await input.fetchMedia(input.pageUrl, "text/html");
    const pageMimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (pageMimeType === "text/html" || pageMimeType === "application/xhtml+xml") {
      return {
        finalPageUrl: finalUrl,
        html: (await readAmbientResponseBuffer(response, MAX_PAGE_BYTES)).toString("utf8"),
      };
    }
    await cancelUnreadBody({ body: response.body });

    return { finalPageUrl: finalUrl, html: "" };
  } catch (error) {
    // A blocked or unavailable page can still serve its public favicon.
    void (error instanceof Error ? error.message : "unavailable identity page");

    return { finalPageUrl: initialUrl, html: "" };
  }
}

async function searchIdentityPages(input: {
  pageUrls: string[];
  ambientInput: AmbientImageInput;
  fetchMedia: AmbientSafeFetch;
}): Promise<{ content: Buffer; mimeType: string } | null> {
  const triedImages = new Set<string>();
  const firstValidAmbientImage = async (candidateInput: {
    candidates: string[];
    attempted: number;
  }): Promise<{ image: { content: Buffer; mimeType: string } | null; attempted: number }> => {
    const [candidate, ...rest] = candidateInput.candidates;
    if (candidate === undefined || candidateInput.attempted >= MAX_IMAGE_FETCH_ATTEMPTS) {
      return { image: null, attempted: candidateInput.attempted };
    }
    if (triedImages.has(candidate)) {
      return firstValidAmbientImage({ candidates: rest, attempted: candidateInput.attempted });
    }
    triedImages.add(candidate);
    const nextAttempted = candidateInput.attempted + 1;
    try {
      const imageResponse = (await input.fetchMedia(candidate, "image/*")).response;
      const headerMime = (imageResponse.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const byteLength = Number(imageResponse.headers.get("content-length") ?? "0");
      const content = await readAmbientResponseBuffer(imageResponse, MAX_IMAGE_BYTES);
      // Many websites serve ICO files as octet-stream or a nonstandard icon MIME.
      const mimeType =
        input.ambientInput.kind === "company" && icoDimensions(content) !== null
          ? "image/vnd.microsoft.icon"
          : headerMime;
      if (
        ambientImageBufferIsValid({
          content,
          mimeType,
          declaredByteLength: byteLength,
          kind: input.ambientInput.kind,
        })
      ) {
        return { image: { content, mimeType }, attempted: nextAttempted };
      }
    } catch (error) {
      // Try the next verified metadata candidate.
      if (!(error instanceof Error)) {
        return firstValidAmbientImage({ candidates: rest, attempted: nextAttempted });
      }
    }

    return firstValidAmbientImage({ candidates: rest, attempted: nextAttempted });
  };
  const searchCandidateGroups = async (groupInput: {
    groups: (() => Promise<string[]>)[];
    attempted: number;
  }): Promise<{ content: Buffer; mimeType: string } | null> => {
    const [getCandidates, ...rest] = groupInput.groups;
    if (getCandidates === undefined) {
      return null;
    }
    const outcome = await firstValidAmbientImage({
      candidates: await getCandidates(),
      attempted: groupInput.attempted,
    });
    if (outcome.image !== null) {
      return outcome.image;
    }

    return searchCandidateGroups({ groups: rest, attempted: outcome.attempted });
  };
  const visitPages = async (urls: string[]): Promise<{ content: Buffer; mimeType: string } | null> => {
    const [pageUrl, ...rest] = urls;
    if (pageUrl === undefined) {
      return null;
    }
    const loaded = await loadIdentityPage({ pageUrl, fetchMedia: input.fetchMedia });
    const candidates = ambientIdentityPageImageCandidates({
      html: loaded.html,
      pageUrl: loaded.finalPageUrl,
      kind: input.ambientInput.kind,
      displayName: input.ambientInput.displayName,
    });
    // Try discovered icons first; a slow manifest must not delay an available logo.
    const image = await searchCandidateGroups({
      groups: [
        async () => candidates,
        async () =>
          input.ambientInput.kind === "company"
            ? manifestImageCandidates({
                urls: companyManifestUrls(loaded.html, loaded.finalPageUrl),
                fetchMedia: input.fetchMedia,
              })
            : [],
      ],
      attempted: 0,
    });
    if (image !== null) {
      return image;
    }

    return visitPages(rest);
  };

  return visitPages(input.pageUrls);
}

async function fetchAmbientContextImage(
  ...args: [AmbientImageInput, AmbientSafeFetch?]
): Promise<{ content: Buffer; mimeType: string } | null> {
  const ambientInput = args[0];
  const fetchMedia = args[1] ?? safeFetch;
  const pageUrls = prioritizeAmbientIdentityPageUrls({
    preferredPageUrl: ambientInput.verifiedPageUrl,
    fallbackPageUrls: ambientInput.fallbackPageUrls ?? [],
    kind: ambientInput.kind,
    displayName: ambientInput.displayName,
  });

  return searchIdentityPages({ pageUrls, ambientInput, fetchMedia });
}

function ambientImageStorageExtension(mimeType: string): string {
  if (ICO_IMAGE_TYPES.has(mimeType)) {
    return "ico";
  }
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  const subtype = mimeType.split("/")[1];
  if (subtype === undefined || subtype.length === 0) {
    return "bin";
  }

  return subtype;
}

export async function enrichAmbientContextImage(
  input: AmbientImageInput,
): Promise<{ storageKey: string; mimeType: string } | null> {
  if (process.env.NODE_ENV === "production" && !objectStorageStatus().configured) {
    return null;
  }
  const image = await fetchAmbientContextImage(input);
  if (image === null) {
    return null;
  }
  const { content, mimeType } = image;
  const hash = createHash("sha256").update(content).digest("hex");
  const extension = ambientImageStorageExtension(mimeType);
  const storageKey = await storeAmbientContextImageObject({
    key: ["ambient-context/", input.meetingId, "/", input.itemId, "/", hash, ".", extension].join(""),
    content,
    mimeType,
  });

  return { storageKey, mimeType };
}
