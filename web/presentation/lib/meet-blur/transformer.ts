import type { VideoTrackTransformer, VideoTransformerInitOptions } from "@livekit/track-processors";
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

import { MEETING_MEDIA_CONFIG } from "../meeting-media-config";

import { createMeetBlurPipeline, type MeetBlurPipeline } from "./webgl-pipeline";

const TASKS_VISION_VERSION = "0.10.14";
const TASKS_VISION_FILESET_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MESSAGE_BACKGROUND_BLUR_PROCESSING_FAILED = "Background blur processing failed.";

/**
 * Multiclass segmenter (background/hair/skin/clothes, 256x256, ~16MB) — the
 * default. Much more robust on clothed shoulders and accessories than the
 * binary models because garments are an explicitly trained class; the person
 * matte is derived as 1 - background confidence.
 */
const MULTICLASS_SEGMENTER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";

/** Stop processing after this many consecutive errors; never expose raw frames. */
const MAX_CONSECUTIVE_ERRORS = MEETING_MEDIA_CONFIG.blur.maxConsecutiveErrors;

const DEFAULT_BLUR_RADIUS = MEETING_MEDIA_CONFIG.blur.radius;

export type MeetBlurTransformerOptions = {
  blurRadius?: number;
  /** @external LiveKit processor option */
  disabled?: boolean;
  /** Show the refined segmentation mask instead of the composite. */
  /** @external LiveKit processor option */
  debugMask?: boolean;
  /** Segmentation model URL; applied on (re)init only. */
  modelAssetPath?: string;
  /** Called once if the pipeline fails permanently at runtime. */
  onFatalError?: (error: Error) => void;
};

/**
 * Drop-in replacement for LiveKit's BackgroundTransformer (blur mode only)
 * with Meet-style mask post-processing. Plugs into LiveKit's ProcessorWrapper.
 */
export class MeetBackgroundTransformer {
  transformer?: TransformStream<VideoFrame, VideoFrame>;

  private options: MeetBlurTransformerOptions;
  private canvas?: OffscreenCanvas | HTMLCanvasElement;
  private pipeline?: MeetBlurPipeline;
  private imageSegmenter?: ImageSegmenter;
  private maskIndex = 0;
  private isMaskBackground = false;
  private consecutiveErrors = 0;
  private isDead = false;

  constructor(options: MeetBlurTransformerOptions) {
    this.options = options;
  }

  static get isSupported(): boolean {
    if (
      typeof VideoFrame === "undefined" ||
      typeof OffscreenCanvas === "undefined" ||
      typeof document === "undefined"
    ) {
      return false;
    }
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) {
      return false;
    }

    return !!gl.getExtension("EXT_color_buffer_float") || !!gl.getExtension("EXT_color_buffer_half_float");
  }

  async init(options: VideoTransformerInitOptions): Promise<void> {
    await this.initialize(options);
  }

  async restart(options: VideoTransformerInitOptions): Promise<void> {
    this.destroy();
    await this.initialize(options);
  }

  destroy(): void {
    this.isDead = true;
    this.imageSegmenter?.close();
    this.imageSegmenter = undefined;
    this.pipeline?.cleanup();
    this.pipeline = undefined;
    this.canvas = undefined;
  }

  update(options: Partial<MeetBlurTransformerOptions>): void {
    this.options = { ...this.options, ...options };
    if (typeof options.blurRadius === "number") {
      this.pipeline?.setBlurRadius(options.blurRadius);
    }
    if (typeof options.debugMask === "boolean") {
      this.pipeline?.setDebugMask(options.debugMask);
    }
  }

  transform: VideoTrackTransformer<MeetBlurTransformerOptions>["transform"] = (
    frame,
    controller: TransformStreamDefaultController<VideoFrame>,
  ) => {
    this.processTransform({ frame, controller });
  };

  private processTransform(input: {
    frame: VideoFrame;
    controller: TransformStreamDefaultController<VideoFrame>;
  }): void {
    try {
      if (this.isInvalidFrame(input.frame) || this.shouldPassThrough()) {
        return;
      }
      this.runSegmentation(input.frame);
      const pipeline = this.pipeline;
      if (!pipeline || !pipeline.hasMask()) {
        return;
      }
      this.renderProcessedFrame({ frame: input.frame, controller: input.controller, pipeline });
      this.consecutiveErrors = 0;
    } catch (error) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && !this.isDead) {
        this.isDead = true;
        this.options.onFatalError?.(
          error instanceof Error ? error : new Error(MESSAGE_BACKGROUND_BLUR_PROCESSING_FAILED),
        );
      }
    } finally {
      input.frame.close();
    }
  }

  private async initialize({ outputCanvas }: VideoTransformerInitOptions): Promise<void> {
    this.transformer = new TransformStream<VideoFrame, VideoFrame>({
      transform: this.transform.bind(this),
    });
    this.canvas = outputCanvas;
    const fileset = await FilesetResolver.forVisionTasks(TASKS_VISION_FILESET_URL);
    this.imageSegmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: this.options.modelAssetPath ?? MULTICLASS_SEGMENTER_MODEL_URL,
        delegate: "GPU",
      },
      canvas: outputCanvas,
      runningMode: "VIDEO",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    const labels = this.imageSegmenter.getLabels();
    const backgroundIndex = labels.findIndex((label) => /background/i.test(label));
    if (backgroundIndex >= 0) {
      this.maskIndex = backgroundIndex;
      this.isMaskBackground = true;
    } else {
      const personIndex = labels.findIndex((label) => /person|selfie|foreground/i.test(label));
      this.maskIndex = personIndex >= 0 ? personIndex : Math.max(0, labels.length - 1);
      this.isMaskBackground = false;
    }
    this.consecutiveErrors = 0;
    this.isDead = false;
  }

  private isInvalidFrame(frame: VideoFrame): boolean {
    return !(frame instanceof VideoFrame) || frame.codedWidth === 0 || frame.codedHeight === 0;
  }

  private shouldPassThrough(): boolean {
    return (
      this.isDead || this.options.disabled === true || this.imageSegmenter === undefined || this.canvas === undefined
    );
  }

  private renderProcessedFrame(input: {
    frame: VideoFrame;
    controller: TransformStreamDefaultController<VideoFrame>;
    pipeline: MeetBlurPipeline;
  }): void {
    const canvas = this.canvas;
    if (canvas === undefined) {
      return;
    }
    if (canvas.width !== input.frame.displayWidth || canvas.height !== input.frame.displayHeight) {
      canvas.width = input.frame.displayWidth;
      canvas.height = input.frame.displayHeight;
    }
    input.pipeline.render(input.frame);
    input.controller.enqueue(new VideoFrame(canvas, { timestamp: input.frame.timestamp }));
  }

  private runSegmentation(frame: VideoFrame): void {
    this.imageSegmenter?.segmentForVideo(frame, performance.now(), (result) => {
      try {
        const masks = result.confidenceMasks;
        if (masks === undefined || masks.length === 0) {
          return;
        }
        const mask = masks[Math.min(this.maskIndex, masks.length - 1)];
        if (mask !== undefined && this.canvas) {
          // Preserve the model's native detail instead of shrinking square masks to landscape.
          this.pipeline ??= createMeetBlurPipeline(this.canvas, this.options.blurRadius ?? DEFAULT_BLUR_RADIUS, {
            width: mask.width,
            height: mask.height,
          });
          this.pipeline.ingestMask(mask.getAsWebGLTexture(), this.isMaskBackground);
        }
      } finally {
        result.close();
      }
    });
  }
}
