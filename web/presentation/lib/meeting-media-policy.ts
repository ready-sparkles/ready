import { isVideoCodec, type ScalabilityMode, supportsAV1, supportsVP9, type VideoCodec } from "livekit-client";

import {
  cachedProbeEntrySchema,
  type CachedProbeEntrySchemaValue,
  deviceHistorySchema,
  storedNumberSchema,
} from "../../domain/schemas/meeting-media-policy";

import { type MediaTarget, MEETING_MEDIA_CONFIG as config } from "./meeting-media-config";

export type MediaSource = "camera" | "screen";
export type EncodingCost = {
  /** @external MediaCapabilities encoding cost wire field */
  supported: boolean;
  /** @external MediaCapabilities encoding cost wire field */
  smooth: boolean;
  /** @external MediaCapabilities encoding cost wire field */
  powerEfficient: boolean;
};
export type CodecDecision = {
  source: MediaSource;
  codec: VideoCodec;
  target: MediaTarget;
  scalabilityMode?: ScalabilityMode;
  cost: EncodingCost | null;
  reason: string;
  probes?: EncodingProbeResult[];
};
export type MeetingMediaPolicy = { camera: CodecDecision; screen: CodecDecision };
// scalabilityMode is in the W3C Media Capabilities spec, but not TS 5.8's DOM lib.
type EncodingProbe = {
  type: "webrtc";
  video: {
    contentType: string;
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
    scalabilityMode?: ScalabilityMode;
  };
};
export type PolicyEnvironment = {
  codecs: readonly { mimeType: string; scalabilityModes?: readonly string[] }[];
  sdkSupports: (codec: VideoCodec) => boolean;
  encodingInfo?: (configuration: EncodingProbe) => Promise<Partial<EncodingCost>>;
  storage?: Pick<Storage, "getItem" | "setItem">;
  deviceKey: string;
  now: () => number;
};

type DeviceHistory = { cpuLimitedAt: Partial<Record<MediaSource, Partial<Record<VideoCodec, number>>>> };

function readDeviceHistory(env: PolicyEnvironment): DeviceHistory | undefined {
  try {
    const decoded: unknown = JSON.parse(env.storage?.getItem(`${env.deviceKey}history`) ?? "null");
    const validated = deviceHistorySchema.safeParse(decoded);

    return validated.success ? { cpuLimitedAt: validated.data.cpuLimitedAt ?? {} } : undefined;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return undefined;
  }
}

function readCachedProbeEntry(input: {
  env: PolicyEnvironment;
  suffix: string;
}): CachedProbeEntrySchemaValue | undefined {
  try {
    const decoded: unknown = JSON.parse(input.env.storage?.getItem(`${input.env.deviceKey}${input.suffix}`) ?? "null");
    const validated = cachedProbeEntrySchema.safeParse(decoded);

    return validated.success ? validated.data : undefined;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return undefined;
  }
}

function readStoredNumber(input: { env: PolicyEnvironment; suffix: string }): number | undefined {
  try {
    const decoded: unknown = JSON.parse(input.env.storage?.getItem(`${input.env.deviceKey}${input.suffix}`) ?? "null");
    const validated = storedNumberSchema.safeParse(decoded);

    return validated.success ? validated.data : undefined;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return undefined;
  }
}
function write(input: { env: PolicyEnvironment; suffix: string; value: unknown }): void {
  try {
    input.env.storage?.setItem(`${input.env.deviceKey}${input.suffix}`, JSON.stringify(input.value));
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    /* private browsing / quota */
  }
}

