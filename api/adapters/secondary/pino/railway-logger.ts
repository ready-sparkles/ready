import { isPublicContentKeyConfigMessage } from "@readymeet/db/domain/content-key-errors";
import pino, { type DestinationStream, type Logger } from "pino";

const PRIVATE_ERROR_MESSAGE = "Operation failed; private error details omitted.";
const CONTENT_KEY_CONFIG_ERROR_NAME = "MeetingContentKeyConfigError";
const CONTENT_KEY_CONFIG_ERROR_CODE = "MEETING_CONTENT_KEYS_UNCONFIGURED";
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "PrismaClientKnownRequestError",
  "PrismaClientInitializationError",
  CONTENT_KEY_CONFIG_ERROR_NAME,
]);
const SAFE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "57P01",
  "53300",
  "57014",
  "55P03",
  "40001",
  "40P01",
  "RM402",
  "P1000",
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2002",
  "P2024",
  "P2025",
  "P2028",
  CONTENT_KEY_CONFIG_ERROR_CODE,
]);
function safeError(error: unknown) {
  const name: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "name") : undefined;
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  const message: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
  const isKeyConfig =
    name === CONTENT_KEY_CONFIG_ERROR_NAME &&
    code === CONTENT_KEY_CONFIG_ERROR_CODE &&
    typeof message === "string" &&
    isPublicContentKeyConfigMessage(message);

  return {
    message: isKeyConfig ? message : PRIVATE_ERROR_MESSAGE,
    ...(typeof name === "string" && SAFE_ERROR_NAMES.has(name) ? { name } : {}),
    ...(typeof code === "string" && SAFE_ERROR_CODES.has(code) ? { code } : {}),
  };
}

type RailwayLoggerStreams = {
  stdout?: DestinationStream;
  stderr?: DestinationStream;
};

/**
 * Railway derives severity from the container stream. Keep routine request and
 * worker logs on stdout, while warnings and errors go to stderr. `dedupe`
 * prevents warning/error records from also being written to the info stream.
 * Errors are logged under both `err` and `error`; serialize both, because
 * pino would otherwise print an Error's non-enumerable message as `{}`.
 */
export function createRailwayLogger(streams: RailwayLoggerStreams = {}): Logger {
  return pino(
    {
      level: "info",
      serializers: { err: safeError, error: safeError },
      redact: {
        paths: [
          "transcript",
          "finalTranscript",
          "query",
          "content",
          "payload",
          "result",
          "summary",
          "title",
          "text",
          "rawInput",
          "*.transcript",
          "*.query",
          "*.content",
          "*.payload",
          "*.result",
        ],
        censor: "[private content omitted]",
      },
    },
    pino.multistream(
      [
        { level: "info", stream: streams.stdout ?? process.stdout },
        { level: "warn", stream: streams.stderr ?? process.stderr },
      ],
      { dedupe: true },
    ),
  );
}
