import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { z } from "zod";

import { MeetingProUpgradeCard } from "../../../presentation/components/meeting-pro-upgrade-card";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const MEETING_PRO_UPGRADE_CARD_TEST_COPY = {
  checkoutResponseNotRequested: "Checkout response was not requested",
  expectedCheckoutRequest: "Expected a checkout request",
  checkoutTemporarilyUnavailable: "Checkout is temporarily unavailable.",
  expectedCheckoutUrl: "Expected a checkout URL",
  intersectionObserverNotInstalled: "Intersection observer was not installed",
  expectedFlipPage: "Expected a flip page",
  doNotDecodeOnNavigation: "Do not decode another animation sequence on navigation",
  missingRequestBody: "Expected a checkout request body",
};

const INTERSECTION_THRESHOLD = 0.5;
const HTTP_STATUS_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVICE_UNAVAILABLE = 503;
const EXPECTED_CHECKOUT_REQUEST_COUNT = 1;
const EXPECTED_CHECKOUT_RETRY_COUNT = 2;
const EXPECTED_IMAGE_DECODE_COUNT = 19;
const FLIP_ANIMATION_COUNT_WHEN_COMPLETED = 18;
const FLIP_ANIMATION_COUNT_WHEN_INCOMPLETE = 1;

const TEST_YEAR = 2026;
const TEST_MONTH_INDEX_SEPTEMBER = 8;
const TEST_DAY_19 = 19;
const TEST_DAY_30 = 30;
const TEST_DAY_1 = 1;
const TEST_DAY_2 = 2;
const TEST_DAY_21 = 21;
const TEST_HOUR_NOON = 12;
const TEST_HOUR_ALMOST_MIDNIGHT = 23;
const TEST_MINUTE_59 = 59;
const TEST_SECOND_59 = 59;
const ONE_SECOND_MS = 1000;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const ONE_DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * ONE_SECOND_MS;

const CHECKOUT_FAILURE_STATUSES: readonly number[] = [HTTP_FORBIDDEN, HTTP_SERVICE_UNAVAILABLE];
const NAVIGATION_PLAYBACK_COMPLETED_VALUES: readonly boolean[] = [false, true];
const REMOUNT_ITERATION_INDICES: readonly number[] = [0, 1];

const checkoutRequestBodySchema = z.object({ interval: z.literal("month") });
type CheckoutRequestBody = z.infer<typeof checkoutRequestBodySchema>;

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }

  return "";
}

function parseCheckoutRequestBody(init?: RequestInit) {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error(MEETING_PRO_UPGRADE_CARD_TEST_COPY.missingRequestBody);
  }

  return checkoutRequestBodySchema.parse(JSON.parse(body));
}

function createIntersectionObserverEntry(input: {
  isIntersecting: boolean;
  target?: Element;
}): IntersectionObserverEntry {
  return {
    boundingClientRect: new DOMRectReadOnly(0, 0, 0, 0),
    intersectionRatio: input.isIntersecting ? 1 : 0,
    intersectionRect: new DOMRectReadOnly(0, 0, 0, 0),
    isIntersecting: input.isIntersecting,
    rootBounds: null,
    target: input.target ?? document.createElement("div"),
    time: 0,
  };
}

function createReducedMotionMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    onchange: null,
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return true;
    },
  };
}

// Checkout behavior is independent of the decorative page-turn animation.
beforeEach((t) => {
  assert.ok("mock" in t);
  const matchMedia = window.matchMedia.bind(window);
  t.mock.method(window, "matchMedia", (query: string) => {
    const media = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(media, "matches", { value: true });
    }

    return media;
  });
  t.mock.method(globalThis, "IntersectionObserver", function (callback: IntersectionObserverCallback) {
    const observer: IntersectionObserver = {
      root: null,
      rootMargin: "0px",
      thresholds: [INTERSECTION_THRESHOLD],
      observe(target) {
        callback([createIntersectionObserverEntry({ isIntersecting: true, target })], observer);
      },
      disconnect() {},
      unobserve() {},
      takeRecords() {
        return [];
      },
    };

    return observer;
  });
});

