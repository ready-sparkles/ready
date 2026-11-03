import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { billingCheckoutRequestSchema } from "@readymeet/shared";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SessionProvider } from "next-auth/react";
import assert from "node:assert/strict";
import test, { after, beforeEach, type TestContext } from "node:test";

import { AuthProvider } from "../../../presentation/components/auth-provider";

const INCLUDED_CREDITS_PER_SEAT = 200;
const TEST_MAXIMUM_TOPUP_CREDITS = 1_000;
const TEST_PRICE_PER_CREDIT_MICRO_USD = 100_000;
const THREE_SECONDS_MS = 3_000;
const FIFTEEN_SECONDS_MS = 15_000;
const THIRTY_SECONDS_MS = 30_000;
const ONE_MINUTE_MS = 60_000;
const INITIAL_POLL_ITERATIONS = 22;
const SINGLE_TICK_MS = 1;
const OFFLINE_ERROR_MESSAGE = "offline";
const PROCESSING_FIXTURE_TIMESTAMP = "2026-09-19T12:00:00Z";

GlobalRegistrator.register({ url: "http://localhost:3000" });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// Load Query after the DOM exists so its browser polling is enabled in this test.
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { BillingPanel } = await import("../../../presentation/components/billing-panel");
after(() => GlobalRegistrator.unregister());

// A real BroadcastChannel keeps the test process alive; this stub never delivers or holds handles.
class StubBroadcastChannel extends EventTarget implements BroadcastChannel {
  readonly name: string;
  onmessage: BroadcastChannel["onmessage"] = null;
  onmessageerror: BroadcastChannel["onmessageerror"] = null;

  constructor(name: string) {
    super();
    this.name = name;
  }

  postMessage(): void {}

  close(): void {}
}

function installMockBroadcastChannel(t: TestContext) {
  t.mock.method(globalThis, "BroadcastChannel", function (name: string) {
    return new StubBroadcastChannel(name);
  });
}

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

beforeEach((t) => {
  assert.ok("mock" in t);
  installMockBroadcastChannel(t);
});

const member = {
  plan: "free",
  /** @external billing fixture wire field */
  subscriptionActive: false,
  allowanceCredits: 0,
  allowanceUsed: 0,
  allowanceRemaining: 0,
  allowanceWindowEnd: null,
  poolBalance: 0,
  /** @external billing fixture wire field */
  trialEligible: false,
  trialCreditsUsed: 0,
  hasTrialCredits: false,
  trialMeetingsRemaining: 0,
  checkout: null,
};
const billing = {
  plan: "free",
  activeSeatCount: 1,
  /** @external existing wire contract */
  privateBetaPro: false,
  subscription: null,
  pool: { balance: 0, topupCredits: 0, promotionalCredits: 0, nextExpiry: null },
  freeTrial: { memberCount: 1, remainingCredits: 0 },
  topup: {
    minCredits: 1,
    maxCredits: TEST_MAXIMUM_TOPUP_CREDITS,
    pricePerCreditMicroUsd: TEST_PRICE_PER_CREDIT_MICRO_USD,
  },
  /** @external existing wire contract */
  checkoutAvailable: true,
  subscriptionCheckoutOptions: [
    { plan: "pro", interval: "month" },
    { plan: "pro", interval: "year" },
    { plan: "max", interval: "month" },
    { plan: "max", interval: "year" },
  ],
  paymentMethod: null,
  invoices: [],
};
const subscription = {
  status: "active",
  planInterval: "month",
  includedCreditsPerSeat: INCLUDED_CREDITS_PER_SEAT,
  seatQuantity: 1,
  currentPeriodEnd: null,
  /** @external existing wire contract */
  cancelAtPeriodEnd: false,
};
function enablePaymentTimers(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse(PROCESSING_FIXTURE_TIMESTAMP) });
}

async function advanceBillingTimers(input: { t: TestContext; ms: number }) {
  await act(async () => input.t.mock.timers.tick(input.ms));
  await act(async () => input.t.mock.timers.tick(SINGLE_TICK_MS));
}

const processing = { kind: "subscription", status: "processing", startedAt: PROCESSING_FIXTURE_TIMESTAMP };

