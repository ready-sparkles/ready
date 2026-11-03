import { MEETING_MEDIA_CONFIG } from "../meeting-media-config";

/**
 * WebGL2 post-processing pipeline for Meet-quality background blur.
 *
 * The segmentation model (MediaPipe selfie segmenter) is cheap and shared with
 * LiveKit's stock processor — the quality difference lives entirely in these
 * GPU passes, which mirror the techniques Google documented for Meet:
 *
 *  1. Temporal pass (on each segmentation result): motion-adaptive exponential
 *     blend of the new confidence mask into a smoothed low-res mask, removing
 *     frame-to-frame mask flicker on hair and during head movement.
 *  2. Joint bilateral upsample: refines the low-res mask to frame resolution
 *     guided by the camera image, so the matte snaps to real edges and
 *     individual hair strands instead of bilinear blobs.
 *  3. Masked separable blur (normalized convolution at quarter resolution):
 *     background blur weighted by (1 - mask) so the person's colors never
 *     smear into the blur ring around their silhouette (no halo).
 *  4. Composite: soft confidence alpha (no hard threshold) plus light wrap,
 *     bleeding a hint of blurred background into the foreground edge for
 *     natural blending.
 *
 * All passes are small fullscreen shaders (~1-2ms total on integrated GPUs).
 */

/** Default dimensions are used only before a model supplies its native mask size. */
const LINT_NUM_N2 = 2;
const LINT_NUM_N6 = 6;

const SEG_WIDTH = MEETING_MEDIA_CONFIG.blur.maskWidth;
const SEG_HEIGHT = MEETING_MEDIA_CONFIG.blur.maskHeight;

/** Background blur runs at 1/4 frame resolution. */
const BLUR_DOWNSAMPLE = MEETING_MEDIA_CONFIG.blur.downsample;

/** Base EMA weight for incoming masks; rises to 1.0 where the mask changes. */
const TEMPORAL_BLEND = MEETING_MEDIA_CONFIG.blur.temporalBlend;

/** Color sigma of the joint bilateral filter (RGB distance in 0..1 space). */
const BILATERAL_SIGMA_COLOR = MEETING_MEDIA_CONFIG.blur.bilateralSigmaColor;

/** Fraction of blurred background wrapped into the foreground edge. */
const LIGHT_WRAP = MEETING_MEDIA_CONFIG.blur.lightWrap;

const WEBGL_SHADER_CREATE_FAILED_MESSAGE = "Failed to create shader";
const WEBGL_FRAMEBUFFER_INCOMPLETE_MESSAGE = "Framebuffer is incomplete";
const WEBGL2_UNAVAILABLE_MESSAGE = "WebGL2 is not available";
const WEBGL_FLOAT_BUFFERS_UNSUPPORTED_MESSAGE = "Float color buffers are not supported on this GPU";
const WEBGL_PIPELINE_TARGETS_UNALLOCATED_MESSAGE = "Pipeline targets are not allocated";
const WEBGL_SHADER_COMPILE_FAILED_PREFIX = "Shader compile failed: ";
const WEBGL_PROGRAM_LINK_FAILED_PREFIX = "Program link failed: ";
const WEBGL_SHADER_UNKNOWN_ERROR = "unknown error";

function isWebGL2RenderingContext(value: unknown): value is WebGL2RenderingContext {
  return value !== null && typeof value === "object" && "createProgram" in value;
}

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 position;
uniform float u_flipY;
out vec2 v_uv;

