import {
  type AudioCaptureOptions,
  compareVersions,
  createLocalTracks,
  createLocalVideoTrack,
  getBrowser,
  type LocalParticipant,
  type LocalTrack,
  type LocalTrackPublication,
  LocalVideoTrack,
  Room,
  RoomEvent,
  type ScreenShareCaptureOptions,
  Track,
  TrackEvent,
  type TrackPublishDefaults,
  type VideoCaptureOptions,
  VideoPreset,
} from "livekit-client";

import { setLocalVideoTrackBackgroundBlur } from "./background-blur";
import { MEETING_MEDIA_CONFIG as config } from "./meeting-media-config";
import { type MediaHealthReporter, startMeetingMediaDiagnostics } from "./meeting-media-diagnostics";
import { type CodecDecision, type MeetingMediaPolicy, selectMeetingMediaPolicy } from "./meeting-media-policy";
import { captureCaps, getMeetingCaptureTrack } from "./meeting-media-track";

/** Published audio must remain controllable while camera processing is still starting. */
export function isMeetingMicrophoneControlDisabled(input: {
  room: Pick<Room, "localParticipant"> | null;
  isBusy: boolean;
}): boolean {
  return !input.room || (input.isBusy && !input.room.localParticipant.getTrackPublication(Track.Source.Microphone));
}

const CAMERA_REQUIRES_LOCAL_TRACK = "Background blur requires a prepared camera track.";
const CAMERA_START_CANCELLED = "Camera startup cancelled";

export class MeetingCameraStartCancelledError extends Error {
  constructor() {
    super(CAMERA_START_CANCELLED);
    this.name = "MeetingCameraStartCancelledError";
  }
}
const pendingCameras = new WeakMap<object, { track?: LocalTrack | MediaStreamTrack }>();

export function getMeetingCameraTrack(participant: LocalParticipant): LocalVideoTrack | undefined {
  const track = participant.getTrackPublication(Track.Source.Camera)?.track ?? pendingCameras.get(participant)?.track;

  return track instanceof LocalVideoTrack ? track : undefined;
}

export function isMeetingCameraStarting(participant: object): boolean {
  return pendingCameras.has(participant);
}

export function cancelMeetingCameraStart(participant: object): void {
  const pending = pendingCameras.get(participant);
  if (pending) {
    pending.track?.stop();
    pendingCameras.delete(participant);
  }
}

function beginMeetingCameraStart(participant: object) {
  cancelMeetingCameraStart(participant);
  const pending: { track?: LocalTrack | MediaStreamTrack } = {};
  pendingCameras.set(participant, pending);

  return pending;
}

async function publishPreparedMeetingCamera(input: {
  participant: LocalParticipant;
  track: LocalTrack | MediaStreamTrack;
  pending: ReturnType<typeof beginMeetingCameraStart>;
}): Promise<LocalTrackPublication> {
  const { participant, track, pending } = input;
  pending.track = track;
  try {
    if (pendingCameras.get(participant) !== pending) {
      throw new MeetingCameraStartCancelledError();
    }
    await prepareMeetingCameraForPublish(participant, track);
    if (pendingCameras.get(participant) !== pending) {
      throw new MeetingCameraStartCancelledError();
    }
    const publication = await participant.publishTrack(track, { source: Track.Source.Camera });
    if (pendingCameras.get(participant) !== pending) {
      await participant.unpublishTrack(track);
      throw new MeetingCameraStartCancelledError();
    }

    return publication;
  } catch (error) {
    track.stop();
    if (pendingCameras.get(participant) !== pending) {
      throw new MeetingCameraStartCancelledError();
    }
    throw error;
  } finally {
    if (pendingCameras.get(participant) === pending) {
      pendingCameras.delete(participant);
    }
  }
}

export async function publishMeetingCamera(
  ...args: [participant: LocalParticipant, track: LocalTrack | MediaStreamTrack]
): Promise<LocalTrackPublication> {
  const [participant, track] = args;

  return publishPreparedMeetingCamera({ participant, track, pending: beginMeetingCameraStart(participant) });
}

const cameraBlurPreferences = new WeakMap<object, Promise<boolean>>();

export function setMeetingCameraBlurPreference(...args: [participant: object, enabled: Promise<boolean>]): void {
  const [participant, enabled] = args;
  cameraBlurPreferences.set(participant, enabled);
}

const participantPolicies = new WeakMap<object, MeetingMediaPolicy>();

