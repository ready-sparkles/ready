import {
  BackgroundTransformer,
  ProcessorWrapper,
  supportsBackgroundProcessors,
  type VideoTransformerInitOptions,
} from "@livekit/track-processors";
import type { LocalVideoTrack, ProcessorOptions, Track, TrackProcessor } from "livekit-client";

import { MeetBackgroundTransformer, type MeetBlurTransformerOptions } from "./meet-blur/transformer";
import { MEETING_MEDIA_CONFIG } from "./meeting-media-config";

const BLUR_UNSUPPORTED = "Background blur isn’t supported in this browser. Turn blur off to use your camera.";

const BLUR_START_TIMEOUT_MS = 15_000;
const BLUR_STOPPED = "Background blur was stopped.";
const BLUR_START_FAILED = "Background blur could not start. Retry the camera or turn blur off.";
const controllers = new WeakMap<LocalVideoTrack, BackgroundBlurController>();
const listeners = new Set<() => void>();

export function subscribeBackgroundBlur(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function isCameraBlurReady(track: LocalVideoTrack | null): boolean {
  return track === null || (controllers.get(track)?.isReady ?? true);
}

export function canToggleBackgroundBlur(input: {
  isBackgroundBlurEnabled: boolean;
  isBackgroundBlurSupported: boolean;
}): boolean {
  // Unsupported browsers must still let users opt out of a saved blur preference.
  return input.isBackgroundBlurEnabled || input.isBackgroundBlurSupported;
}

export function isBackgroundBlurProcessorSupported(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  try {
    return supportsBackgroundProcessors();
  } catch (error) {
    console.error("ReadyMeet background blur: processor support probe failed.", error);

    return false;
  }
}

/** Both implementations share one output, so fallback never restores raw video. */
export class GuardedBlurTransformer {
  transformer?: TransformStream<VideoFrame, VideoFrame>;
  ready: Promise<void> = Promise.resolve();
  private delegate?: MeetBackgroundTransformer | BackgroundTransformer;
  private initOptions?: VideoTransformerInitOptions;
  private generation = 0;
  private isDestroyed = false;
  private failure: Error | null = null;
  private failedFrames = 0;
  private isSwitching = false;
  private firstFrame?: () => void;
  private rejectFrame?: (error: Error) => void;

  private options: MeetBlurTransformerOptions;
  private readonly onReady: (isReady: boolean) => void;

  constructor(input: { options: MeetBlurTransformerOptions; onReady: (isReady: boolean) => void }) {
    this.options = input.options;
    this.onReady = input.onReady;
  }

  async init(options: VideoTransformerInitOptions): Promise<void> {
    this.transformer = new TransformStream({ transform: this.transform });
    if (this.isDestroyed) {
      return;
    }
    const generation = ++this.generation;
    this.initOptions = options;
    this.failure = null;
    this.failedFrames = 0;
    this.isSwitching = false;
    this.waitForFirstFrame();
    if (MeetBackgroundTransformer.isSupported) {
      const custom = new MeetBackgroundTransformer({
        ...this.options,
        onFatalError: (error) => {
          this.failure = error;
        },
      });
      this.delegate = custom;
      try {
        await custom.init(options);
        if (generation !== this.generation) {
          custom.destroy();
        }

        return;
      } catch (error) {
        custom.destroy();
        if (generation !== this.generation) {
          throw error;
        }
        console.error("ReadyMeet blur: using fallback processor.", error);
      }
    }
    await this.startStock(options, generation);
  }

  transform = async (
    ...args: [frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>]
  ): Promise<void> => {
    const [frame, controller] = args;
    if (this.isDestroyed || this.isSwitching || !this.delegate) {
      frame.close();

      return;
    }
    if (this.failure && this.initOptions) {
      this.waitForFirstFrame();
      this.isSwitching = true;
      const generation = this.generation;
      try {
        await this.delegate.destroy();
        await this.startStock(this.initOptions, generation);
        this.failure = null;
      } catch (error) {
        this.delegate = undefined;
        this.rejectFrame?.(error instanceof Error ? error : new Error(BLUR_START_FAILED));
      } finally {
        this.isSwitching = false;
        frame.close();
      }

      return;
    }
    const generation = this.generation;
    const delegate = this.delegate;
    const output = { frames: [] as VideoFrame[], isStockProcessed: false };
    if (delegate instanceof BackgroundTransformer) {
      // The stock implementation otherwise deliberately emits a raw first frame.
      delegate.isFirstFrame = false;
      delegate.options.onFrameProcessed = () => {
        output.isStockProcessed = true;
      };
    }
    const guardedController: TransformStreamDefaultController<VideoFrame> = {
      desiredSize: controller.desiredSize,
      error: (error: unknown) => {
        controller.error(error);
      },
      terminate: () => {
        controller.terminate();
      },
      enqueue: (processed: VideoFrame) => {
        if (processed === frame) {
          processed.close();

          return;
        }
        output.frames = [...output.frames, processed];
      },
    };
    try {
      await delegate.transform(frame, guardedController);
      this.failedFrames = output.frames.length === 0 ? this.failedFrames + 1 : 0;
      if (this.failedFrames >= MEETING_MEDIA_CONFIG.blur.maxConsecutiveErrors) {
        this.onReady(false);
      }
      output.frames.forEach((processed) => {
        if (generation !== this.generation || (delegate instanceof BackgroundTransformer && !output.isStockProcessed)) {
          processed.close();
        } else {
          controller.enqueue(processed);
          this.onReady(true);
          this.firstFrame?.();
          this.firstFrame = undefined;
        }
      });
    } catch (error) {
      output.frames.forEach((processed) => {
        processed.close();
      });
      this.onReady(false);
      this.rejectFrame?.(error instanceof Error ? error : new Error(BLUR_START_FAILED));
    }
  };

  async restart(options: VideoTransformerInitOptions): Promise<void> {
    await this.destroy();
    this.isDestroyed = false;
    await this.init(options);
  }

  async destroy(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }
    ++this.generation;
    this.isDestroyed = true;
    this.onReady(false);
    this.rejectFrame?.(new Error(BLUR_STOPPED));
    this.firstFrame = undefined;
    const delegate = this.delegate;
    this.delegate = undefined;
    await delegate?.destroy();
  }

  update(options: MeetBlurTransformerOptions): void {
    this.options = { ...this.options, ...options };
    void this.delegate?.update(options);
  }

  private waitForFirstFrame(): void {
    this.onReady(false);
    if (this.firstFrame !== undefined) {
      return;
    }
    this.ready = new Promise<void>((resolve, reject) => {
      this.firstFrame = resolve;
      this.rejectFrame = reject;
    });
    // Initialization may fail before the processor begins waiting for output.
    void (async () => {
      try {
        await this.ready;
      } catch (error) {
        void error; // The caller receives initialization failure.
      }
    })();
  }

  private async startStock(...args: [options: VideoTransformerInitOptions, generation: number]): Promise<void> {
    const [options, generation] = args;
    const stock = new BackgroundTransformer({ blurRadius: this.options.blurRadius });
    this.delegate = stock;
    await stock.init(options);
    if (generation !== this.generation) {
      await stock.destroy();
    }
  }
}