/** Browser-local observations are temporary, not permanent device blacklists. */
function recentCpuHistory(env: PolicyEnvironment): DeviceHistory["cpuLimitedAt"] {
  const stored = readDeviceHistory(env);
  const cpuLimitedAt = stored?.cpuLimitedAt;

  return (["camera", "screen"] as const).reduce<DeviceHistory["cpuLimitedAt"]>((result, source) => {
    const entries = cpuLimitedAt?.[source];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return result;
    }
    const kept = Object.entries(entries).reduce<Partial<Record<VideoCodec, number>>>((codecs, [codec, at]) => {
      if (
        isVideoCodec(codec) &&
        typeof at === "number" &&
        Number.isFinite(at) &&
        at <= env.now() &&
        env.now() - at < config.capability.cpuHistoryMaxAgeMs
      ) {
        return { ...codecs, [codec]: at };
      }

      return codecs;
    }, {});
    if (Object.keys(kept).length === 0) {
      return result;
    }

    return { ...result, [source]: kept };
  }, {});
}

function browserPolicyEnvironment(): PolicyEnvironment {
  const storage = (() => {
    try {
      return globalThis.localStorage;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      return undefined;
    }
  })();
  const codecs = ((): PolicyEnvironment["codecs"] => {
    try {
      const rtpGlobals: { RTCRtpSender?: typeof globalThis.RTCRtpSender } = globalThis;

      return rtpGlobals.RTCRtpSender?.getCapabilities("video")?.codecs ?? [];
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      return [];
    }
  })();
  const nav = typeof navigator === "undefined" ? undefined : navigator;

  // localStorage already scopes this to one browser profile on one device. UA
  // invalidates on browser updates; no camera labels/IDs leave the browser.
  return {
    codecs,
    storage,
    deviceKey: `${config.storagePrefix}${config.capability.version}:${nav?.userAgent ?? "unknown"}:`,
    now: Date.now,
    sdkSupports: (codec) => {
      try {
        return codec === "av1" ? supportsAV1() : codec === "vp9" ? supportsVP9() : true;
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }

        return false;
      }
    },
    // mediaCapabilities is absent in insecure contexts and some embedded browsers.
    encodingInfo:
      nav !== undefined && "mediaCapabilities" in nav
        ? (value) => nav.mediaCapabilities.encodingInfo(value)
        : undefined,
  };
}

export type EncodingProbeResult = {
  codec: VideoCodec;
  target: MediaTarget;
  scalabilityMode?: ScalabilityMode;
  status: "complete" | "api-missing" | "incomplete" | "rejected" | "timeout" | "skipped-after-timeout";
  /** @external encoding probe wire field */
  cached: boolean;
  cost: EncodingCost | null;
  reported?: Partial<EncodingCost>;
};

// Reuse the ordinary browser environment across acquisition, room creation and
// device-picker calls. Explicit environments keep developer probes/test runs isolated.
const meetingEnvironmentState: { current?: PolicyEnvironment } = {};
function defaultEnvironment(): PolicyEnvironment {
  const current = meetingEnvironmentState.current ?? browserPolicyEnvironment();
  meetingEnvironmentState.current = current;

  return current;
}

type CachedProbe = { at: number; result: EncodingProbeResult };

function isPolicyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEncodingCostValue(value: unknown): value is EncodingCost {
  if (!isPolicyRecord(value)) {
    return false;
  }

  return (
    typeof value.supported === "boolean" &&
    typeof value.smooth === "boolean" &&
    typeof value.powerEfficient === "boolean"
  );
}

function isEncodingProbeResult(value: unknown): value is EncodingProbeResult {
  if (!isPolicyRecord(value)) {
    return false;
  }
  if (typeof value.codec !== "string" || typeof value.status !== "string" || typeof value.cached !== "boolean") {
    return false;
  }
  const cost = value.cost;
  if (cost !== null && cost !== undefined && !isEncodingCostValue(cost)) {
    return false;
  }

  return true;
}