export async function createMeetingRoom(input: {
  audioDeviceId?: string;
  videoDeviceId?: string;
  reportMediaHealth?: MediaHealthReporter;
}): Promise<Room> {
  const policy = await selectMeetingMediaPolicy();
  const room = new Room({
    singlePeerConnection: config.transport.singlePeerConnection,
    adaptiveStream: config.adaptiveStream,
    dynacast: true,
    audioCaptureDefaults: getMeetingAudioCaptureOptions(input.audioDeviceId),
    videoCaptureDefaults: getMeetingCameraCaptureOptions(input.videoDeviceId, policy.camera),
    publishDefaults: getMeetingPublishDefaults(policy.camera),
  });
  participantPolicies.set(room.localParticipant, policy);
  room.once(RoomEvent.Disconnected, () => cancelMeetingCameraStart(room.localParticipant));
  const watched = new WeakSet<LocalVideoTrack>();
  room.on(RoomEvent.LocalTrackPublished, (publication) => {
    const track = publication.track;
    if (!(track instanceof LocalVideoTrack) || watched.has(track)) {
      return;
    }
    if (track.source === Track.Source.ScreenShare) {
      watched.add(track);
      // getDisplayMedia resolution constraints are broken on Safari 17 / iOS
      // WebKit. Match the SDK workaround, but still bound the capture cadence.
      if (usesSafariScreenResolutionWorkaround()) {
        void (async () => {
          try {
            await track.mediaStreamTrack.applyConstraints({ frameRate: { max: policy.screen.target.frameRate } });
          } catch (error) {
            console.error("[ready:media] Screen frame-rate cap unavailable.", error);
          }
        })();
      }

      return;
    }
    if (track.source !== Track.Source.Camera) {
      return;
    }
    watched.add(track);
    const enforce = () => {
      void (async () => {
        try {
          await constrainMeetingCameraNamed({ track, decision: policy.camera });
        } catch (error) {
          console.error("[ready:media] Camera capture cap could not be applied.", error);
        }
      })();
    };
    // Reacquisition on unmute and device switches emits Restarted. Reconnect
    // republishes the same LocalTrack with its saved publication options.
    track.on(TrackEvent.Restarted, enforce);
    // stopProcessor (blur off, processor switch or fallback) re-applies the SDK's
    // own constraints to the same capture, dropping the cap. Restore it only when
    // loosened, so tighter in-call recovery caps are left alone.
    track.on(TrackEvent.TrackProcessorUpdate, () => {
      const caps = captureCaps(getMeetingCaptureTrack(track).getConstraints());
      const { width, height, frameRate } = policy.camera.target;
      if (caps.long > Math.max(width, height) || caps.short > Math.min(width, height) || caps.frameRate > frameRate) {
        enforce();
      }
    });
    enforce();
  });
  room.once(RoomEvent.Connected, () => startMeetingMediaDiagnostics(room, policy, input.reportMediaHealth));

  return room;
}

export function getMeetingAudioCaptureOptions(audioDeviceId?: string): AudioCaptureOptions {
  return {
    deviceId: audioDeviceId,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: { ideal: config.audio.sampleRate },
    channelCount: config.audio.channelCount,
  };
}

function getMeetingCameraCaptureOptionsNamed(input: {
  videoDeviceId?: string;
  decision?: CodecDecision;
}): VideoCaptureOptions {
  const target = input.decision?.target ?? config.camera.efficient;

  return {
    deviceId: input.videoDeviceId,
    // SDK 2.18.1 flattens these bare numbers into non-exact (ideal) constraints.
    resolution: { width: target.width, height: target.height, frameRate: target.frameRate },
    frameRate: { ideal: target.frameRate, max: target.frameRate },
  };
}

export function getMeetingCameraCaptureOptions(
  ...args: [videoDeviceId?: string, decision?: CodecDecision]
): VideoCaptureOptions {
  const [videoDeviceId, decision] = args;

  return getMeetingCameraCaptureOptionsNamed({ videoDeviceId, decision });
}

/** VideoResolution only accepts numbers in SDK 2.18.1. Use the standard
 * MediaStreamTrack API for strict upper bounds, preserving the SDK's track. */