/** Releases LiveKit's attachment lock immediately, even if model loading is stalled. */
class ReadyBlurProcessor implements TrackProcessor<Track.Kind> {
  readonly name = "ready-background-blur";
  source?: MediaStreamTrack;
  private attempt?: {
    wrapper: ProcessorWrapper<MeetBlurTransformerOptions, GuardedBlurTransformer>;
    cancel: () => void;
    isCancelled: boolean;
  };

  constructor(private readonly createTransformer: () => GuardedBlurTransformer) {}

  get processedTrack(): MediaStreamTrack | undefined {
    return this.attempt?.isCancelled === true ? undefined : this.attempt?.wrapper.processedTrack;
  }

  get ready(): Promise<void> {
    return this.attempt?.wrapper.transformer.ready ?? Promise.resolve();
  }

  async init(options: ProcessorOptions<Track.Kind>): Promise<void> {
    this.source = options.track;
    const element = options.element;
    const wrapper = new ProcessorWrapper(this.createTransformer(), `${this.name}-${crypto.randomUUID()}`, {
      maxFps: MEETING_MEDIA_CONFIG.camera.efficient.frameRate,
    });
    const cancellation: { reject?: (error: Error) => void } = {};
    const cancelled = new Promise<never>((_, reject) => {
      cancellation.reject = reject;
    });
    const attempt = {
      wrapper,
      isCancelled: false,
      cancel: () => {
        cancellation.reject?.(new Error(BLUR_STOPPED));
      },
    };
    this.attempt = attempt;
    const initialize = async () => {
      try {
        await wrapper.init(options);
        if (attempt.isCancelled) {
          return;
        }
        // Safari's canvas path needs input playback before it can produce output.
        if (element) {
          element.srcObject = new MediaStream([options.track]);
          element.muted = true;
          await element.play();
        }
        await wrapper.transformer.ready;
      } finally {
        if (attempt.isCancelled) {
          await wrapper.destroy();
          if (this.attempt === attempt && element) {
            element.pause();
            element.srcObject = null;
          }
        }
      }
    };
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    try {
      await Promise.race([
        initialize(),
        cancelled,
        new Promise<never>((_, reject) => {
          timer.id = setTimeout(() => reject(new Error(BLUR_START_FAILED)), BLUR_START_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (this.attempt === attempt) {
        await this.destroy();
      }
      throw error;
    } finally {
      clearTimeout(timer.id);
    }
  }

  async restart(options: ProcessorOptions<Track.Kind>): Promise<void> {
    await this.destroy();
    await this.init(options);
  }

  async destroy(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || attempt.isCancelled) {
      return;
    }
    attempt.isCancelled = true;
    attempt.cancel();
    // ProcessorWrapper.destroy ignores initializing wrappers. Invalidate the
    // transformer now; initialize's finally cleans up the wrapper when it settles.
    await attempt.wrapper.transformer.destroy();
    await attempt.wrapper.destroy();
  }

  async updateTransformerOptions(options: MeetBlurTransformerOptions): Promise<void> {
    this.attempt?.wrapper.transformer.update(options);
  }
}

class BackgroundBlurController {
  isReady = true;
  owner?: LocalVideoTrack;
  readonly modelAssetPath: string | undefined;
  private processor: ReadyBlurProcessor | null = null;
  private operation: Promise<void> = Promise.resolve();
  private isAttaching = false;
  private pendingOperations = 0;
  private requestVersion = 0;

  constructor(options?: { modelAssetPath?: string }) {
    this.modelAssetPath = options?.modelAssetPath;
  }

  async setDebugMaskView(isEnabled: boolean): Promise<void> {
    await this.processor?.updateTransformerOptions({ debugMask: isEnabled });
  }

  async setTrackBlurEnabled(input: { track: LocalVideoTrack; isEnabled: boolean }): Promise<void> {
    if (
      this.pendingOperations === 0 &&
      input.isEnabled &&
      this.isReady &&
      this.processor &&
      input.track.getProcessor() === this.processor
    ) {
      return Promise.resolve();
    }
    if (input.isEnabled) {
      this.setReady(false);
    }
    const version = ++this.requestVersion;
    this.pendingOperations += 1;
    const previous = this.operation;
    const operation = (async () => {
      try {
        await previous;
      } catch (error) {
        void error; // A later toggle can recover a failed attempt.
      }
      try {
        if (version === this.requestVersion) {
          await this.apply({ ...input, version });
        }
      } finally {
        this.pendingOperations -= 1;
      }
    })();
    this.operation = operation;

    return operation;
  }

  private readonly setReady = (isReady: boolean): void => {
    if (this.isReady === isReady) {
      return;
    }
    this.isReady = isReady;
    listeners.forEach((listener) => {
      listener();
    });
  };

  private async apply(input: { track: LocalVideoTrack; isEnabled: boolean; version: number }): Promise<void> {
    if (!input.isEnabled) {
      await input.track.stopProcessor();
      this.processor = null;
      if (input.version !== this.requestVersion) {
        return;
      }
      this.setReady(true);
      await input.track.resumeUpstream();

      return;
    }
    if (this.processor && input.track.getProcessor() === this.processor) {
      await this.processor.ready;
      this.setReady(true);

      return;
    }
    await input.track.pauseUpstream();
    this.isAttaching = true;
    const processor = new ReadyBlurProcessor(
      () =>
        new GuardedBlurTransformer({
          options: { blurRadius: MEETING_MEDIA_CONFIG.blur.radius, modelAssetPath: this.modelAssetPath },
          onReady: (isReady) => {
            if (this.processor === processor && (!isReady || !this.isAttaching)) {
              this.setReady(isReady);
            }
          },
        }),
    );
    this.processor = processor;
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    try {
      await Promise.race([
        input.track.setProcessor(processor, true),
        new Promise<never>((_, reject) => {
          timer.id = setTimeout(() => reject(new Error(BLUR_START_FAILED)), BLUR_START_TIMEOUT_MS);
        }),
      ]);
      if (input.track.mediaStreamTrack.readyState === "ended") {
        throw new Error(BLUR_START_FAILED);
      }
      await input.track.resumeUpstream();
      this.isAttaching = false;
      this.setReady(true);
    } catch (error) {
      this.setReady(false);
      await processor.destroy();
      this.processor = null;
      throw error;
    } finally {
      this.isAttaching = false;
      clearTimeout(timer.id);
    }
  }
}

export function createBackgroundBlurProcessor(options?: { modelAssetPath?: string }): BackgroundBlurController {
  return new BackgroundBlurController(options);
}

export async function setLocalVideoTrackBackgroundBlur(input: {
  track: LocalVideoTrack;
  processor?: BackgroundBlurController;
  isEnabled: boolean;
}): Promise<void> {
  if (input.isEnabled && !isBackgroundBlurProcessorSupported()) {
    throw new Error(BLUR_UNSUPPORTED);
  }
  const current = controllers.get(input.track);
  if (
    current &&
    (input.processor?.modelAssetPath === undefined || input.processor.modelAssetPath === current.modelAssetPath)
  ) {
    await current.setTrackBlurEnabled(input);

    return;
  }
  const controller =
    input.processor && (!input.processor.owner || input.processor.owner === input.track)
      ? input.processor
      : createBackgroundBlurProcessor({ modelAssetPath: input.processor?.modelAssetPath });
  if (!input.isEnabled && !input.track.getProcessor()) {
    return;
  }
  controller.owner = input.track;
  controllers.set(input.track, controller);
  await controller.setTrackBlurEnabled(input);
}