function parseCachedProbe(value: unknown): CachedProbe | undefined {
  if (!isPolicyRecord(value)) {
    return undefined;
  }
  const at = value.at;
  const result = value.result;
  if (typeof at !== "number" || !Number.isFinite(at) || !isEncodingProbeResult(result)) {
    return undefined;
  }

  return { at, result };
}
type ProbeState = {
  completed: Map<string, CachedProbe>;
  pending: Map<string, Promise<EncodingProbeResult>>;
  timeouts: Map<VideoCodec, number>;
};
const probeStates = new WeakMap<PolicyEnvironment, ProbeState>();
function probeState(env: PolicyEnvironment) {
  const existing = probeStates.get(env);
  if (existing) {
    return existing;
  }
  const state: ProbeState = {
    completed: new Map<string, CachedProbe>(),
    pending: new Map<string, Promise<EncodingProbeResult>>(),
    timeouts: new Map<VideoCodec, number>(),
  };
  probeStates.set(env, state);

  return state;
}
function fresh(input: { at: number; lifetime: number; env: PolicyEnvironment }) {
  const { at, lifetime, env } = input;

  return Number.isFinite(at) && env.now() >= at && env.now() - at < lifetime;
}

function pickEncodingCostFields(reported: Partial<EncodingCost>): Partial<EncodingCost> {
  const picked: Partial<EncodingCost> = {};
  if (typeof reported.supported === "boolean") {
    picked.supported = reported.supported;
  }
  if (typeof reported.smooth === "boolean") {
    picked.smooth = reported.smooth;
  }
  if (typeof reported.powerEfficient === "boolean") {
    picked.powerEfficient = reported.powerEfficient;
  }

  return picked;
}

function isCompleteEncodingProbe(result: EncodingProbeResult): boolean {
  const cost = result.cost;

  return (
    result.status === "complete" &&
    cost !== null &&
    typeof cost.supported === "boolean" &&
    typeof cost.smooth === "boolean" &&
    typeof cost.powerEfficient === "boolean"
  );
}

function isUnknownEncodingProbe(result: EncodingProbeResult): boolean {
  return ["api-missing", "incomplete", "rejected", "timeout"].includes(result.status) && result.cost === null;
}

function freshCachedEncodingProbe(input: {
  env: PolicyEnvironment;
  cached: CachedProbe;
  isComplete: boolean;
}): EncodingProbeResult | undefined {
  const { env, cached, isComplete } = input;
  const result = cached.result;
  const isFreshEntry = fresh({
    at: cached.at,
    lifetime: isComplete ? config.capability.cacheMaxAgeMs : config.capability.unknownCacheMaxAgeMs,
    env,
  });
  if (!isFreshEntry) {
    return undefined;
  }
  if (!isComplete && !isUnknownEncodingProbe(result)) {
    return undefined;
  }

  return result;
}

async function runEncodingProbeRace(input: {
  env: PolicyEnvironment;
  codec: VideoCodec;
  target: MediaTarget;
  mode?: ScalabilityMode;
  base: Omit<EncodingProbeResult, "status">;
  state: ProbeState;
  timeoutKey: string;
}): Promise<EncodingProbeResult> {
  const { env, codec, target, mode, base, state, timeoutKey } = input;
  if (!env.encodingInfo) {
    return { ...base, status: "api-missing" };
  }
  const timer: { current?: ReturnType<typeof setTimeout> } = {};
  try {
    const reportedResult = await Promise.race([
      env.encodingInfo({
        type: "webrtc",
        video: {
          contentType: `video/${codec.toUpperCase()}`,
          width: target.width,
          height: target.height,
          bitrate: target.maxBitrate,
          framerate: target.frameRate,
          scalabilityMode: mode,
        },
      }),
      new Promise<null>((resolve) => {
        timer.current = setTimeout(() => {
          const at = env.now();
          state.timeouts.set(codec, at);
          write({ env, suffix: timeoutKey, value: at });
          resolve(null);
        }, config.capability.timeoutMs);
      }),
    ]);
    if (!reportedResult) {
      return { ...base, status: "timeout" };
    }
    const reported = pickEncodingCostFields(reportedResult);
    if (
      typeof reported.supported !== "boolean" ||
      typeof reported.smooth !== "boolean" ||
      typeof reported.powerEfficient !== "boolean"
    ) {
      return { ...base, status: "incomplete", reported };
    }
    const cost: EncodingCost = {
      supported: reported.supported,
      smooth: reported.smooth,
      powerEfficient: reported.powerEfficient,
    };

    return { ...base, status: "complete", cost, reported };
  } catch (error) {
    if (error instanceof Error || error !== undefined) {
      return { ...base, status: "rejected" };
    }
    throw error;
  } finally {
    clearTimeout(timer.current);
  }
}