async function constrainMeetingCameraNamed(input: {
  track: LocalTrack | MediaStreamTrack;
  decision: CodecDecision;
}): Promise<void> {
  if (input.track.kind !== "video") {
    return;
  }
  const capture = getMeetingCaptureTrack(input.track);
  if (capture.readyState === "ended") {
    return;
  }
  const target = input.decision.target;
  const actual = capture.getSettings();
  // Camera settings describe the current capture orientation; screen/browser
  // orientation is not a reliable proxy (e.g. an external rotated camera).
  const isPortraitCapture = (actual.height ?? 0) > (actual.width ?? 0);
  const width = isPortraitCapture ? target.height : target.width;
  const height = isPortraitCapture ? target.width : target.height;
  try {
    await capture.applyConstraints({
      ...capture.getConstraints(),
      width: { ideal: width, max: width },
      height: { ideal: height, max: height },
      frameRate: { ideal: target.frameRate, max: target.frameRate },
    });
  } catch (error) {
    // applyConstraints is atomic: rejection leaves the working capture intact.
    // Keep it for preview/publication; SDK publish limits still bound encoding.
    console.error("[ready:media] Camera cap rejected; retaining current capture.", {
      error,
      requested: { width, height, frameRate: target.frameRate },
      actual: { width: actual.width, height: actual.height, frameRate: actual.frameRate },
    });
  }
}

export async function constrainMeetingCamera(
  ...args: [track: LocalTrack | MediaStreamTrack, decision: CodecDecision]
): Promise<void> {
  const [track, decision] = args;

  return constrainMeetingCameraNamed({ track, decision });
}

async function prepareMeetingCameraForPublishNamed(input: {
  participant: LocalParticipant;
  track: LocalTrack | MediaStreamTrack;
}): Promise<void> {
  const decision = participantPolicies.get(input.participant)?.camera;
  const preference = cameraBlurPreferences.get(input.participant);
  if (input.track instanceof LocalVideoTrack) {
    const isEnabled = await preference;
    if (isEnabled !== undefined) {
      await setLocalVideoTrackBackgroundBlur({ track: input.track, isEnabled });
    }
  } else if ((await preference) === true) {
    throw new Error(CAMERA_REQUIRES_LOCAL_TRACK);
  }
  if (decision !== undefined) {
    await constrainMeetingCameraNamed({ track: input.track, decision });
  }
  if (preference !== cameraBlurPreferences.get(input.participant)) {
    await prepareMeetingCameraForPublishNamed(input);
  }
}

export async function prepareMeetingCameraForPublish(
  ...args: [participant: LocalParticipant, track: LocalTrack | MediaStreamTrack]
): Promise<void> {
  const [participant, track] = args;

  return prepareMeetingCameraForPublishNamed({ participant, track });
}

type MeetingCameraEnableResult = {
  /** @external meeting camera enable result field */
  recoveredWithDefaultDevice: boolean;
  firstError: unknown;
};

const COULD_NOT_START_SELECTED_CAMERA_MESSAGE = "Could not start the selected camera";

function getCameraErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : COULD_NOT_START_SELECTED_CAMERA_MESSAGE;
}

function isCameraDeviceFallbackError(error: unknown) {
  const nameValue = error !== null && typeof error === "object" && "name" in error ? error.name : undefined;
  const name = typeof nameValue === "string" ? nameValue : "";

  return (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError"
  );
}

/** Keeps the selected-device failure authoritative while retaining the
 * default-device failure for diagnostics. */
export class MeetingCameraFallbackError extends Error {
  readonly firstError: unknown;
  readonly fallbackError: unknown;

  constructor(...args: [firstError: unknown, fallbackError: unknown]) {
    const [firstError, fallbackError] = args;
    super(getCameraErrorMessage(firstError), { cause: firstError });
    this.name = firstError instanceof Error && firstError.name !== "" ? firstError.name : "MeetingCameraFallbackError";
    this.firstError = firstError;
    this.fallbackError = fallbackError;
  }
}

/**
 * Enables camera through LiveKit's supported participant API. If a remembered
 * camera can no longer be found, retry once with the browser's default camera.
 * Other failures are returned unchanged so a busy or broken camera cannot
 * unexpectedly switch the user's selected device.
 */
function isCameraPublisher(participant: object): participant is LocalParticipant {
  return "publishTrack" in participant && "getTrackPublication" in participant && "unpublishTrack" in participant;
}

