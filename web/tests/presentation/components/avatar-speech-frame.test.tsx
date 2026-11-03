import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, render } from "@testing-library/react";
import assert from "node:assert/strict";
import { registerHooks, type ResolveHookSync } from "node:module";
import test from "node:test";
import { Profiler } from "react";

import { createParticipantSpeechStore } from "../../../domain/participant-speech-store";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const AVATAR_SPEECH_FRAME_TEST_COPY = {
  avatarImageLabel: "Avatar image",
  otherAvatarLabel: "Other avatar",
  avatarLabel: "Avatar",
  demoAvatarLabel: "Demo avatar",
  participantSam: "personbr",
  participantMika: "personbd",
};

const SILENT_LEVEL_UPDATE_SAMPLES = 5;
const SPEAKING_LEVEL_UPDATE_SAMPLES = 100;
const SPEECH_LEVEL_PERCENT_DIVISOR = 100;
const EXPECTED_SPEAKING_HALO_SCALE = "1.240";
const EXPECTED_SILENT_HALO_OPACITY = "0.000";
const EXPECTED_DEMO_SPEAKING_HALO_OPACITY = "0.580";
const EXPECTED_DEMO_IDLE_HALO_SCALE = "0.780";
const SPEECH_LEVEL_WHILE_VISIBLE = 0.1;
const SPEECH_LEVEL_WHILE_HIDDEN = 0.2;
const SPEECH_LEVEL_WHILE_OFFSCREEN = 0.3;
const SPEECH_LEVEL_WHILE_CAMERA_COVERED = 0.05;
const SPEECH_LEVEL_AFTER_UNMOUNT = 0.9;
const MINIMUM_INTERSECTION_OBSERVER_DISCONNECTS = 2;

const resolveAvatarSpeechFrameCss: ResolveHookSync = (specifier, context, nextResolve) => {
  if (!specifier.endsWith(".module.css")) {
    return nextResolve(specifier, context);
  }

  return {
    shortCircuit: true,
    url: 'data:text/javascript,export default {speechFrame:"speechFrame",speechHalo:"speechHalo",isSpeaking:"isSpeaking"};',
  };
};

const css = registerHooks({ resolve: resolveAvatarSpeechFrameCss });
const { AvatarSpeechFrame } = await import("../../../presentation/components/avatar-speech-frame");
css.deregister();

function createIntersectionObserverEntry(input: { isIntersecting: boolean }): IntersectionObserverEntry {
  return {
    boundingClientRect: new DOMRectReadOnly(0, 0, 0, 0),
    intersectionRatio: input.isIntersecting ? 1 : 0,
    intersectionRect: new DOMRectReadOnly(0, 0, 0, 0),
    isIntersecting: input.isIntersecting,
    rootBounds: null,
    target: document.createElement("div"),
    time: 0,
  };
}

class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = "0px";
  readonly thresholds: readonly number[] = [0];

  constructor(private readonly onDisconnect: () => void) {}

  disconnect(): void {
    this.onDisconnect();
  }

  observe(): void {}

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(): void {}
}

function querySpeechHalo(container: HTMLElement): HTMLElement {
  const element = container.querySelector(".speechHalo");
  assert.ok(element instanceof HTMLElement);

  return element;
}

function querySpeechFrame(container: HTMLElement): HTMLElement {
  const element = container.querySelector(".speechFrame");
  assert.ok(element instanceof HTMLElement);

  return element;
}

function firstElementChildElement(parent: HTMLElement): HTMLElement {
  const child = parent.firstElementChild;
  assert.ok(child instanceof HTMLElement);

  return child;
}

void test("active speech updates only its frame, preserving the avatar and other participants", () => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const store = createParticipantSpeechStore();
  const renders = { parent: 0, image: 0, speaker: 0, other: 0 };
  function Image() {
    renders.image += 1;

    return <span>{AVATAR_SPEECH_FRAME_TEST_COPY.avatarImageLabel}</span>;
  }
  function Parent() {
    renders.parent += 1;

    return (
      <>
        <Profiler id="speaker" onRender={() => (renders.speaker += 1)}>
          <AvatarSpeechFrame
            speechLevel={0}
            isSpeaking={false}
            speechSource={store.forParticipant(AVATAR_SPEECH_FRAME_TEST_COPY.participantSam)}
          >
            <Image />
          </AvatarSpeechFrame>
        </Profiler>
        <Profiler id="other" onRender={() => (renders.other += 1)}>
          <AvatarSpeechFrame
            speechLevel={0}
            isSpeaking={false}
            speechSource={store.forParticipant(AVATAR_SPEECH_FRAME_TEST_COPY.participantMika)}
          >
            {AVATAR_SPEECH_FRAME_TEST_COPY.otherAvatarLabel}
          </AvatarSpeechFrame>
        </Profiler>
      </>
    );
  }
  const view = render(<Parent />);
  try {
    const otherBefore = renders.other;
    const speakerBefore = renders.speaker;
    Array.from({ length: SILENT_LEVEL_UPDATE_SAMPLES }, (_, index) => index + 1).forEach((sample) => {
      act(() =>
        store.update(() => ({
          personbr: { level: sample / SPEECH_LEVEL_PERCENT_DIVISOR, isSpeaking: false },
        })),
      );
    });
    assert.equal(renders.speaker, speakerBefore);
    Array.from({ length: SPEAKING_LEVEL_UPDATE_SAMPLES }, (_, index) => index + 1).forEach((sample) => {
      act(() =>
        store.update(() => ({
          personbr: { level: sample / SPEECH_LEVEL_PERCENT_DIVISOR, isSpeaking: true },
        })),
      );
    });
    assert.equal(renders.parent, 1);
    assert.equal(renders.image, 1);
    assert.equal(renders.other, otherBefore);
    const frame = querySpeechFrame(view.container);
    assert.ok(frame.classList.contains("isSpeaking"));
    assert.equal(
      firstElementChildElement(frame).style.getPropertyValue("--avatar-speech-scale"),
      EXPECTED_SPEAKING_HALO_SCALE,
    );
    act(() => store.update(() => ({})));
    assert.equal(frame.classList.contains("isSpeaking"), false);
    assert.equal(
      firstElementChildElement(frame).style.getPropertyValue("--avatar-speech-opacity"),
      EXPECTED_SILENT_HALO_OPACITY,
    );
  } finally {
    view.unmount();
  }
});