async function probeEncodingCostNamed(input: {
  env: PolicyEnvironment;
  codec: VideoCodec;
  target: MediaTarget;
  mode?: ScalabilityMode;
}): Promise<EncodingProbeResult> {
  const { env, codec, target, mode } = input;
  const base = {
    codec,
    target,
    scalabilityMode: mode,
    /** @external encoding probe wire field */
    cached: false,
    cost: null,
  };
  const key = `probe:${codec}:${target.width}:${target.height}:${target.frameRate}:${target.maxBitrate}:${mode ?? ""}`;
  const state = probeState(env);
  const cached = state.completed.get(key) ?? parseCachedProbe(readCachedProbeEntry({ env, suffix: key }));
  if (cached !== undefined) {
    const isProbeComplete = isCompleteEncodingProbe(cached.result);
    const cachedResult = freshCachedEncodingProbe({ env, cached, isComplete: isProbeComplete });
    if (cachedResult !== undefined) {
      return {
        ...base,
        status: cachedResult.status,
        cost: cachedResult.cost,
        reported: cachedResult.reported,
        /** @external encoding probe wire field */
        cached: true,
      };
    }
  }
  const pending = state.pending.get(key);
  if (pending) {
    return pending;
  }
  // A speculative lower-priority probe must not suppress working codecs after
  // selection has returned. Still bound repeated hangs across resolution tiers.
  const timeoutKey = `probe-timeout:${codec}`;
  const timeoutAt = state.timeouts.get(codec) ?? readStoredNumber({ env, suffix: timeoutKey });
  if (timeoutAt !== undefined && fresh({ at: timeoutAt, lifetime: config.capability.unknownCacheMaxAgeMs, env })) {
    return {
      ...base,
      status: "skipped-after-timeout",
      /** @external encoding probe wire field */
      cached: true,
    };
  }
  const work = (async () => {
    try {
      const result = await runEncodingProbeRace({ env, codec, target, mode, base, state, timeoutKey });
      const entry = { at: env.now(), result };
      state.completed.set(key, entry);
      write({ env, suffix: key, value: entry });

      return result;
    } finally {
      state.pending.delete(key);
    }
  })();
  state.pending.set(key, work);

  return work;
}

export async function probeEncodingCost(
  ...args: [env: PolicyEnvironment, codec: VideoCodec, target: MediaTarget, mode?: ScalabilityMode]
): Promise<EncodingProbeResult> {
  const [env, codec, target, mode] = args;

  return probeEncodingCostNamed({ env, codec, target, mode });
}

type CodecCandidate = {
  codec: VideoCodec;
  mode?: ScalabilityMode;
  capability: PolicyEnvironment["codecs"][number];
};

type CodecSearch = { reasons: string[]; probes: EncodingProbeResult[]; decision?: CodecDecision };

function evaluateCodecOrder(input: {
  env: PolicyEnvironment;
  settings: (typeof config)[MediaSource];
  cpuCodecs: string[];
}): { reasons: string[]; candidates: CodecCandidate[] } {
  const { env, settings, cpuCodecs } = input;

  return settings.codecOrder.reduce<{ reasons: string[]; candidates: CodecCandidate[] }>(
    (state, codec) => {
      const capability = env.codecs.find((entry) => entry.mimeType.toLowerCase() === `video/${codec}`);
      if (!capability || !env.sdkSupports(codec)) {
        return { ...state, reasons: [...state.reasons, `${codec}: unavailable in browser/SDK`] };
      }
      const mode = codec === "av1" || codec === "vp9" ? settings.scalabilityMode : undefined;
      if (
        mode !== undefined &&
        capability.scalabilityModes !== undefined &&
        !capability.scalabilityModes.includes(mode)
      ) {
        return { ...state, reasons: [...state.reasons, `${codec}: ${mode} unavailable`] };
      }
      if (cpuCodecs.includes(codec) && (codec === "av1" || codec === "vp9")) {
        return { ...state, reasons: [...state.reasons, `${codec}: sustained CPU limitation on a previous call`] };
      }

      return { ...state, candidates: [...state.candidates, { codec, mode, capability }] };
    },
    { reasons: [], candidates: [] },
  );
}