[true, false].forEach((isReturning) => {
  void test(
    isReturning
      ? "confirmation continues beyond one minute and activates Max without refreshing"
      : "processing survives reopening billing without checkout return parameters",
    async (t) => {
      enablePaymentTimers(t);
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      window.history.replaceState(
        null,
        "",
        isReturning ? "/settings?billing=subscribed&session_id=cs_test_delayed" : "/settings",
      );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      t.after(() => {
        cleanup();
        client.clear();
      });
      const payment = { hasPaid: false, confirmations: 0 };
      t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
        const url = resolveFetchUrl(input);
        if (url.endsWith("/billing/checkout/confirm")) {
          payment.confirmations += 1;

          return Response.json({
            /** @external checkout confirm response wire field */
            confirmed: payment.hasPaid,
            status: payment.hasPaid ? undefined : "processing",
          });
        }
        if (url.endsWith("/billing/me")) {
          return Response.json({
            billing: {
              ...member,
              plan: payment.hasPaid ? (isReturning ? "max" : "business") : "free",
              /** @external billing fixture wire field */
              subscriptionActive: payment.hasPaid,
              checkout: payment.hasPaid ? null : processing,
            },
          });
        }
        if (url.endsWith("/billing")) {
          return Response.json({
            billing: {
              ...billing,
              plan: payment.hasPaid ? (isReturning ? "max" : "business") : "free",
              subscription: payment.hasPaid ? subscription : null,
            },
          });
        }

        return Response.json({});
      });
      const screen = render(
        <SessionProvider session={null}>
          <AuthProvider>
            <QueryClientProvider client={client}>
              <BillingPanel token="test-token" workspaceId="test-workspace" />
            </QueryClientProvider>
          </AuthProvider>
        </SessionProvider>,
      );
      const tick = (ms: number) => advanceBillingTimers({ t, ms });
      await tick(SINGLE_TICK_MS);
      await Array.from({ length: INITIAL_POLL_ITERATIONS }, () => undefined).reduce(async (previous) => {
        await previous;
        await tick(THREE_SECONDS_MS);
      }, Promise.resolve());
      assert.match(screen.getByRole("status").textContent, /processing/);
      assert.equal(screen.queryByRole("button", { name: "Upgrade now" }), null);
      const beforeSlowCheck = payment.confirmations;
      await tick(FIFTEEN_SECONDS_MS);
      if (isReturning) {
        assert.ok(payment.confirmations > beforeSlowCheck, "keeps confirming after the first minute");
      } else {
        assert.equal(payment.confirmations, 0, "persistent server state does not require the old checkout URL");
      }
      if (isReturning) {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        const beforeHidden = payment.confirmations;
        await tick(ONE_MINUTE_MS);
        assert.equal(payment.confirmations, beforeHidden, "does not call Stripe while hidden");
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
        await act(async () => {
          window.dispatchEvent(new window.Event("focus"));
        });
        assert.ok(payment.confirmations > beforeHidden, "resumes immediately on returning to the tab");
      }
      client.setQueryData(["meetingDetail", "existing"], { notesAccess: "upgrade_required" });
      payment.hasPaid = true;
      await tick(FIFTEEN_SECONDS_MS);
      assert.notEqual(screen.queryByRole("heading", { name: isReturning ? /Max plan/ : /Pro plan/ }), null);
      assert.equal(
        screen.queryByText(isReturning ? "Your Max plan is active." : /Your payment is processing/) !== null,
        isReturning,
      );
      assert.equal(client.getQueryState(["meetingDetail", "existing"])?.isInvalidated, true);
      assert.equal(new URL(window.location.href).searchParams.has("session_id"), false);
      const settledCount = payment.confirmations;
      await tick(THIRTY_SECONDS_MS);
      assert.equal(payment.confirmations, settledCount);
    },
  );
});

void test("network errors keep checking without offering another checkout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  window.history.replaceState(null, "", "/settings?billing=subscribed&session_id=cs_test_network");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => {
    cleanup();
    client.clear();
  });
  const payment = { confirmations: 0 };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/checkout/confirm")) {
      payment.confirmations += 1;
      throw new Error(OFFLINE_ERROR_MESSAGE);
    }

    return Response.json({ billing: url.endsWith("/billing/me") ? member : billing });
  });
  const screen = render(
    <SessionProvider session={null}>
      <AuthProvider>
        <QueryClientProvider client={client}>
          <BillingPanel token="test-token" workspaceId="test-workspace" />
        </QueryClientProvider>
      </AuthProvider>
    </SessionProvider>,
  );
  await act(async () => {});
  await Array.from({ length: INITIAL_POLL_ITERATIONS }, () => undefined).reduce(async (previous) => {
    await previous;
    await act(async () => t.mock.timers.tick(THREE_SECONDS_MS));
  }, Promise.resolve());
  assert.equal(screen.queryByRole("button", { name: "Upgrade now" }), null);
  const before = payment.confirmations;
  await act(async () => t.mock.timers.tick(FIFTEEN_SECONDS_MS));
  assert.ok(payment.confirmations > before);
});