void test("upgrade opens monthly Stripe checkout for the current workspace, once", async (t) => {
  t.after(cleanup);
  const requestLog: {
    entries: { url: string; body: CheckoutRequestBody; authorization: string | null }[];
  } = { entries: [] };
  const redirectLog: { entries: string[] } = { entries: [] };
  const checkout = {
    resolve: (_response: Response): void => {
      throw new Error(MEETING_PRO_UPGRADE_CARD_TEST_COPY.checkoutResponseNotRequested);
    },
  };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requestLog.entries = [
      ...requestLog.entries,
      {
        url: resolveFetchUrl(input),
        body: parseCheckoutRequestBody(init),
        authorization: new Headers(init?.headers).get("Authorization"),
      },
    ];

    return new Promise<Response>((resolve) => {
      checkout.resolve = resolve;
    });
  });
  t.mock.method(window.location, "assign", (url: string) => {
    redirectLog.entries = [...redirectLog.entries, url];
  });
  const screen = render(<MeetingProUpgradeCard token="test-token" workspaceId="current-workspace" />);
  const button = screen.getByRole("button", { name: "Upgrade to Pro" });
  fireEvent.click(button);
  fireEvent.click(button);
  assert.equal(requestLog.entries.length, EXPECTED_CHECKOUT_REQUEST_COUNT);
  const checkoutRequest = requestLog.entries[0];
  if (checkoutRequest === undefined) {
    throw new Error(MEETING_PRO_UPGRADE_CARD_TEST_COPY.expectedCheckoutRequest);
  }
  assert.ok(checkoutRequest.url.endsWith("/workspaces/current-workspace/billing/checkout"));
  assert.deepEqual(checkoutRequest.body, { interval: "month" });
  assert.equal(checkoutRequest.authorization, "Bearer test-token");
  assert.equal(screen.getByRole("button", { name: "Opening Stripe…" }).getAttribute("disabled"), "");
  await act(async () =>
    checkout.resolve(
      new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/test" }), {
        status: HTTP_STATUS_OK,
      }),
    ),
  );
  assert.deepEqual(redirectLog.entries, ["https://checkout.stripe.com/c/pay/test"]);
});

CHECKOUT_FAILURE_STATUSES.forEach((status) => {
  void test(`checkout failure ${status} explains the problem and permits a retry`, async (t) => {
    t.after(cleanup);
    const requests = { count: 0 };
    t.mock.method(globalThis, "fetch", async () => {
      requests.count += 1;

      return new Response(
        JSON.stringify({ message: MEETING_PRO_UPGRADE_CARD_TEST_COPY.checkoutTemporarilyUnavailable }),
        {
          status,
        },
      );
    });
    const screen = render(<MeetingProUpgradeCard token="test-token" workspaceId="current-workspace" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" })));
    assert.match(
      screen.getByRole("alert").textContent,
      status === HTTP_FORBIDDEN ? /workspace owner/ : /temporarily unavailable/,
    );
    assert.equal(screen.getByRole("button", { name: "Upgrade to Pro" }).hasAttribute("disabled"), false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upgrade to Pro" })));
    assert.equal(requests.count, EXPECTED_CHECKOUT_RETRY_COUNT);
  });
});

void test("a processing payment cannot start another checkout", async (t) => {
  t.after(cleanup);
  const requests = { count: 0 };
  t.mock.method(globalThis, "fetch", async () => {
    requests.count += 1;

    return new Response("{}");
  });
  const screen = render(
    <MeetingProUpgradeCard token="test-token" workspaceId="workspace" paymentStatus="processing" />,
  );
  const button = screen.getByRole("button", { name: "Payment processing" });
  assert.ok(button.hasAttribute("disabled"));
  fireEvent.click(button);
  assert.equal(requests.count, 0);
});

void test("a failed upgrade can start a fresh monthly checkout", async (t) => {
  t.after(cleanup);
  const urlLog: { entries: string[] } = { entries: [] };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    urlLog.entries = [...urlLog.entries, resolveFetchUrl(input)];

    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/test" }));
  });
  t.mock.method(window.location, "assign", () => {});
  const screen = render(<MeetingProUpgradeCard token="test-token" workspaceId="workspace" paymentStatus="failed" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try upgrading again" })));
  assert.equal(urlLog.entries.length, 1);
  const checkoutUrl = urlLog.entries[0];
  if (checkoutUrl === undefined) {
    throw new Error(MEETING_PRO_UPGRADE_CARD_TEST_COPY.expectedCheckoutUrl);
  }
  assert.ok(checkoutUrl.endsWith("/billing/checkout"));
});

void test("date and weekday update at local midnight, including a new month", (t) => {
  t.after(cleanup);
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: new Date(
      TEST_YEAR,
      TEST_MONTH_INDEX_SEPTEMBER,
      TEST_DAY_30,
      TEST_HOUR_ALMOST_MIDNIGHT,
      TEST_MINUTE_59,
      TEST_SECOND_59,
    ).getTime(),
  });
  const screen = render(<MeetingProUpgradeCard />);
  const image = () => screen.container.querySelector(".meeting-pro-art-logo");
  const weekday = () => screen.container.querySelector(".meeting-pro-logo-weekday")?.textContent;
  assert.equal(image()?.getAttribute("src"), "/logos/days/30.svg");
  assert.equal(weekday(), "Wed");
  act(() => t.mock.timers.tick(ONE_SECOND_MS));
  assert.equal(image()?.getAttribute("src"), `/logos/days/${TEST_DAY_1}.svg`);
  assert.equal(weekday(), "Thu");
  act(() => t.mock.timers.tick(ONE_DAY_MS));
  assert.equal(image()?.getAttribute("src"), "/logos/days/2.svg");
  assert.equal(weekday(), "Fri");
});