void test("hidden, offscreen and camera-covered frames pause subscriptions and resume at current speech", (t) => {
  const store = createParticipantSpeechStore();
  const source = store.forParticipant(AVATAR_SPEECH_FRAME_TEST_COPY.participantSam);
  const observerState: { intersection: IntersectionObserverCallback | undefined; disconnected: number } = {
    intersection: undefined,
    disconnected: 0,
  };
  t.mock.method(globalThis, "IntersectionObserver", function (callback: IntersectionObserverCallback) {
    observerState.intersection = callback;

    return new TestIntersectionObserver(() => {
      observerState.disconnected += 1;
    });
  });
  const frame = (isSpeechVisible = true) => (
    <AvatarSpeechFrame speechLevel={0} isSpeaking={false} speechSource={source} isSpeechVisible={isSpeechVisible}>
      {AVATAR_SPEECH_FRAME_TEST_COPY.avatarLabel}
    </AvatarSpeechFrame>
  );
  const view = render(frame());
  const level = () => querySpeechHalo(view.container).style.getPropertyValue("--avatar-speech-scale");
  const publish = (value: number) =>
    act(() =>
      store.update(() => ({
        personbr: { level: value, isSpeaking: true },
      })),
    );
  const setDocumentVisible = (isDocumentVisible: boolean) =>
    act(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: !isDocumentVisible });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  const intersectionObserver = new TestIntersectionObserver(() => {});
  try {
    publish(SPEECH_LEVEL_WHILE_VISIBLE);
    const first = level();
    setDocumentVisible(false);
    publish(SPEECH_LEVEL_WHILE_HIDDEN);
    assert.equal(level(), first);
    setDocumentVisible(true);
    assert.notEqual(level(), first);
    const second = level();
    act(() =>
      observerState.intersection?.([createIntersectionObserverEntry({ isIntersecting: false })], intersectionObserver),
    );
    publish(SPEECH_LEVEL_WHILE_OFFSCREEN);
    assert.equal(level(), second);
    act(() =>
      observerState.intersection?.([createIntersectionObserverEntry({ isIntersecting: true })], intersectionObserver),
    );
    assert.notEqual(level(), second);
    view.rerender(frame(false));
    const covered = level();
    publish(SPEECH_LEVEL_WHILE_CAMERA_COVERED);
    assert.equal(level(), covered);
    view.rerender(frame());
    assert.notEqual(level(), covered);
    view.unmount();
    publish(SPEECH_LEVEL_AFTER_UNMOUNT);
    assert.ok(observerState.disconnected >= MINIMUM_INTERSECTION_OBSERVER_DISCONNECTS);
  } finally {
    view.unmount();
    setDocumentVisible(true);
  }
});

void test("public demo props still drive the same speaking styles without a subscription", () => {
  const view = render(
    <AvatarSpeechFrame speechLevel={1} isSpeaking>
      {AVATAR_SPEECH_FRAME_TEST_COPY.demoAvatarLabel}
    </AvatarSpeechFrame>,
  );
  try {
    assert.ok(view.container.querySelector(".speechFrame.isSpeaking"));
    const halo = querySpeechHalo(view.container);
    assert.equal(halo.style.getPropertyValue("--avatar-speech-scale"), EXPECTED_SPEAKING_HALO_SCALE);
    assert.equal(halo.style.getPropertyValue("--avatar-speech-opacity"), EXPECTED_DEMO_SPEAKING_HALO_OPACITY);
    view.rerender(
      <AvatarSpeechFrame speechLevel={1} isSpeaking={false}>
        {AVATAR_SPEECH_FRAME_TEST_COPY.demoAvatarLabel}
      </AvatarSpeechFrame>,
    );
    assert.equal(halo.style.getPropertyValue("--avatar-speech-scale"), EXPECTED_DEMO_IDLE_HALO_SCALE);
    assert.equal(halo.style.getPropertyValue("--avatar-speech-opacity"), EXPECTED_SILENT_HALO_OPACITY);
  } finally {
    view.unmount();
  }
});