void test("a failed payment detected in the background re-enables upgrade without a refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  window.history.replaceState(null, "", "/settings");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => {
    cleanup();
    client.clear();
  });
  const checkout = { isFailed: false, count: 0 };
  t.mock.method(window.location, "assign", () => {});
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = resolveFetchUrl(input);
    if (url.endsWith("/billing/checkout")) {
      checkout.count += 1;

      return Response.json({ url: "https://checkout.stripe.com/new" });
    }

    return Response.json({
      billing: url.endsWith("/billing/me")
        ? { ...member, checkout: { ...processing, status: checkout.isFailed ? "failed" : "processing" } }
        : billing,
    });
  });
  const screen = render(
    <SessionProvider session={null}>
      <AuthProvider>
        <QueryClientProvider client={client}>
          <BillingPanel token="test-token" workspaceId="test-workspace" />
        </QueryClientProvider>
      </AuthProvider>
    </SessionProvider>,
  );
  await act(async () => {});
  await act(async () => t.mock.timers.tick(SINGLE_TICK_MS));
  assert.equal(screen.queryByRole("button", { name: "Upgrade now" }), null);
  checkout.isFailed = true;
  await act(async () => t.mock.timers.tick(FIFTEEN_SECONDS_MS));
  await act(async () => t.mock.timers.tick(SINGLE_TICK_MS));
  assert.match(screen.getByRole("alert").textContent, /You can try again/);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upgrade now" })));
  assert.equal(checkout.count, 1);
});

(["month", "year"] as const).forEach((interval) => {
  void test(`billing chooser sends Max ${interval} to the workspace checkout API`, async (t) => {
    window.history.replaceState(null, "", "/settings");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    t.after(() => {
      cleanup();
      client.clear();
    });
    const redirect = t.mock.method(window.location, "assign", () => {});
    const requests = { values: [] as unknown[] };
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url.endsWith("/billing/checkout")) {
        const requestBody = options?.body;
        assert.ok(typeof requestBody === "string");
        const body = billingCheckoutRequestSchema.parse(JSON.parse(requestBody));
        requests.values = [...requests.values, body];

        return Response.json({ url: "https://checkout.stripe.com/max" });
      }

      return Response.json({ billing: url.endsWith("/billing/me") ? member : billing });
    });
    const screen = render(
      <SessionProvider session={null}>
        <AuthProvider>
          <QueryClientProvider client={client}>
            <BillingPanel token="test-token" workspaceId="test-workspace" />
          </QueryClientProvider>
        </AuthProvider>
      </SessionProvider>,
    );
    await waitFor(() => assert.notEqual(screen.queryByRole("button", { name: "Manage plan" }), null));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Manage plan" })));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: interval === "year" ? "Yearly" : "Monthly" })),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose Max" })));
    assert.deepEqual(requests.values, [{ interval, plan: "max" }]);
    assert.equal(redirect.mock.calls[0]?.arguments[0], "https://checkout.stripe.com/max");
  });
});

void test("billing chooser disables only the plan and interval whose checkout is not configured", async (t) => {
  window.history.replaceState(null, "", "/settings");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => {
    cleanup();
    client.clear();
  });
  const partialBilling = {
    ...billing,
    subscriptionCheckoutOptions: [
      { plan: "pro", interval: "month" },
      { plan: "pro", interval: "year" },
      { plan: "max", interval: "month" },
    ],
  };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    Response.json({ billing: resolveFetchUrl(input).endsWith("/billing/me") ? member : partialBilling }),
  );
  const screen = render(
    <SessionProvider session={null}>
      <AuthProvider>
        <QueryClientProvider client={client}>
          <BillingPanel token="test-token" workspaceId="test-workspace" />
        </QueryClientProvider>
      </AuthProvider>
    </SessionProvider>,
  );
  await waitFor(() => assert.notEqual(screen.queryByRole("button", { name: "Manage plan" }), null));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Manage plan" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Yearly" })));
  assert.equal(screen.getByRole("button", { name: "Choose Max" }).hasAttribute("disabled"), true);
  assert.equal(screen.getByRole("button", { name: "Get Pro plan" }).hasAttribute("disabled"), false);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Monthly" })));
  assert.equal(screen.getByRole("button", { name: "Choose Max" }).hasAttribute("disabled"), false);
});

void test("Upgrade now stays disabled when monthly Pro checkout is not configured", async (t) => {
  window.history.replaceState(null, "", "/settings");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => {
    cleanup();
    client.clear();
  });
  const yearlyOnlyBilling = { ...billing, subscriptionCheckoutOptions: [{ plan: "pro", interval: "year" }] };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) =>
    Response.json({ billing: resolveFetchUrl(input).endsWith("/billing/me") ? member : yearlyOnlyBilling }),
  );
  const screen = render(
    <SessionProvider session={null}>
      <AuthProvider>
        <QueryClientProvider client={client}>
          <BillingPanel token="test-token" workspaceId="test-workspace" />
        </QueryClientProvider>
      </AuthProvider>
    </SessionProvider>,
  );
  await waitFor(() => assert.notEqual(screen.queryByRole("button", { name: "Upgrade now" }), null));
  assert.equal(screen.getByRole("button", { name: "Upgrade now" }).hasAttribute("disabled"), true);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "View all plans" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Yearly" })));
  assert.equal(screen.getByRole("button", { name: "Get Pro plan" }).hasAttribute("disabled"), false);
});