void test("date catches up on focus after a sleeping tab missed midnight", async (t) => {
  t.after(cleanup);
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: new Date(TEST_YEAR, TEST_MONTH_INDEX_SEPTEMBER, TEST_DAY_19, TEST_HOUR_NOON).getTime(),
  });
  const screen = render(<MeetingProUpgradeCard />);
  t.mock.timers.setTime(new Date(TEST_YEAR, TEST_MONTH_INDEX_SEPTEMBER, TEST_DAY_21, TEST_HOUR_NOON).getTime());
  await act(async () => window.dispatchEvent(new Event("focus")));
  assert.equal(
    screen.container.querySelector(".meeting-pro-art-logo")?.getAttribute("src"),
    `/logos/days/${TEST_DAY_21}.svg`,
  );
  assert.equal(screen.container.querySelector(".meeting-pro-logo-weekday")?.textContent, "Mon");
});

void test("offscreen illustrations render no image and defer decoding until intersection", async (t) => {
  t.after(cleanup);
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: new Date(TEST_YEAR, TEST_MONTH_INDEX_SEPTEMBER, TEST_DAY_19, TEST_HOUR_NOON).getTime(),
  });
  t.mock.method(window, "matchMedia", (query: string) => createReducedMotionMatchMedia(query));
  const intersection = {
    reportIntersection: (isVisible: boolean): void => {
      void isVisible;
      throw new Error(MEETING_PRO_UPGRADE_CARD_TEST_COPY.intersectionObserverNotInstalled);
    },
  };
  t.mock.method(globalThis, "IntersectionObserver", function (callback: IntersectionObserverCallback) {
    const observer: IntersectionObserver = {
      root: null,
      rootMargin: "0px",
      thresholds: [INTERSECTION_THRESHOLD],
      observe() {},
      disconnect() {},
      unobserve() {},
      takeRecords() {
        return [];
      },
    };
    intersection.reportIntersection = (isVisible) =>
      callback([createIntersectionObserverEntry({ isIntersecting: isVisible })], observer);

    return observer;
  });
  const decodes = { count: 0 };
  t.mock.method(HTMLImageElement.prototype, "decode", async () => {
    decodes.count += 1;
  });
  const screen = render(<MeetingProUpgradeCard />);
  assert.equal(decodes.count, 0);
  assert.equal(screen.container.querySelector(".meeting-pro-art img"), null);
  await act(async () => intersection.reportIntersection(false));
  assert.equal(decodes.count, 0);
  assert.equal(screen.container.querySelector(".meeting-pro-art img"), null);
  await act(async () => intersection.reportIntersection(true));
  assert.equal(decodes.count, EXPECTED_IMAGE_DECODE_COUNT);
  assert.ok(screen.container.querySelector(".meeting-pro-flip-page"));
  const flipPage = screen.container.querySelector(".meeting-pro-flip-page");
  if (flipPage === null) {
    throw new Error(MEETING_PRO_UPGRADE_CARD_TEST_COPY.expectedFlipPage);
  }
  await act(async () => fireEvent.animationEnd(flipPage));
  assert.equal(decodes.count, EXPECTED_IMAGE_DECODE_COUNT);
  assert.equal(
    screen.container.querySelector(".meeting-pro-art-logo")?.getAttribute("src"),
    `/logos/days/${TEST_DAY_2}.svg`,
  );
});