async function enablePreparedMeetingCamera(
  ...args: [participant: Pick<LocalParticipant, "setCameraEnabled">, videoDeviceId?: string]
): Promise<void> {
  const [participant, videoDeviceId] = args;
  if (!isCameraPublisher(participant)) {
    await participant.setCameraEnabled(
      true,
      getMeetingCameraCaptureOptions(videoDeviceId, participantPolicies.get(participant)?.camera),
    );

    return;
  }
  const localParticipant = participant;
  const pending = beginMeetingCameraStart(localParticipant);
  try {
    const existing = localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (existing) {
      await localParticipant.unpublishTrack(existing);
      existing.stop();
    }
    const acquire = async () => {
      try {
        if (pendingCameras.get(localParticipant) !== pending) {
          throw new MeetingCameraStartCancelledError();
        }

        return await createLocalVideoTrack({
          ...getMeetingCameraCaptureOptions(videoDeviceId, participantPolicies.get(participant)?.camera),
          // A string makes the SDK retry every error, including denied permission.
          // Keep fallback here so cancellation and permission errors remain authoritative.
          deviceId: videoDeviceId !== undefined && videoDeviceId !== "" ? { exact: videoDeviceId } : undefined,
        });
      } catch (error) {
        if (pendingCameras.get(localParticipant) !== pending) {
          throw new MeetingCameraStartCancelledError();
        }
        throw error;
      }
    };
    const track = await acquire();
    await publishPreparedMeetingCamera({ participant: localParticipant, track, pending });
  } finally {
    if (pendingCameras.get(localParticipant) === pending) {
      pendingCameras.delete(localParticipant);
    }
  }
}

async function enableMeetingCameraWithFallbackNamed(input: {
  participant: Pick<LocalParticipant, "setCameraEnabled">;
  videoDeviceId?: string;
}): Promise<MeetingCameraEnableResult> {
  try {
    await enablePreparedMeetingCamera(input.participant, input.videoDeviceId);

    return { recoveredWithDefaultDevice: false, firstError: null };
  } catch (firstError) {
    if (input.videoDeviceId === undefined || input.videoDeviceId === "" || !isCameraDeviceFallbackError(firstError)) {
      throw firstError;
    }

    try {
      await enablePreparedMeetingCamera(input.participant);

      return { recoveredWithDefaultDevice: true, firstError };
    } catch (fallbackError) {
      if (fallbackError instanceof MeetingCameraStartCancelledError) {
        throw fallbackError;
      }
      throw new MeetingCameraFallbackError(firstError, fallbackError);
    }
  }
}

export async function enableMeetingCameraWithFallback(
  ...args: [participant: Pick<LocalParticipant, "setCameraEnabled">, videoDeviceId?: string]
): Promise<MeetingCameraEnableResult> {
  const [participant, videoDeviceId] = args;

  return enableMeetingCameraWithFallbackNamed({ participant, videoDeviceId });
}

export function getMeetingPublishDefaults(decision?: CodecDecision): TrackPublishDefaults {
  const target = decision?.target ?? config.camera.efficient;
  const encoding = { maxBitrate: target.maxBitrate, maxFramerate: target.frameRate };

  return {
    simulcast: true,
    degradationPreference: config.camera.degradationPreference,
    videoCodec: decision?.codec ?? config.backup.codec,
    scalabilityMode: decision?.scalabilityMode,
    videoEncoding: encoding,
    videoSimulcastLayers: config.camera.layers.map((layer) => new VideoPreset(layer)),
    backupCodec: { codec: config.backup.codec, encoding },
    backupCodecPolicy: config.backup.policy,
    audioPreset: { maxBitrate: config.audio.maxBitrate },
    forceStereo: false,
    red: true,
    dtx: true,
  };
}

export function getScreenSharePublishDefaults(participant?: LocalParticipant): TrackPublishDefaults {
  const decision = participant && participantPolicies.get(participant)?.screen;
  const target = decision?.target ?? config.screen.constrained;

  return {
    simulcast: false,
    degradationPreference: config.screen.degradationPreference,
    videoCodec: decision?.codec ?? config.backup.codec,
    scalabilityMode: decision?.scalabilityMode,
    backupCodec: {
      codec: config.backup.codec,
      encoding: {
        maxBitrate: target.maxBitrate,
        maxFramerate: target.frameRate,
      },
    },
    backupCodecPolicy: config.backup.policy,
    screenShareEncoding: { maxBitrate: target.maxBitrate, maxFramerate: target.frameRate, priority: "high" },
    // Preserve screen-audio's previous SDK preset and inferred channel count.
    audioPreset: { maxBitrate: config.screen.audioMaxBitrate },
    forceStereo: undefined,
  };
}