void main() {
  v_uv = position * 0.5 + 0.5;
  v_uv.y = mix(v_uv.y, 1.0 - v_uv.y, u_flipY);
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const TEMPORAL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_confidence;
uniform sampler2D u_previous;
uniform float u_blend;
uniform float u_reset;
uniform float u_invert;
out vec4 outColor;

void main() {
  float raw = texture(u_confidence, v_uv).r;
  // The confidence texture may be the background class (person = 1 - bg),
  // which is what the multiclass model provides.
  float current = clamp(u_invert > 0.5 ? 1.0 - raw : raw, 0.0, 1.0);
  float previous = texture(u_previous, v_uv).r;
  // Adopt large changes immediately (real motion), damp small fluctuations
  // (segmentation noise) so edges stay rock-steady on a still subject.
  // Keep this symmetric: biasing decay toward background makes the natural
  // confidence oscillation at the silhouette flash blur onto person edges.
  float change = abs(current - previous);
  float alpha = clamp(u_blend + change * (1.0 - u_blend) * 2.0, 0.0, 1.0);
  alpha = max(alpha, u_reset);
  outColor = vec4(mix(previous, current, alpha), 0.0, 0.0, 1.0);
}
`;

const BILATERAL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_mask;
uniform sampler2D u_frame;
uniform vec2 u_maskTexel;
uniform float u_sigmaColor;
out vec4 outColor;

void main() {
  vec3 center = texture(u_frame, v_uv).rgb;
  float total = 0.0;
  float value = 0.0;
  for (int dy = -2; dy <= 2; ++dy) {
    for (int dx = -2; dx <= 2; ++dx) {
      vec2 offset = vec2(float(dx), float(dy)) * u_maskTexel;
      vec2 uv = v_uv + offset;
      float m = texture(u_mask, uv).r;
      vec3 diff = texture(u_frame, uv).rgb - center;
      float spatial = exp(-(float(dx * dx) + float(dy * dy)) / 3.0);
      float range = exp(-dot(diff, diff) / (2.0 * u_sigmaColor * u_sigmaColor));
      float w = spatial * range + 1e-5;
      value += m * w;
      total += w;
    }
  }
  float refined = value / total;
  // Symmetric matte sharpening around 0.5: geometrically narrows the
  // person/background transition band (Meet's edge falls off within a few
  // pixels) without biasing toward either side — unlike threshold shifts,
  // which trade background leaks against eaten shirt/hair edges.
  refined = smoothstep(0.15, 0.85, refined);
  outColor = vec4(refined, 0.0, 0.0, 1.0);
}
`;

const DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform vec2 u_texel;
out vec4 outColor;

void main() {
  vec2 q = u_texel * 0.25;
  vec3 c = texture(u_frame, v_uv + vec2(-q.x, -q.y)).rgb
         + texture(u_frame, v_uv + vec2(q.x, -q.y)).rgb
         + texture(u_frame, v_uv + vec2(-q.x, q.y)).rgb
         + texture(u_frame, v_uv + vec2(q.x, q.y)).rgb;
  // Person mask rides along in alpha so the blur passes can exclude it.
  outColor = vec4(c * 0.25, texture(u_mask, v_uv).r);
}
`;

const MASKED_BLUR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_texel;
uniform vec2 u_direction;
uniform float u_radius;
uniform float u_firstPass;
out vec4 outColor;

const int MAX_TAPS = 16;

void main() {
  float sigma = max(u_radius * 0.5, 1.0);
  int radius = int(min(ceil(u_radius), float(MAX_TAPS)));
  float gaussNorm = 0.0;
  vec3 colorSum = vec3(0.0);
  float weightSum = 0.0;
  for (int i = -MAX_TAPS; i <= MAX_TAPS; ++i) {
    if (abs(float(i)) > float(radius)) continue;
    float g = exp(-float(i * i) / (2.0 * sigma * sigma));
    vec4 t = texture(u_texture, v_uv + u_direction * u_texel * float(i));
    if (u_firstPass > 0.5) {
      // Normalized convolution: weight samples by (1 - person) so the
      // background blur never ingests foreground colors.
      float w = 1.0 - t.a;
      colorSum += t.rgb * (w * g);
      weightSum += w * g;
    } else {
      colorSum += t.rgb * g;
      weightSum += t.a * g;
    }
    gaussNorm += g;
  }
  outColor = vec4(colorSum / gaussNorm, weightSum / gaussNorm);
}
`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform sampler2D u_blur;
uniform float u_lightWrap;
uniform float u_debugMask;
out vec4 outColor;

void main() {
  vec3 fg = texture(u_frame, v_uv).rgb;
  vec4 b = texture(u_blur, v_uv);
  vec3 bg = clamp(b.rgb / max(b.a, 1e-3), 0.0, 1.0);
  float alpha = texture(u_mask, v_uv).r;
  // Decisive S-curve: mid-confidence regions (noisy texture like brick walls)
  // resolve to fully blurred background instead of leaking through sharp,
  // while hair edges keep a soft gradient across the transition band. Pushing
  // the band tighter than this starts eating shirt/hair edges on real cameras.
  alpha = smoothstep(0.25, 0.75, alpha);
  if (u_debugMask > 0.5) {
    outColor = vec4(vec3(alpha), 1.0);
    return;
  }
  vec3 wrapped = mix(fg, bg, u_lightWrap * (1.0 - alpha));
  outColor = vec4(mix(bg, wrapped, alpha), 1.0);
}
`;

interface Pass {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
  uniform(name: string): WebGLUniformLocation | null;
}

export interface MeetBlurPipeline {
  /**
   * Blend a new MediaPipe confidence mask into the smoothed mask state.
   * Pass `invert: true` when the texture holds background (not person)
   * confidence, e.g. from the multiclass model.
   */
  ingestMask(
    ...args: [maskTexture: WebGLTexture, /** @external meet blur mask wire field */ shouldInvertMask: boolean]
  ): void;
  /** True once at least one mask has been ingested. */
  hasMask(): boolean;
  /** Render the given frame with the current mask state onto the canvas. */
  render(frame: VideoFrame): void;
  /** Blur radius in full-resolution pixels. */
  setBlurRadius(radius: number): void;
  /** Render the refined mask instead of the composite (tuning aid). */
  setDebugMask(/** @external meet blur debug wire field */ isDebugMaskEnabled: boolean): void;
  cleanup(): void;
}

function compileShader(input: { gl: WebGL2RenderingContext; type: number; source: string }) {
  const shader = input.gl.createShader(input.type);
  if (shader === null) {
    throw new Error(WEBGL_SHADER_CREATE_FAILED_MESSAGE);
  }
  input.gl.shaderSource(shader, input.source);
  input.gl.compileShader(shader);
  if (input.gl.getShaderParameter(shader, input.gl.COMPILE_STATUS) !== true) {
    const info = input.gl.getShaderInfoLog(shader);
    input.gl.deleteShader(shader);
    throw new Error(WEBGL_SHADER_COMPILE_FAILED_PREFIX + (info ?? WEBGL_SHADER_UNKNOWN_ERROR));
  }

  return shader;
}

function createPass(input: { gl: WebGL2RenderingContext; fragmentSource: string; uniformNames: string[] }): Pass {
  const vertex = compileShader({ gl: input.gl, type: input.gl.VERTEX_SHADER, source: VERTEX_SHADER });
  const fragment = compileShader({ gl: input.gl, type: input.gl.FRAGMENT_SHADER, source: input.fragmentSource });
  const program = input.gl.createProgram();
  input.gl.attachShader(program, vertex);
  input.gl.attachShader(program, fragment);
  input.gl.linkProgram(program);
  input.gl.deleteShader(vertex);
  input.gl.deleteShader(fragment);
  if (input.gl.getProgramParameter(program, input.gl.LINK_STATUS) !== true) {
    const info = input.gl.getProgramInfoLog(program);
    input.gl.deleteProgram(program);
    throw new Error(WEBGL_PROGRAM_LINK_FAILED_PREFIX + (info ?? WEBGL_SHADER_UNKNOWN_ERROR));
  }
  const uniforms: Pass["uniforms"] = Object.fromEntries(
    [...input.uniformNames, "u_flipY"].map((name) => [name, input.gl.getUniformLocation(program, name)]),
  );

  return {
    program,
    uniforms,
    uniform: (name: string) => uniforms[name] ?? null,
  };
}

function createRenderTexture(input: {
  gl: WebGL2RenderingContext;
  width: number;
  height: number;
  internalFormat: number;
  format: number;
  type: number;
}) {
  const texture = input.gl.createTexture();
  input.gl.bindTexture(input.gl.TEXTURE_2D, texture);
  input.gl.texImage2D(
    input.gl.TEXTURE_2D,
    0,
    input.internalFormat,
    input.width,
    input.height,
    0,
    input.format,
    input.type,
    null,
  );
  input.gl.texParameteri(input.gl.TEXTURE_2D, input.gl.TEXTURE_MIN_FILTER, input.gl.LINEAR);
  input.gl.texParameteri(input.gl.TEXTURE_2D, input.gl.TEXTURE_MAG_FILTER, input.gl.LINEAR);
  input.gl.texParameteri(input.gl.TEXTURE_2D, input.gl.TEXTURE_WRAP_S, input.gl.CLAMP_TO_EDGE);
  input.gl.texParameteri(input.gl.TEXTURE_2D, input.gl.TEXTURE_WRAP_T, input.gl.CLAMP_TO_EDGE);

  return texture;
}

function createFramebuffer(input: { gl: WebGL2RenderingContext; texture: WebGLTexture }) {
  const framebuffer = input.gl.createFramebuffer();
  input.gl.bindFramebuffer(input.gl.FRAMEBUFFER, framebuffer);
  input.gl.framebufferTexture2D(
    input.gl.FRAMEBUFFER,
    input.gl.COLOR_ATTACHMENT0,
    input.gl.TEXTURE_2D,
    input.texture,
    0,
  );
  if (input.gl.checkFramebufferStatus(input.gl.FRAMEBUFFER) !== input.gl.FRAMEBUFFER_COMPLETE) {
    input.gl.deleteFramebuffer(framebuffer);
    throw new Error(WEBGL_FRAMEBUFFER_INCOMPLETE_MESSAGE);
  }

  return framebuffer;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

type MeetBlurMaskState = {
  maskWidth: number;
  maskHeight: number;
  segMaskRead: Target;
  segMaskWrite: Target;
  maskCount: number;
  frameWidth: number;
  frameHeight: number;
  blurWidth: number;
  blurHeight: number;
  refinedMask: Target | null;
  downsampled: Target | null;
  blurPing: Target | null;
  blurPong: Target | null;
  blurRadiusTexels: number;
  isDebugMaskEnabled: boolean;
};

type MeetBlurPassBundle = {
  temporalPass: Pass;
  bilateralPass: Pass;
  downsamplePass: Pass;
  blurPass: Pass;
  compositePass: Pass;
};

type MeetBlurRunPass = (passInput: {
  pass: Pass;
  framebuffer: WebGLFramebuffer | null;
  width: number;
  height: number;
  isFlipY: boolean;
}) => void;

type MeetBlurBindTexture = (textureInput: {
  unit: number;
  texture: WebGLTexture;
  location: WebGLUniformLocation | null;
}) => void;

function createMeetBlurWebGLContext(canvas: OffscreenCanvas | HTMLCanvasElement): WebGL2RenderingContext {
  const glContext = canvas.getContext("webgl2", {
    antialias: true,
    premultipliedAlpha: true,
  });
  if (!isWebGL2RenderingContext(glContext)) {
    throw new Error(WEBGL2_UNAVAILABLE_MESSAGE);
  }
  const gl = glContext;
  // Float-renderable color buffers are needed both for the premultiplied blur
  // accumulation and by MediaPipe's confidence mask output.
  const hasFloatBuffers =
    gl.getExtension("EXT_color_buffer_float") !== null || gl.getExtension("EXT_color_buffer_half_float") !== null;
  if (!hasFloatBuffers) {
    throw new Error(WEBGL_FLOAT_BUFFERS_UNSUPPORTED_MESSAGE);
  }
  gl.getExtension("OES_texture_float_linear");

  return gl;
}

function createMeetBlurFullscreenQuad(gl: WebGL2RenderingContext): {
  vao: WebGLVertexArrayObject;
  quadBuffer: WebGLBuffer;
} {
  const vao = gl.createVertexArray();
  const quadBuffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, LINT_NUM_N2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  return { vao, quadBuffer };
}

function createMeetBlurPassBundleAndFrameTexture(gl: WebGL2RenderingContext): {
  passes: MeetBlurPassBundle;
  frameTexture: WebGLTexture;
} {
  const temporalPass = createPass({
    gl,
    fragmentSource: TEMPORAL_FRAGMENT,
    uniformNames: ["u_confidence", "u_previous", "u_blend", "u_reset", "u_invert"],
  });
  const bilateralPass = createPass({
    gl,
    fragmentSource: BILATERAL_FRAGMENT,
    uniformNames: ["u_mask", "u_frame", "u_maskTexel", "u_sigmaColor"],
  });
  const downsamplePass = createPass({
    gl,
    fragmentSource: DOWNSAMPLE_FRAGMENT,
    uniformNames: ["u_frame", "u_mask", "u_texel"],
  });
  const blurPass = createPass({
    gl,
    fragmentSource: MASKED_BLUR_FRAGMENT,
    uniformNames: ["u_texture", "u_texel", "u_direction", "u_radius", "u_firstPass"],
  });
  const compositePass = createPass({
    gl,
    fragmentSource: COMPOSITE_FRAGMENT,
    uniformNames: ["u_frame", "u_mask", "u_blur", "u_lightWrap", "u_debugMask"],
  });
  const frameTexture = createRenderTexture({
    gl,
    width: LINT_NUM_N2,
    height: LINT_NUM_N2,
    internalFormat: gl.RGBA8,
    format: gl.RGBA,
    type: gl.UNSIGNED_BYTE,
  });

  return {
    passes: { temporalPass, bilateralPass, downsamplePass, blurPass, compositePass },
    frameTexture,
  };
}

function createMeetBlurMaskPingPongState(input: {
  gl: WebGL2RenderingContext;
  initialBlurRadius: number;
  maskWidth: number;
  maskHeight: number;
}): MeetBlurMaskState {
  const makeSegMaskTarget = (): Target => {
    const texture = createRenderTexture({
      gl: input.gl,
      width: input.maskWidth,
      height: input.maskHeight,
      internalFormat: input.gl.R8,
      format: input.gl.RED,
      type: input.gl.UNSIGNED_BYTE,
    });

    return { texture, framebuffer: createFramebuffer({ gl: input.gl, texture }) };
  };

  return {
    maskWidth: input.maskWidth,
    maskHeight: input.maskHeight,
    segMaskRead: makeSegMaskTarget(),
    segMaskWrite: makeSegMaskTarget(),
    maskCount: 0,
    frameWidth: 0,
    frameHeight: 0,
    blurWidth: 0,
    blurHeight: 0,
    refinedMask: null,
    downsampled: null,
    blurPing: null,
    blurPong: null,
    blurRadiusTexels: Math.max(1, input.initialBlurRadius / BLUR_DOWNSAMPLE),
    isDebugMaskEnabled: false,
  };
}

function runMeetBlurSeparableBlurPasses(input: {
  gl: WebGL2RenderingContext;
  passes: MeetBlurPassBundle;
  state: MeetBlurMaskState;
  downsampled: Target;
  blurPing: Target;
  blurPong: Target;
  bindTexture: MeetBlurBindTexture;
  runPass: MeetBlurRunPass;
}) {
  input.gl.useProgram(input.passes.blurPass.program);
  input.bindTexture({
    unit: 0,
    texture: input.downsampled.texture,
    location: input.passes.blurPass.uniform("u_texture"),
  });
  input.gl.uniform2f(input.passes.blurPass.uniform("u_texel"), 1 / input.state.blurWidth, 1 / input.state.blurHeight);
  input.gl.uniform2f(input.passes.blurPass.uniform("u_direction"), 1, 0);
  input.gl.uniform1f(input.passes.blurPass.uniform("u_radius"), input.state.blurRadiusTexels);
  input.gl.uniform1f(input.passes.blurPass.uniform("u_firstPass"), 1);
  input.runPass({
    pass: input.passes.blurPass,
    framebuffer: input.blurPing.framebuffer,
    width: input.state.blurWidth,
    height: input.state.blurHeight,
    isFlipY: false,
  });
  input.bindTexture({ unit: 0, texture: input.blurPing.texture, location: input.passes.blurPass.uniform("u_texture") });
  input.gl.uniform2f(input.passes.blurPass.uniform("u_direction"), 0, 1);
  input.gl.uniform1f(input.passes.blurPass.uniform("u_firstPass"), 0);
  input.runPass({
    pass: input.passes.blurPass,
    framebuffer: input.blurPong.framebuffer,
    width: input.state.blurWidth,
    height: input.state.blurHeight,
    isFlipY: false,
  });
}

function renderMeetBlurPipelineFrame(input: {
  gl: WebGL2RenderingContext;
  passes: MeetBlurPassBundle;
  frameTexture: WebGLTexture;
  state: MeetBlurMaskState;
  allocateSizedTargets: (size: { width: number; height: number }) => void;
  resetState: () => void;
  bindTexture: MeetBlurBindTexture;
  runPass: MeetBlurRunPass;
  frame: VideoFrame;
}) {
  const scale = Math.min(
    1,
    MEETING_MEDIA_CONFIG.blur.maxProcessingWidth / input.frame.displayWidth,
    MEETING_MEDIA_CONFIG.blur.maxProcessingHeight / input.frame.displayHeight,
  );
  const width = Math.max(1, Math.round(input.frame.displayWidth * scale));
  const height = Math.max(1, Math.round(input.frame.displayHeight * scale));
  if (width !== input.state.frameWidth || height !== input.state.frameHeight) {
    input.allocateSizedTargets({ width, height });
  }
  const refinedMask = input.state.refinedMask;
  const downsampled = input.state.downsampled;
  const blurPing = input.state.blurPing;
  const blurPong = input.state.blurPong;
  if (refinedMask === null || downsampled === null || blurPing === null || blurPong === null) {
    throw new Error(WEBGL_PIPELINE_TARGETS_UNALLOCATED_MESSAGE);
  }
  input.resetState();
  input.gl.activeTexture(input.gl.TEXTURE0);
  input.gl.bindTexture(input.gl.TEXTURE_2D, input.frameTexture);
  input.gl.texImage2D(input.gl.TEXTURE_2D, 0, input.gl.RGBA, input.gl.RGBA, input.gl.UNSIGNED_BYTE, input.frame);
  input.gl.useProgram(input.passes.bilateralPass.program);
  input.bindTexture({
    unit: 0,
    texture: input.state.segMaskRead.texture,
    location: input.passes.bilateralPass.uniform("u_mask"),
  });
  input.bindTexture({ unit: 1, texture: input.frameTexture, location: input.passes.bilateralPass.uniform("u_frame") });
  input.gl.uniform2f(
    input.passes.bilateralPass.uniform("u_maskTexel"),
    1 / input.state.maskWidth,
    1 / input.state.maskHeight,
  );
  input.gl.uniform1f(input.passes.bilateralPass.uniform("u_sigmaColor"), BILATERAL_SIGMA_COLOR);
  input.runPass({
    pass: input.passes.bilateralPass,
    framebuffer: refinedMask.framebuffer,
    width,
    height,
    isFlipY: false,
  });
  input.gl.useProgram(input.passes.downsamplePass.program);
  input.bindTexture({ unit: 0, texture: input.frameTexture, location: input.passes.downsamplePass.uniform("u_frame") });
  input.bindTexture({ unit: 1, texture: refinedMask.texture, location: input.passes.downsamplePass.uniform("u_mask") });
  input.gl.uniform2f(
    input.passes.downsamplePass.uniform("u_texel"),
    1 / input.state.blurWidth,
    1 / input.state.blurHeight,
  );
  input.runPass({
    pass: input.passes.downsamplePass,
    framebuffer: downsampled.framebuffer,
    width: input.state.blurWidth,
    height: input.state.blurHeight,
    isFlipY: false,
  });
  runMeetBlurSeparableBlurPasses({
    gl: input.gl,
    passes: input.passes,
    state: input.state,
    downsampled,
    blurPing,
    blurPong,
    bindTexture: input.bindTexture,
    runPass: input.runPass,
  });
  input.gl.useProgram(input.passes.compositePass.program);
  input.bindTexture({ unit: 0, texture: input.frameTexture, location: input.passes.compositePass.uniform("u_frame") });
  input.bindTexture({ unit: 1, texture: refinedMask.texture, location: input.passes.compositePass.uniform("u_mask") });
  input.bindTexture({
    unit: LINT_NUM_N2,
    texture: blurPong.texture,
    location: input.passes.compositePass.uniform("u_blur"),
  });
  input.gl.uniform1f(input.passes.compositePass.uniform("u_lightWrap"), LIGHT_WRAP);
  input.gl.uniform1f(input.passes.compositePass.uniform("u_debugMask"), input.state.isDebugMaskEnabled ? 1 : 0);
  input.runPass({
    pass: input.passes.compositePass,
    framebuffer: null,
    width: input.frame.displayWidth,
    height: input.frame.displayHeight,
    isFlipY: true,
  });
  input.gl.bindVertexArray(null);
}

function destroyMeetBlurPipelineTarget(input: { gl: WebGL2RenderingContext; target: Target | null }) {
  if (input.target === null) {
    return;
  }
  input.gl.deleteTexture(input.target.texture);
  input.gl.deleteFramebuffer(input.target.framebuffer);
}

function allocateMeetBlurPipelineSizedTargets(input: {
  gl: WebGL2RenderingContext;
  state: MeetBlurMaskState;
  size: { width: number; height: number };
}) {
  const { gl, state, size } = input;
  destroyMeetBlurPipelineTarget({ gl, target: state.refinedMask });
  destroyMeetBlurPipelineTarget({ gl, target: state.downsampled });
  destroyMeetBlurPipelineTarget({ gl, target: state.blurPing });
  destroyMeetBlurPipelineTarget({ gl, target: state.blurPong });
  state.frameWidth = size.width;
  state.frameHeight = size.height;
  state.blurWidth = Math.max(1, Math.round(size.width / BLUR_DOWNSAMPLE));
  state.blurHeight = Math.max(1, Math.round(size.height / BLUR_DOWNSAMPLE));
  const refinedTexture = createRenderTexture({
    gl,
    width: size.width,
    height: size.height,
    internalFormat: gl.R8,
    format: gl.RED,
    type: gl.UNSIGNED_BYTE,
  });
  state.refinedMask = { texture: refinedTexture, framebuffer: createFramebuffer({ gl, texture: refinedTexture }) };
  const makeBlurTarget = (): Target => {
    const texture = createRenderTexture({
      gl,
      width: state.blurWidth,
      height: state.blurHeight,
      internalFormat: gl.RGBA16F,
      format: gl.RGBA,
      type: gl.HALF_FLOAT,
    });

    return { texture, framebuffer: createFramebuffer({ gl, texture }) };
  };
  state.downsampled = makeBlurTarget();
  state.blurPing = makeBlurTarget();
  state.blurPong = makeBlurTarget();
}

/**
 * MediaPipe shares this GL context and leaves arbitrary state behind, so
 * every batch of passes re-establishes the state it depends on.
 */
function resetMeetBlurPipelinePassState(input: { gl: WebGL2RenderingContext; vao: WebGLVertexArrayObject | null }) {
  input.gl.disable(input.gl.BLEND);
  input.gl.disable(input.gl.DEPTH_TEST);
  input.gl.disable(input.gl.STENCIL_TEST);
  input.gl.disable(input.gl.SCISSOR_TEST);
  input.gl.disable(input.gl.CULL_FACE);
  input.gl.pixelStorei(input.gl.UNPACK_FLIP_Y_WEBGL, false);
  input.gl.pixelStorei(input.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  input.gl.bindVertexArray(input.vao);
}

function bindMeetBlurPipelineTexture(input: {
  gl: WebGL2RenderingContext;
  unit: number;
  texture: WebGLTexture;
  location: WebGLUniformLocation | null;
}) {
  input.gl.activeTexture(input.gl.TEXTURE0 + input.unit);
  input.gl.bindTexture(input.gl.TEXTURE_2D, input.texture);
  input.gl.uniform1i(input.location, input.unit);
}

function runMeetBlurPipelineFullscreenPass(input: {
  gl: WebGL2RenderingContext;
  pass: Pass;
  framebuffer: WebGLFramebuffer | null;
  width: number;
  height: number;
  isFlipY: boolean;
}) {
  input.gl.useProgram(input.pass.program);
  input.gl.uniform1f(input.pass.uniform("u_flipY"), input.isFlipY ? 1 : 0);
  input.gl.bindFramebuffer(input.gl.FRAMEBUFFER, input.framebuffer);
  input.gl.viewport(0, 0, input.width, input.height);
  input.gl.drawArrays(input.gl.TRIANGLES, 0, LINT_NUM_N6);
}

function runMeetBlurTemporalMaskIngest(input: {
  gl: WebGL2RenderingContext;
  vao: WebGLVertexArrayObject | null;
  temporalPass: Pass;
  state: MeetBlurMaskState;
  maskTexture: WebGLTexture;
  shouldInvertMask: boolean;
  resetState: () => void;
  bindTexture: MeetBlurBindTexture;
  runPass: MeetBlurRunPass;
}) {
  const { gl, temporalPass, state, maskTexture, shouldInvertMask, resetState, bindTexture, runPass } = input;
  resetState();
  gl.useProgram(temporalPass.program);
  bindTexture({
    unit: 0,
    texture: maskTexture,
    location: temporalPass.uniform("u_confidence"),
  });
  bindTexture({ unit: 1, texture: state.segMaskRead.texture, location: temporalPass.uniform("u_previous") });
  gl.uniform1f(temporalPass.uniform("u_blend"), TEMPORAL_BLEND);
  gl.uniform1f(temporalPass.uniform("u_reset"), state.maskCount === 0 ? 1 : 0);
  gl.uniform1f(temporalPass.uniform("u_invert"), shouldInvertMask ? 1 : 0);
  runPass({
    pass: temporalPass,
    framebuffer: state.segMaskWrite.framebuffer,
    width: state.maskWidth,
    height: state.maskHeight,
    isFlipY: false,
  });
  const nextRead = state.segMaskWrite;
  state.segMaskWrite = state.segMaskRead;
  state.segMaskRead = nextRead;
  state.maskCount += 1;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindVertexArray(null);
}

function cleanupMeetBlurPipelineResources(input: {
  gl: WebGL2RenderingContext;
  vao: WebGLVertexArrayObject | null;
  quadBuffer: WebGLBuffer | null;
  passes: MeetBlurPassBundle;
  frameTexture: WebGLTexture;
  state: MeetBlurMaskState;
}) {
  const { gl, vao, quadBuffer, passes, frameTexture, state } = input;
  const { temporalPass, bilateralPass, downsamplePass, blurPass, compositePass } = passes;
  destroyMeetBlurPipelineTarget({ gl, target: state.refinedMask });
  destroyMeetBlurPipelineTarget({ gl, target: state.downsampled });
  destroyMeetBlurPipelineTarget({ gl, target: state.blurPing });
  destroyMeetBlurPipelineTarget({ gl, target: state.blurPong });
  state.refinedMask = null;
  state.downsampled = null;
  state.blurPing = null;
  state.blurPong = null;
  [state.segMaskRead, state.segMaskWrite].forEach((target) => {
    destroyMeetBlurPipelineTarget({ gl, target });
  });
  gl.deleteTexture(frameTexture);
  gl.deleteBuffer(quadBuffer);
  gl.deleteVertexArray(vao);
  [temporalPass, bilateralPass, downsamplePass, blurPass, compositePass].forEach((pass) => {
    gl.deleteProgram(pass.program);
  });
}

function createMeetBlurPipelineFromResources(input: {
  gl: WebGL2RenderingContext;
  vao: WebGLVertexArrayObject | null;
  quadBuffer: WebGLBuffer | null;
  passes: MeetBlurPassBundle;
  frameTexture: WebGLTexture;
  state: MeetBlurMaskState;
}): MeetBlurPipeline {
  const { gl, vao, quadBuffer, passes, frameTexture, state } = input;
  const { temporalPass } = passes;

  const allocateSizedTargets = (size: { width: number; height: number }) =>
    allocateMeetBlurPipelineSizedTargets({ gl, state, size });

  const resetState = () => resetMeetBlurPipelinePassState({ gl, vao });
  const bindTexture: MeetBlurBindTexture = (textureInput) =>
    bindMeetBlurPipelineTexture({
      gl,
      unit: textureInput.unit,
      texture: textureInput.texture,
      location: textureInput.location,
    });
  const runPass: MeetBlurRunPass = (passInput) =>
    runMeetBlurPipelineFullscreenPass({
      gl,
      pass: passInput.pass,
      framebuffer: passInput.framebuffer,
      width: passInput.width,
      height: passInput.height,
      isFlipY: passInput.isFlipY,
    });
  const render = (frame: VideoFrame) =>
    renderMeetBlurPipelineFrame({
      gl,
      passes,
      frameTexture,
      state,
      allocateSizedTargets,
      resetState,
      bindTexture,
      runPass,
      frame,
    });

  const ingestMask = (...args: [maskTexture: WebGLTexture, shouldInvertMask: boolean]) => {
    const [maskTexture, shouldInvertMask] = args;
    runMeetBlurTemporalMaskIngest({
      gl,
      vao,
      temporalPass,
      state,
      maskTexture,
      shouldInvertMask,
      resetState,
      bindTexture,
      runPass,
    });
  };

  return {
    ingestMask,
    hasMask: () => state.maskCount > 0,
    render,
    setBlurRadius: (radius: number) => {
      state.blurRadiusTexels = Math.max(1, radius / BLUR_DOWNSAMPLE);
    },
    setDebugMask: (isDebugMaskEnabled: boolean) => {
      state.isDebugMaskEnabled = isDebugMaskEnabled;
    },
    cleanup: () => cleanupMeetBlurPipelineResources({ gl, vao, quadBuffer, passes, frameTexture, state }),
  };
}

function createMeetBlurPipelineNamed(input: {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  initialBlurRadius: number;
  maskSize?: { width: number; height: number };
}): MeetBlurPipeline {
  const { canvas, initialBlurRadius } = input;
  const gl = createMeetBlurWebGLContext(canvas);
  const { vao, quadBuffer } = createMeetBlurFullscreenQuad(gl);
  const { passes, frameTexture } = createMeetBlurPassBundleAndFrameTexture(gl);
  const state = createMeetBlurMaskPingPongState({
    gl,
    initialBlurRadius,
    maskWidth: input.maskSize?.width ?? SEG_WIDTH,
    maskHeight: input.maskSize?.height ?? SEG_HEIGHT,
  });

  return createMeetBlurPipelineFromResources({ gl, vao, quadBuffer, passes, frameTexture, state });
}

export function createMeetBlurPipeline(
  ...args: [
    canvas: OffscreenCanvas | HTMLCanvasElement,
    initialBlurRadius: number,
    maskSize?: { width: number; height: number },
  ]
): MeetBlurPipeline {
  const [canvas, initialBlurRadius, maskSize] = args;

  return createMeetBlurPipelineNamed({ canvas, initialBlurRadius, maskSize });
}
