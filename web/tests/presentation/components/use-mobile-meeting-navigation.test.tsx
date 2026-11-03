import "../../memory-dom";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

import { useMobileMeetingNavigation } from "../../../presentation/components/use-mobile-meeting-navigation";

afterEach(cleanup);
after(async () => GlobalRegistrator.unregister());
const globalRecord: Record<string, unknown> = globalThis;
const happyDom = globalRecord["happyDOM"];
if (typeof happyDom === "object" && happyDom !== null && "setURL" in happyDom) {
  const setUrl = Reflect.get(happyDom, "setURL");
  if (typeof setUrl === "function") {
    Reflect.apply(setUrl, happyDom, ["http://localhost:3000"]);
  }
}
const id = "11111111-1111-4111-8111-111111111111";

(["past", "upcoming"] as const).forEach((view) => {
  void test(`${view}: mobile starts unselected, preserves the mounted detail on Back, and follows history`, (t) => {
    window.history.replaceState(null, "", `/workspace?view=${view}`);
    const matchMedia = window.matchMedia.bind(window);
    t.mock.method(window, "matchMedia", (query: string) => {
      const media = matchMedia(query);
      Object.defineProperty(media, "matches", { value: true });

      return media;
    });
    const back = t.mock.method(window.history, "back", () => {});
    const { result } = renderHook(() => useMobileMeetingNavigation({ view, initialMeetingId: null }));
    assert.equal(result.current.isMobile, true);
    assert.equal(result.current.isOpen, false);
    assert.equal(result.current.detailId, null);
    act(() => {
      result.current.open(id);
    });
    const detailUrl = window.location.href;
    assert.equal(result.current.isOpen, true);
    assert.equal(result.current.detailId, id);
    act(() => {
      result.current.close();
    });
    assert.equal(back.mock.callCount(), 1);
    assert.equal(result.current.isOpen, false);
    assert.equal(result.current.detailId, id, "retain document through the closing transition");
    act(() => {
      window.history.replaceState(null, "", `/workspace?view=${view}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    assert.equal(result.current.isOpen, false);
    act(() => {
      window.history.replaceState({ readyMobileMeeting: view }, "", detailUrl);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    assert.equal(result.current.isOpen, true);
    assert.equal(result.current.detailId, id);
  });
});

void test("direct meeting links open their document and Back stays inside the workspace", (t) => {
  window.history.replaceState(null, "", `/workspace/${id}`);
  const back = t.mock.method(window.history, "back", () => {});
  const { result } = renderHook(() => useMobileMeetingNavigation({ view: "past", initialMeetingId: id }));
  assert.equal(result.current.isOpen, true);
  act(() => {
    result.current.close();
  });
  assert.equal(back.mock.callCount(), 0, "a direct link must not send the user out of the app");
  assert.equal(window.location.pathname + window.location.search, "/workspace?view=past");
  assert.equal(result.current.detailId, id);
});

void test("desktop keeps the navigation inactive; changing sections clears mobile selection", (t) => {
  window.history.replaceState(null, "", "/workspace?view=past");
  const matchMedia = window.matchMedia.bind(window);
  t.mock.method(window, "matchMedia", (query: string) => {
    const media = matchMedia(query);
    Object.defineProperty(media, "matches", { value: false });

    return media;
  });
  const { result, rerender } = renderHook(
    ({ view }: { view: "past" | "upcoming" }) => useMobileMeetingNavigation({ view, initialMeetingId: null }),
    { initialProps: { view: "past" } },
  );
  assert.equal(result.current.isMobile, false);
  act(() => {
    result.current.open(id);
  });
  window.history.replaceState(null, "", "/workspace?view=upcoming");
  rerender({ view: "upcoming" });
  assert.equal(result.current.isOpen, false);
  assert.equal(result.current.detailId, null);
});