function mediaTargetsForSource(input: { source: MediaSource; cpuCodecs: string[] }): MediaTarget[] {
  const { source, cpuCodecs } = input;
  if (source === "camera") {
    return [
      ...(cpuCodecs.length < config.camera.cpuHistoryConstrainedCodecCount ? [config.camera.efficient] : []),
      config.camera.constrained,
    ];
  }

  return [...(cpuCodecs.length === 0 ? [config.screen.full] : []), config.screen.constrained];
}

function probeCostRejectionReason(input: {
  source: MediaSource;
  target: MediaTarget;
  item: CodecCandidate;
  result: EncodingProbeResult;
  at: string;
}): string | undefined {
  const { source, target, item, result, at } = input;
  const cost = result.cost;
  if (cost && (!cost.supported || !cost.smooth)) {
    return `${item.codec}: target unsupported or not smooth ${at}`;
  }
  if (!cost && ((source === "screen" && target === config.screen.full) || item.codec === "av1")) {
    return `${item.codec}: encoding performance unknown (${result.status}) ${at}`;
  }
  if (
    source === "camera" &&
    cost &&
    !cost.powerEfficient &&
    !config.camera.isSmoothSoftwareEncodingAllowed &&
    item.codec === "av1"
  ) {
    return `${item.codec}: software encoding disabled by policy ${at}`;
  }

  return undefined;
}

function probeSvcRejectionReason(input: {
  item: CodecCandidate;
  result: EncodingProbeResult;
  at: string;
}): string | undefined {
  const { item, result, at } = input;
  const cost = result.cost;
  if (item.mode !== undefined && cost === null && !(item.capability.scalabilityModes?.includes(item.mode) ?? false)) {
    return `${item.codec}: SVC capability unverified ${at}`;
  }

  return undefined;
}

function probeRejectionReason(input: {
  source: MediaSource;
  target: MediaTarget;
  item: CodecCandidate;
  result: EncodingProbeResult;
  at: string;
}): string | undefined {
  return (
    probeCostRejectionReason(input) ?? probeSvcRejectionReason({ item: input.item, result: input.result, at: input.at })
  );
}

function codecDecisionFromProbe(input: {
  source: MediaSource;
  target: MediaTarget;
  item: CodecCandidate;
  current: CodecSearch;
  result: EncodingProbeResult;
  at: string;
}): CodecDecision {
  const { source, target, item, current, result, at } = input;
  const cost = result.cost;
  const probes = [...current.probes, result];

  return {
    source,
    codec: item.codec,
    target,
    scalabilityMode: item.mode,
    cost,
    probes,
    reason: [
      ...current.reasons,
      `${item.codec}: ${cost ? `supported, smooth, powerEfficient=${cost.powerEfficient}` : "RTP capability; encode cost unknown"} ${at}${item.mode !== undefined ? ` ${item.mode}` : ""}`,
    ].join("; "),
  };
}

function codecSearchFromProbe(input: {
  source: MediaSource;
  target: MediaTarget;
  item: CodecCandidate;
  current: CodecSearch;
  result: EncodingProbeResult;
}): CodecSearch {
  const { source, target, item, current, result } = input;
  const probes = [...current.probes, result];
  const at = `at ${target.width}x${target.height}@${target.frameRate}`;
  const rejection = probeRejectionReason({ source, target, item, result, at });
  if (rejection !== undefined) {
    return { reasons: [...current.reasons, rejection], probes };
  }

  return {
    reasons: current.reasons,
    probes,
    decision: codecDecisionFromProbe({ source, target, item, current, result, at }),
  };
}