void test("initial markup omits the mark until local date and motion preference are known", async (t) => {
  t.after(cleanup);
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: new Date(TEST_YEAR, TEST_MONTH_INDEX_SEPTEMBER, TEST_DAY_19, TEST_HOUR_NOON).getTime(),
  });
  const { renderToString } = await import("react-dom/server");
  const markup = renderToString(<MeetingProUpgradeCard />);
  assert.doesNotMatch(markup, /logos\/days\//);
  const decodes = { count: 0 };
  t.mock.method(HTMLImageElement.prototype, "decode", async () => {
    decodes.count += 1;
  });
  const screen = render(<MeetingProUpgradeCard />);
  assert.equal(
    screen.container.querySelector(".meeting-pro-art-logo")?.getAttribute("src"),
    `/logos/days/${TEST_DAY_19}.svg`,
  );
  assert.equal(screen.container.querySelector(".meeting-pro-logo-weekday")?.textContent, "Sat");
  assert.equal(screen.container.querySelector(".meeting-pro-flip-page"), null);
  assert.equal(decodes.count, 0);
});

NAVIGATION_PLAYBACK_COMPLETED_VALUES.forEach((isCompleted) => {
  void test(`memory navigation does not replay the logo intro (completed: ${isCompleted})`, async (t) => {
    t.after(cleanup);
    t.mock.timers.enable({
      apis: ["Date", "setTimeout"],
      now: new Date(TEST_YEAR, TEST_MONTH_INDEX_SEPTEMBER, TEST_DAY_19, TEST_HOUR_NOON).getTime(),
    });
    t.mock.method(window, "matchMedia", (query: string) => createReducedMotionMatchMedia(query));
    const decodes = { count: 0 };
    t.mock.method(HTMLImageElement.prototype, "decode", async () => {
      decodes.count += 1;
    });
    const banner = <MeetingProUpgradeCard logoPlaybackKey={`navigation-${isCompleted}`} />;
    const initialScreen = render(banner);
    await act(async () => {});
    assert.ok(initialScreen.container.querySelector(".meeting-pro-flip-page"));
    const flipCount = isCompleted ? FLIP_ANIMATION_COUNT_WHEN_COMPLETED : FLIP_ANIMATION_COUNT_WHEN_INCOMPLETE;
    await Array.from({ length: flipCount }).reduce(async (previous) => {
      await previous;
      const page = initialScreen.container.querySelector(".meeting-pro-flip-page");
      if (page === null) {
        throw new Error(MEETING_PRO_UPGRADE_CARD_TEST_COPY.expectedFlipPage);
      }
      await act(async () => fireEvent.animationEnd(page));
    }, Promise.resolve());
    assert.equal(decodes.count, EXPECTED_IMAGE_DECODE_COUNT);
    // Leaving the shared People layout (for example, for All) can still remount the card.
    await REMOUNT_ITERATION_INDICES.reduce(async (previous) => {
      const screen = await previous;
      screen.unmount();
      const next = render(banner);
      await act(async () => {});
      assert.equal(next.container.querySelector(".meeting-pro-flip-page"), null);
      assert.equal(
        next.container.querySelector(".meeting-pro-art-logo")?.getAttribute("src"),
        `/logos/days/${TEST_DAY_19}.svg`,
      );
      assert.equal(next.container.querySelector(".meeting-pro-logo-weekday")?.textContent, "Sat");
      assert.equal(
        decodes.count,
        EXPECTED_IMAGE_DECODE_COUNT,
        MEETING_PRO_UPGRADE_CARD_TEST_COPY.doNotDecodeOnNavigation,
      );

      return next;
    }, Promise.resolve(initialScreen));
  });
});
