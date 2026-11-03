import { RpcError } from "livekit-client";

export const OPTIONAL_LIVE_REQUEST_TIMEOUT_MS = 15_000;

const HTTP_SERVER_ERROR_STATUS = 500;
const OPTIONAL_RPC_FAILURE_CODES = [
  RpcError.ErrorCode.CONNECTION_TIMEOUT,
  RpcError.ErrorCode.RESPONSE_TIMEOUT,
  RpcError.ErrorCode.RECIPIENT_DISCONNECTED,
  RpcError.ErrorCode.RECIPIENT_NOT_FOUND,
  RpcError.ErrorCode.SEND_FAILED,
];
const OPTIONAL_FEATURE_FAILURE_LOG = "[readymeet:optional-live-feature] service unavailable.";
const OPTIONAL_REQUEST_TIMEOUT_MESSAGE = "Optional live request timed out.";
const DIAGNOSTIC_ERROR_NAMES = ["Error", "ApiError", "RpcError", "TypeError", "AbortError", "TimeoutError"];

export type OptionalLiveFeature =
  | "assistant"
  | "calendar"
  | "captions"
  | "dial-in"
  | "invitations"
  | "notes"
  | "realtime"
  | "research"
  | "screen-share"
  | "tracker";

export async function withOptionalLiveDeadline<T>(operation: Promise<T>): Promise<T> {
  const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<never>((_resolve, reject) => {
    deadline.timer = setTimeout(() => {
      reject(new DOMException(OPTIONAL_REQUEST_TIMEOUT_MESSAGE, "TimeoutError"));
    }, OPTIONAL_LIVE_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(deadline.timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isOptionalLiveServiceFailure(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  const status = error.status;
  if (typeof status === "number") {
    return status >= HTTP_SERVER_ERROR_STATUS;
  }

  const name = typeof error.name === "string" ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  if (error instanceof RpcError && OPTIONAL_RPC_FAILURE_CODES.some((code) => code === error.code)) {
    return true;
  }

  if (error instanceof TypeError) {
    return /fetch|network|load failed/i.test(error.message);
  }

  return false;
}

export function reportOptionalLiveServiceFailure(input: { error: unknown; feature: OptionalLiveFeature }): boolean {
  if (!isOptionalLiveServiceFailure(input.error)) {
    return false;
  }

  const error = isRecord(input.error) ? input.error : {};
  console.error(OPTIONAL_FEATURE_FAILURE_LOG, {
    feature: input.feature,
    errorName: DIAGNOSTIC_ERROR_NAMES.find((name) => name === error.name) ?? "UnknownError",
    status: typeof error.status === "number" ? error.status : undefined,
  });

  return true;
}

export function reportLiveFeatureRenderFailure(input: { error: unknown; feature: OptionalLiveFeature }): void {
  const error = isRecord(input.error) ? input.error : {};
  console.error(OPTIONAL_FEATURE_FAILURE_LOG, {
    feature: input.feature,
    errorName: DIAGNOSTIC_ERROR_NAMES.find((name) => name === error.name) ?? "UnknownError",
  });
}

const SCREEN_SHARE_STOP_FAILURE_LOG = "[readymeet:optional-live-feature] screen-share stop failed.";

type FailedScreenShareGuardInput = {
  isScreenShareEnabled: () => boolean;
  stopScreenShare: () => Promise<void>;
  /** Subscribes to local track publications and returns the unsubscribe function. */
  onLocalTrackPublished: (listener: () => void) => () => void;
};

/**
 * The screen-share feature owns the Stop sharing control. Once it fails, stop any local share and keep
 * stopping shares that a start already in flight publishes later. Returns the listener cleanup.
 */
export function guardFailedScreenShareFeature(input: FailedScreenShareGuardInput): () => void {
  const stopLocalScreenShare = async () => {
    if (!input.isScreenShareEnabled()) {
      return;
    }
    try {
      await input.stopScreenShare();
    } catch (error) {
      const errorName = isRecord(error) ? error.name : undefined;
      console.error(SCREEN_SHARE_STOP_FAILURE_LOG, {
        errorName: DIAGNOSTIC_ERROR_NAMES.find((name) => name === errorName) ?? "UnknownError",
      });
    }
  };
  void stopLocalScreenShare();

  return input.onLocalTrackPublished(() => {
    void stopLocalScreenShare();
  });
}
