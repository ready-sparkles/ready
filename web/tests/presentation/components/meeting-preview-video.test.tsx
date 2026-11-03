import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { type LocalVideoTrack, TrackEvent } from "livekit-client";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { z } from "zod";

import { MeetingPreviewVideo } from "../../../presentation/components/meeting-preview-video";

const AVATAR_INITIAL = "S";
const PREVIEW_VIDEO_SDK_MUST_NOT_OWN_PREVIEW_VIDEO_SOURCE = "The SDK must not own the preview video source";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

void test("keeps raw camera hidden behind the avatar until processed frames arrive", async (t) => {
  t.mock.method(HTMLVideoElement.prototype, "play", async () => {});
  const callbacks = new Map<number, { video: HTMLVideoElement; callback: VideoFrameRequestCallback }>();
  const ids = { next: 0 };
  const frameDescriptors = Object.getOwnPropertyDescriptors(HTMLVideoElement.prototype);
  Object.defineProperties(HTMLVideoElement.prototype, {
    requestVideoFrameCallback: {
      configurable: true,
      value(this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
        ids.next += 1;
        callbacks.set(ids.next, { video: this, callback });

        return ids.next;
      },
    },
    cancelVideoFrameCallback: {
      configurable: true,
      value(id: number) {
        callbacks.delete(id);
      },
    },
  });
  t.after(() => {
    cleanup();
    ["requestVideoFrameCallback", "cancelVideoFrameCallback"].forEach((name) => {
      const descriptor = frameDescriptors[name];
      if (descriptor) {
        Object.defineProperty(HTMLVideoElement.prototype, name, descriptor);
      } else {
        Reflect.deleteProperty(HTMLVideoElement.prototype, name);
      }
    });
  });
  const processorState: { processedTrack?: MediaStreamTrack } = {};
  const track = z
    .custom<LocalVideoTrack>((_value): _value is LocalVideoTrack => true)
    .parse(
      Object.assign(new EventEmitter(), {
        getProcessor: () => (processorState.processedTrack ? processorState : undefined),
        attach: () => {
          throw new Error(PREVIEW_VIDEO_SDK_MUST_NOT_OWN_PREVIEW_VIDEO_SOURCE);
        },
      }),
    );
  const stream = new MediaStream();
  const view = (isEnabled: boolean) => (
    <MeetingPreviewVideo
      stream={stream}
      track={track}
      showProcessed={isEnabled}
      className="preview"
      placeholder={<span data-testid="avatar">{AVATAR_INITIAL}</span>}
    />
  );
  const rendered = render(view(false));
  const camera = rendered.container.querySelector<HTMLVideoElement>('[data-preview-source="camera"]');
  assert.ok(camera);
  assert.equal(camera.srcObject, stream);

  rendered.rerender(view(true));
  assert.equal(rendered.container.querySelector('[data-preview-source="camera"]'), camera);
  assert.equal(rendered.container.querySelector('[data-preview-source="processed"]'), null);
  assert.equal(camera.style.visibility, "hidden");
  assert.ok(rendered.queryByTestId("avatar"));
  processorState.processedTrack = z
    .custom<MediaStreamTrack>((_value): _value is MediaStreamTrack => true)
    .parse({ id: "processed-camera" });
  await act(async () => {
    track.emit(TrackEvent.TrackProcessorUpdate);
  });
  const processed = rendered.container.querySelector<HTMLVideoElement>('[data-preview-source="processed"]');
  assert.ok(processed);
  assert.equal(processed.style.opacity, "0");
  const paint = async () => {
    const entry = [...callbacks].find(([, value]) => value.video === processed);
    assert.ok(entry);
    callbacks.delete(entry[0]);
    await act(async () => {
      entry[1].callback(
        0,
        z.custom<VideoFrameCallbackMetadata>((_value): _value is VideoFrameCallbackMetadata => true).parse({}),
      );
    });
  };
  await paint();
  assert.equal(processed.style.opacity, "0", "initial empty canvas frame keeps the avatar visible");
  await paint();
  assert.equal(processed.style.opacity, "1");
  assert.equal(rendered.queryByTestId("avatar"), null);
  assert.equal(camera.style.visibility, "hidden");
  assert.equal(camera.srcObject, stream, "camera source remains untouched underneath the processed video");

  rendered.rerender(view(false));
  assert.equal(rendered.container.querySelector('[data-preview-source="processed"]'), null);
  assert.equal(camera.srcObject, stream);
  rendered.rerender(view(true));
  assert.equal(callbacks.size, 1);
  rendered.rerender(view(false));
  assert.equal(callbacks.size, 0, "disabling during warmup cancels its pending reveal");
  assert.equal(rendered.container.querySelector('[data-preview-source="camera"]'), camera);
});