export function getScreenShareCaptureOptions(participant?: LocalParticipant): ScreenShareCaptureOptions {
  const target = (participant && participantPolicies.get(participant)?.screen.target) ?? config.screen.constrained;

  return {
    audio: true,
    contentHint: config.screen.contentHint,
    // SDK 2.18.1 documents WebKit bug 263015: specifying a resolution
    // produces low-resolution capture on Safari 17. Leave dimensions native.
    resolution: usesSafariScreenResolutionWorkaround()
      ? undefined
      : { width: target.width, height: target.height, frameRate: target.frameRate },
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    suppressLocalAudioPlayback: false,
    systemAudio: "include",
    video: true,
  };
}

function usesSafariScreenResolutionWorkaround() {
  const browser = getBrowser();

  return (
    (browser?.name === "Safari" && browser.version.startsWith("17.")) ||
    (browser?.os === "iOS" &&
      browser.osVersion !== undefined &&
      browser.osVersion !== "" &&
      compareVersions(browser.osVersion, "17") >= 0)
  );
}

export type AcquiredMeetingMedia = {
  tracks: LocalTrack[];
  audioError: Error | null;
  videoError: Error | null;
};

const COULD_NOT_ACCESS_DEVICE_MESSAGE = "Could not access this device";

function toAcquisitionError(value: unknown) {
  return value instanceof Error ? value : new Error(COULD_NOT_ACCESS_DEVICE_MESSAGE);
}

function releaseFailureKind(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}

export function stopLocalTracks(tracks: LocalTrack[]): void {
  tracks.forEach((track) => {
    if ("stopProcessor" in track) {
      try {
        void (async () => {
          try {
            await track.stopProcessor();
          } catch (error) {
            // best-effort processor release
            void releaseFailureKind(error);
          }
        })();
      } catch (error) {
        // best-effort processor release
        void releaseFailureKind(error);
      }
    }

    try {
      track.stop();
    } catch (error) {
      // best-effort device release
      void releaseFailureKind(error);
    }
  });
}

/**
 * Acquires camera + microphone in a single getUserMedia call when possible, and
 * degrades to whichever device is available instead of failing the whole join.
 */
export async function acquireMeetingMediaTracks(
  input: { audioDeviceId?: string; videoDeviceId?: string } = {},
): Promise<AcquiredMeetingMedia> {
  const audioOptions = getMeetingAudioCaptureOptions(input.audioDeviceId);
  const policy = await selectMeetingMediaPolicy();
  const videoOptions = getMeetingCameraCaptureOptions(input.videoDeviceId, policy.camera);

  try {
    const tracks = await createLocalTracks({ audio: audioOptions, video: videoOptions });

    return await constrainAcquiredCameras({
      media: { tracks, audioError: null, videoError: null },
      decision: policy.camera,
    });
  } catch (error) {
    // fall back to acquiring each device on its own
    void releaseFailureKind(error);
  }

  const audioMedia = await (async (): Promise<Pick<AcquiredMeetingMedia, "tracks" | "audioError">> => {
    try {
      return { tracks: await createLocalTracks({ audio: audioOptions, video: false }), audioError: null };
    } catch (audioError) {
      return { tracks: [], audioError: toAcquisitionError(audioError) };
    }
  })();
  const videoMedia = await (async (): Promise<Pick<AcquiredMeetingMedia, "tracks" | "videoError">> => {
    try {
      return { tracks: await createLocalTracks({ audio: false, video: videoOptions }), videoError: null };
    } catch (videoError) {
      return { tracks: [], videoError: toAcquisitionError(videoError) };
    }
  })();
  const media: AcquiredMeetingMedia = {
    tracks: [...audioMedia.tracks, ...videoMedia.tracks],
    audioError: audioMedia.audioError,
    videoError: videoMedia.videoError,
  };

  return constrainAcquiredCameras({ media, decision: policy.camera });
}

async function constrainAcquiredCameras(input: { media: AcquiredMeetingMedia; decision: CodecDecision }) {
  await input.media.tracks.reduce(async (previous, track) => {
    await previous;
    if (track.kind === Track.Kind.Video) {
      await constrainMeetingCameraNamed({ track, decision: input.decision });
    }
  }, Promise.resolve());

  return input.media;
}