async function searchCodecAtTarget(input: {
  source: MediaSource;
  env: PolicyEnvironment;
  target: MediaTarget;
  candidates: CodecCandidate[];
  state: CodecSearch;
}): Promise<CodecSearch> {
  const { source, env, target, candidates, state } = input;
  if (state.decision) {
    return state;
  }
  const batch = candidates.map((candidate) => ({
    ...candidate,
    result: probeEncodingCostNamed({ env, codec: candidate.codec, target, mode: candidate.mode }),
  }));

  return batch.reduce<Promise<CodecSearch>>(async (batchPrevious, item) => {
    const current = await batchPrevious;
    if (current.decision) {
      return current;
    }
    const result = await item.result;

    return codecSearchFromProbe({ source, target, item, current, result });
  }, Promise.resolve(state));
}

async function selectCodecNamed(input: { source: MediaSource; env: PolicyEnvironment }): Promise<CodecDecision> {
  const { source, env } = input;
  const cpuCodecs = Object.keys(recentCpuHistory(env)[source] ?? {});
  const settings = config[source];
  const evaluated = evaluateCodecOrder({ env, settings, cpuCodecs });
  const targets = mediaTargetsForSource({ source, cpuCodecs });
  // Preserve resolution with another smooth codec before reducing the capture
  // budget. Codec order only breaks ties within the same resolution tier.
  // Each tier's probe wave starts synchronously once the previous tier settles (the first one immediately),
  // so concurrent selections share in-flight probes.
  const searchFromTarget = async (search: { index: number; state: CodecSearch }): Promise<CodecSearch> => {
    const { index, state } = search;
    const target = targets[index];
    if (target === undefined || state.decision !== undefined) {
      return state;
    }
    const next = await searchCodecAtTarget({ source, env, target, candidates: evaluated.candidates, state });

    return searchFromTarget({ index: index + 1, state: next });
  };
  const searched = await searchFromTarget({ index: 0, state: { reasons: evaluated.reasons, probes: [] } });
  if (searched.decision) {
    return searched.decision;
  }
  const { probes, reasons } = searched;
  const fallbackTarget =
    probes.length !== 0
      ? settings.constrained
      : source === "camera" && cpuCodecs.length < config.camera.cpuHistoryConstrainedCodecCount
        ? config.camera.efficient
        : settings.constrained;

  // Baseline codec remains usable when the capability API itself is absent.
  // Exhausted probes must not restore a higher target that was already rejected.
  return {
    source,
    codec: config.backup.codec,
    target: fallbackTarget,
    cost: null,
    probes,
    reason: `${reasons.join("; ")}; conservative VP8 fallback`,
  };
}

export async function selectCodec(...args: [source: MediaSource, env: PolicyEnvironment]): Promise<CodecDecision> {
  const [source, env] = args;

  return selectCodecNamed({ source, env });
}

export async function selectMeetingMediaPolicy(env = defaultEnvironment()): Promise<MeetingMediaPolicy> {
  const [camera, screen] = await Promise.all([selectCodec("camera", env), selectCodec("screen", env)]);
  write({ env, suffix: "last-selection", value: { at: env.now(), camera, screen } });

  return { camera, screen };
}

/** Only changes the NEXT join; SDK congestion control owns the current call. */
export function rememberCpuLimitation(
  ...args: [source: MediaSource, codec: VideoCodec, env?: PolicyEnvironment]
): void {
  const [source, codec, env = defaultEnvironment()] = args;
  const cpuLimitedAt = recentCpuHistory(env);
  write({
    env,
    suffix: "history",
    value: {
      cpuLimitedAt: { ...cpuLimitedAt, [source]: { ...cpuLimitedAt[source], [codec]: env.now() } },
    },
  });
}
