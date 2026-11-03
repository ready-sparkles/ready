"use client";

import type { WorkspaceBillingSummary } from "@readymeet/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import {
  confirmWorkspaceBillingCheckout,
  getApiErrorMessage,
  getWorkspaceBilling,
  openWorkspaceBillingPortal,
  startWorkspaceBillingCheckout,
  startWorkspaceCreditTopup,
} from "../../composition/api";
import { useTrialOffer } from "../lib/use-trial-offer";

import { WorkspaceCreditUsagePanel } from "./credit-usage-panel";
import {
  businessPlanFeatures,
  FREE_PLAN_FEATURES,
  MONTHLY_PRICE_USD,
  PlanCheckIcon,
  PricingPlanCards,
  PricingPlanNote,
} from "./pricing-plan-cards";

const TOPUP_CREDITS_SMALL = 100;
const TOPUP_CREDITS_MEDIUM = 500;
const TOPUP_CREDITS_LARGE = 1000;
const TOPUP_PRESETS = [TOPUP_CREDITS_SMALL, TOPUP_CREDITS_MEDIUM, TOPUP_CREDITS_LARGE];

const MICRO_USD_PER_DOLLAR = 1_000_000;
const USD_MAX_FRACTION_DIGITS = 2;
const BILLING_REFETCH_INTERVAL_MS = 15_000;
const CHECKOUT_CONFIRM_FAST_POLL_MS = 3_000;
const CHECKOUT_CONFIRM_SLOW_POLL_MS = 15_000;
const CHECKOUT_CONFIRM_FAST_WINDOW_MS = 60_000;
const INVOICES_PREVIEW_COUNT = 3;

const BILLING_PANEL_COPY = {
  billingSessionMissing: "Billing session is missing",
  confirmingPaymentWithStripe: "Confirming your payment with Stripe…",
  proPlanActive: "Your Pro plan is active.",
  maxPlanActive: "Your Max plan is active.",
  creditsAdded: "Your credits were added.",
  paymentFailedRetry: "Your payment failed. You can try again.",
  checkoutExpiredRetry: "This checkout expired. You can try again.",
  paymentConfirmationPending: "Payment confirmation is still pending",
  paymentConfirmationTakingLonger: "Payment confirmation is taking longer. We’ll keep checking automatically.",
  paymentProcessingAutoUpdate: "Your payment is processing. Your plan will update automatically.",
  stripeOpenError: "Could not open Stripe. Try again.",
  loadingBilling: "Loading billing…",
  fixPayment: "Fix payment",
  couldNotLoadBilling: "Could not load billing. ",
  tryAgain: "Try again",
  proPlan: "Pro plan",
  maxPlan: "Max plan",
  yearly: "yearly",
  monthly: "monthly",
  subscriptionEndsOn: "Your subscription ends on",
  subscriptionRenewsOn: "Your subscription will auto renew on",
  opening: "Opening…",
  managePlan: "Manage plan",
  subscriptionStatusPrefix: "Subscription status:",
  subscriptionStatusPaymentHint: "Check your payment method under Payment.",
  payment: "Payment",
  noPaymentMethod: "No payment method on file",
  update: "Update",
  creditsBalance: "Credits balance",
  creditsBalanceNote: "Buy usage credits to keep using Ready's AI features if you hit your plan limit.",
  currentBalance: "Current balance",
  buyCredits: "Buy credits",
  activeSeat: "seat",
  activeSeats: "seats",
  suspendedMembersNotBilled: "Suspended members are not billed.",
  creditsPerSeatSuffix: "credits per seat",
  invoices: "Invoices",
  invoiceDate: "Date",
  invoiceTotal: "Total",
  invoiceStatus: "Status",
  invoiceActions: "Actions",
  view: "View",
  loadMore: "Load more",
  noInvoicesYet: "No invoices yet.",
  cancellation: "Cancellation",
  planCancelledPrefix: "Your plan is cancelled",
  planCancelledEndsOn: "and ends on",
  renewPlan: "Renew plan",
  cancelPlan: "Cancel plan",
  cancel: "Cancel",
  privateBetaPro: "Private beta Pro",
  privateBetaProNote: "Unlimited AI credits are included while your private beta access is active.",
  privateBetaFeatureNotes: "Unlimited notes and tasks",
  privateBetaFeaturePrep: "Unlimited meeting prep",
  privateBetaFeatureVoice: "Unlimited voice AI",
  freePlan: "Free plan",
  freePlanUser: "user",
  freePlanUsers: "users",
  checkoutUnavailable: "Checkout is not available in this environment.",
  upgradeToPro: "Upgrade to Pro plan",
  perActiveUserMonthly: "per active user / month · billed monthly",
  viewAllPlans: "View all plans",
  upgradeNow: "Upgrade now",
  backToBilling: "Back to billing",
  upgradeYourPlan: "Upgrade your plan",
  billingInterval: "Billing interval",
  monthlyLabel: "Monthly",
  yearlyLabel: "Yearly",
  yourCurrentPlan: "Your current plan",
  getProPlan: "Get Pro plan",
  billableSeat: "seat",
  billableSeats: "seats",
  planSelectFooterPrefix: "Your workspace currently has",
  planSelectFooterMiddle: "billable",
  planSelectFooterSuffix: ". The Stripe total is quantity × the per-seat price shown above.",
  closeBuyCredits: "Close buy credits",
  modalCloseSymbol: "×",
  buyCreditsTitle: "Buy credits",
  topupDescription: "Purchased credits never expire and are used after your monthly included credits.",
  creditsLabel: "credits",
  linkByStripe: "Link by Stripe",
  card: "Card",
  paymentMethodOnFile: "Payment method on file",
  workspaceSeats: "Workspace seats",
  meetingSingular: "meeting",
  meetingsPlural: "meetings",
  freeMeetingsLeftPrefix: "free",
  freeMeetingsLeftSuffix: "left · AI limits apply",
  planAndBillingAriaLabel: "Plan and billing",
  choosePlanAriaLabel: "Choose a plan",
  upgradeToProAriaLabel: "Upgrade to Pro",
  activeLabel: "active",
  freePrefix: "Free ·",
  dollarPrefix: "$",
};

const PRIVATE_BETA_PRO_FEATURES = [
  BILLING_PANEL_COPY.privateBetaFeatureNotes,
  BILLING_PANEL_COPY.privateBetaFeaturePrep,
  BILLING_PANEL_COPY.privateBetaFeatureVoice,
];

function formatMicroUsd(microUsd: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: USD_MAX_FRACTION_DIGITS,
  }).format(microUsd / MICRO_USD_PER_DOLLAR);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatShortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function BackArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M15.75 19.5 8.25 12l7.5-7.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function paymentMethodLabel(method: NonNullable<WorkspaceBillingSummary["paymentMethod"]>) {
  if (method.type === "link") {
    return BILLING_PANEL_COPY.linkByStripe;
  }
  const name =
    method.type === "card"
      ? method.brand !== null && method.brand.length > 0
        ? capitalize(method.brand)
        : BILLING_PANEL_COPY.card
      : method.brand;
  const resolvedName = name ?? "";

  if (resolvedName.length === 0) {
    return BILLING_PANEL_COPY.paymentMethodOnFile;
  }

  const last4Digits = method.last4 ?? "";

  return last4Digits.length > 0 ? `${resolvedName} •••• ${last4Digits}` : resolvedName;
}

function formatSubscriptionStatusWarning(status: string) {
  return `${BILLING_PANEL_COPY.subscriptionStatusPrefix} ${status}. ${BILLING_PANEL_COPY.subscriptionStatusPaymentHint}`;
}

function formatActiveSeatsLine(seatQuantity: number) {
  const seatWord = seatQuantity === 1 ? BILLING_PANEL_COPY.activeSeat : BILLING_PANEL_COPY.activeSeats;

  return `${seatQuantity} ${BILLING_PANEL_COPY.activeLabel} ${seatWord}`;
}

function formatCancelledPlanLead(periodEnd: string | null) {
  if (periodEnd === null) {
    return `${BILLING_PANEL_COPY.planCancelledPrefix}.`;
  }

  return `${BILLING_PANEL_COPY.planCancelledPrefix} ${BILLING_PANEL_COPY.planCancelledEndsOn} ${formatDate(periodEnd)}.`;
}

function formatFreePlanSeatLine(activeSeatCount: number) {
  const users = activeSeatCount === 1 ? BILLING_PANEL_COPY.freePlanUser : BILLING_PANEL_COPY.freePlanUsers;

  return `${BILLING_PANEL_COPY.freePrefix} ${activeSeatCount} ${users}`;
}

function formatPlanSelectFooter(seatCount: number) {
  const seatLabel = seatCount === 1 ? BILLING_PANEL_COPY.billableSeat : BILLING_PANEL_COPY.billableSeats;

  return `${BILLING_PANEL_COPY.planSelectFooterPrefix} ${seatCount} ${BILLING_PANEL_COPY.planSelectFooterMiddle} ${seatLabel}${BILLING_PANEL_COPY.planSelectFooterSuffix}`;
}

function ignoreCaughtBillingPollFailure(error: unknown) {
  if (error instanceof Error || typeof error === "string" || (typeof error === "object" && error !== null)) {
    return;
  }
  throw error;
}

function clearBillingCheckoutReturnParams(sessionId: string) {
  const current = new URL(window.location.href);
  if (current.searchParams.get("session_id") !== sessionId) {
    return;
  }
  current.searchParams.delete("billing");
  current.searchParams.delete("session_id");
  window.history.replaceState(window.history.state, "", current.toString());
}

export function hasPrivateBetaWorkspaceAccess(
  billing: Pick<WorkspaceBillingSummary, "privateBetaPro" | "subscription">,
) {
  return billing.privateBetaPro && !billing.subscription;
}

export function isCheckoutOutcomeConfirmed(input: {
  outcome: "subscribed" | "topup-complete";
  /** @external isCheckoutOutcomeConfirmed input */
  checkoutConfirmed: boolean;
  billing: WorkspaceBillingSummary | null;
}) {
  return (
    input.checkoutConfirmed &&
    (input.outcome === "topup-complete" ||
      (input.billing?.subscription !== null && input.billing?.subscription !== undefined))
  );
}

type CheckoutConfirmationControls = {
  setIsConfirmingCheckout: (value: boolean) => void;
  setPendingAction: (value: string | null) => void;
  setBillingNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
};

async function applyConfirmedBillingCheckout(input: {
  checkoutOutcome: "subscribed" | "topup-complete";
  loadBilling: () => Promise<WorkspaceBillingSummary>;
  queryClient: ReturnType<typeof useQueryClient>;
  controls: CheckoutConfirmationControls;
  isPollCancelled: () => boolean;
  sessionId: string;
}): Promise<boolean> {
  const refreshedBilling = await input.loadBilling();
  if (input.isPollCancelled()) {
    return false;
  }
  if (
    !isCheckoutOutcomeConfirmed({
      outcome: input.checkoutOutcome,
      checkoutConfirmed: true,
      billing: refreshedBilling,
    })
  ) {
    return false;
  }
  input.controls.setIsConfirmingCheckout(false);
  input.controls.setError(null);
  input.controls.setBillingNotice(
    input.checkoutOutcome === "subscribed"
      ? refreshedBilling.plan === "max"
        ? BILLING_PANEL_COPY.maxPlanActive
        : BILLING_PANEL_COPY.proPlanActive
      : BILLING_PANEL_COPY.creditsAdded,
  );
  input.controls.setPendingAction(null);
  clearBillingCheckoutReturnParams(input.sessionId);
  await input.queryClient.invalidateQueries({ queryKey: ["meetingDetail"] });

  return true;
}

type BillingCheckoutPollState = {
  isCancelled: boolean;
  pollTimer: ReturnType<typeof setTimeout> | undefined;
};

function attachBillingCheckoutConfirmation({
  authToken,
  workspaceId,
  sessionId,
  checkoutOutcome,
  startedAt,
  loadBilling,
  queryClient,
  controls,
}: {
  authToken: string;
  workspaceId: string;
  sessionId: string;
  checkoutOutcome: "subscribed" | "topup-complete";
  startedAt: number;
  loadBilling: () => Promise<WorkspaceBillingSummary>;
  queryClient: ReturnType<typeof useQueryClient>;
  controls: CheckoutConfirmationControls;
}) {
  const pollState: BillingCheckoutPollState = { isCancelled: false, pollTimer: undefined };
  const stopState = { hasStopped: false };
  const activePoll = { generation: 0 };
  const isPollCancelled = () => pollState.isCancelled;
  const shouldPollContinue = () => !stopState.hasStopped && !isPollCancelled();
  const isPollStale = (generation: number) => generation !== activePoll.generation;

  const scheduleNextPoll = () => {
    if (!shouldPollContinue()) {
      return;
    }
    const delay =
      Date.now() - startedAt < CHECKOUT_CONFIRM_FAST_WINDOW_MS
        ? CHECKOUT_CONFIRM_FAST_POLL_MS
        : CHECKOUT_CONFIRM_SLOW_POLL_MS;
    if (delay === CHECKOUT_CONFIRM_SLOW_POLL_MS) {
      controls.setPendingAction(null);
      controls.setBillingNotice(BILLING_PANEL_COPY.paymentProcessingAutoUpdate);
    }
    pollState.pollTimer = setTimeout(() => void runCheckoutPoll(), delay);
  };

  async function runCheckoutPoll() {
    if (!shouldPollContinue() || document.visibilityState === "hidden") {
      return;
    }
    const pollGeneration = activePoll.generation;
    clearTimeout(pollState.pollTimer);
    try {
      const result = await confirmWorkspaceBillingCheckout({ token: authToken, workspaceId, sessionId });
      if (!shouldPollContinue() || isPollStale(pollGeneration)) {
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["workspace-trial-offer", workspaceId] });
      if (!shouldPollContinue() || isPollStale(pollGeneration)) {
        return;
      }
      if (result.confirmed) {
        const hasConfirmedCheckout = await applyConfirmedBillingCheckout({
          checkoutOutcome,
          loadBilling,
          queryClient,
          controls,
          isPollCancelled,
          sessionId,
        });
        if (hasConfirmedCheckout) {
          stopState.hasStopped = true;
        }
      } else if (result.status === "expired" || result.status === "failed") {
        stopState.hasStopped = true;
        controls.setIsConfirmingCheckout(false);
        controls.setBillingNotice(
          result.status === "failed" ? BILLING_PANEL_COPY.paymentFailedRetry : BILLING_PANEL_COPY.checkoutExpiredRetry,
        );
        controls.setPendingAction(null);
        clearBillingCheckoutReturnParams(sessionId);
      }
    } catch (caughtError) {
      ignoreCaughtBillingPollFailure(caughtError);
      controls.setBillingNotice(BILLING_PANEL_COPY.paymentConfirmationTakingLonger);
    } finally {
      if (!isPollStale(pollGeneration)) {
        scheduleNextPoll();
      }
    }
  }

  const resume = () => {
    if (document.visibilityState !== "hidden") {
      void runCheckoutPoll();
    }
  };

  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  void runCheckoutPoll();

  return () => {
    pollState.isCancelled = true;
    activePoll.generation += 1;
    clearTimeout(pollState.pollTimer);
    window.removeEventListener("focus", resume);
    document.removeEventListener("visibilitychange", resume);
  };
}

function useBillingPanelEffects(input: {
  token: string | null | undefined;
  workspaceId: string;
  queryClient: ReturnType<typeof useQueryClient>;
  loadBilling: () => Promise<WorkspaceBillingSummary>;
  /** @external trial offer wire */
  hasSubscriptionActive: boolean | undefined;
  /** @external checkout wire */
  checkoutStatus: string | undefined;
  isPlanSelectionOpen: boolean;
  isTopupModalOpen: boolean;
  setPlanInterval: (value: "month" | "year") => void;
  setIsPlanSelectionOpen: (value: boolean) => void;
  setIsTopupModalOpen: (value: boolean) => void;
  setIsConfirmingCheckout: (value: boolean) => void;
  setPendingAction: (value: string | null) => void;
  setBillingNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
}) {
  useEffect(() => {
    void input.queryClient.invalidateQueries({ queryKey: ["workspace-billing", input.workspaceId] });
  }, [input.queryClient, input.workspaceId, input.hasSubscriptionActive, input.checkoutStatus]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const upgrade = url.searchParams.get("upgrade");
    if (upgrade === "month" || upgrade === "year") {
      input.setPlanInterval(upgrade);
      input.setIsPlanSelectionOpen(true);
      url.searchParams.delete("upgrade");
      url.searchParams.delete("billing");
      window.history.replaceState(null, "", url.toString());
    }
  }, [input.setIsPlanSelectionOpen, input.setPlanInterval]);

  useEffect(() => {
    if (input.token === null || input.token === undefined) {
      return;
    }
    const authToken = input.token;
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("billing");
    const sessionId = url.searchParams.get("session_id");
    if (sessionId === null || (outcome !== "subscribed" && outcome !== "topup-complete")) {
      return;
    }

    const startedAt = Date.now();
    input.setIsConfirmingCheckout(true);
    input.setPendingAction("confirming");
    input.setBillingNotice(BILLING_PANEL_COPY.confirmingPaymentWithStripe);

    return attachBillingCheckoutConfirmation({
      authToken,
      workspaceId: input.workspaceId,
      sessionId,
      checkoutOutcome: outcome,
      startedAt,
      loadBilling: input.loadBilling,
      queryClient: input.queryClient,
      controls: {
        setIsConfirmingCheckout: input.setIsConfirmingCheckout,
        setPendingAction: input.setPendingAction,
        setBillingNotice: input.setBillingNotice,
        setError: input.setError,
      },
    });
  }, [
    input.loadBilling,
    input.queryClient,
    input.token,
    input.workspaceId,
    input.setBillingNotice,
    input.setError,
    input.setIsConfirmingCheckout,
    input.setPendingAction,
  ]);

  useEffect(() => {
    if (!input.isPlanSelectionOpen && !input.isTopupModalOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        input.setIsPlanSelectionOpen(false);
        input.setIsTopupModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [input.isPlanSelectionOpen, input.isTopupModalOpen, input.setIsPlanSelectionOpen, input.setIsTopupModalOpen]);
}

type BillingPanelRedirect = (input: { action: string; getUrl: () => Promise<string> }) => void;

type BillingPanelActiveSubscriptionProps = {
  token: string;
  workspaceId: string;
  subscription: NonNullable<WorkspaceBillingSummary["subscription"]>;
  billing: WorkspaceBillingSummary;
  pendingAction: string | null;
  redirectTo: BillingPanelRedirect;
  isCheckoutAvailable: boolean;
  extraBalanceMicroUsd: number;
  isShowingAllInvoices: boolean;
  setIsShowingAllInvoices: (value: boolean) => void;
  onOpenTopupModal: () => void;
};

function BillingPanelSubscriptionSeats({
  subscription,
}: {
  subscription: NonNullable<WorkspaceBillingSummary["subscription"]>;
}) {
  return (
    <section
      className="settings-billing-section settings-billing-section-flush"
      aria-label={BILLING_PANEL_COPY.workspaceSeats}
    >
      <div className="settings-billing-inner-card">
        <div className="settings-billing-row">
          <div className="settings-billing-limit-title">
            <strong>{formatActiveSeatsLine(subscription.seatQuantity)}</strong>
            <span>{BILLING_PANEL_COPY.suspendedMembersNotBilled}</span>
          </div>
          <span className="settings-billing-limit-label">
            {subscription.includedCreditsPerSeat.toLocaleString()} {BILLING_PANEL_COPY.creditsPerSeatSuffix}
          </span>
        </div>
      </div>
    </section>
  );
}

function BillingPanelSubscriptionInvoices({
  billing,
  isShowingAllInvoices,
  setIsShowingAllInvoices,
}: {
  billing: WorkspaceBillingSummary;
  isShowingAllInvoices: boolean;
  setIsShowingAllInvoices: (value: boolean) => void;
}) {
  return (
    <section className="settings-billing-section" aria-label={BILLING_PANEL_COPY.invoices}>
      <h3>{BILLING_PANEL_COPY.invoices}</h3>
      {billing.invoices.length !== 0 ? (
        <>
          <table className="settings-billing-invoices">
            <thead>
              <tr>
                <th scope="col">{BILLING_PANEL_COPY.invoiceDate}</th>
                <th scope="col">{BILLING_PANEL_COPY.invoiceTotal}</th>
                <th scope="col">{BILLING_PANEL_COPY.invoiceStatus}</th>
                <th scope="col">{BILLING_PANEL_COPY.invoiceActions}</th>
              </tr>
            </thead>
            <tbody>
              {(isShowingAllInvoices ? billing.invoices : billing.invoices.slice(0, INVOICES_PREVIEW_COUNT)).map(
                (invoice) => (
                  <tr key={invoice.id}>
                    <td>{formatShortDate(invoice.createdAt)}</td>
                    <td>{formatMicroUsd(invoice.totalMicroUsd)}</td>
                    <td>{capitalize(invoice.status)}</td>
                    <td>
                      {invoice.hostedInvoiceUrl !== null ? (
                        <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                          {BILLING_PANEL_COPY.view}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {!isShowingAllInvoices && billing.invoices.length > INVOICES_PREVIEW_COUNT ? (
            <div className="settings-billing-load-more">
              <button type="button" className="settings-secondary-button" onClick={() => setIsShowingAllInvoices(true)}>
                {BILLING_PANEL_COPY.loadMore}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="settings-billing-note">{BILLING_PANEL_COPY.noInvoicesYet}</p>
      )}
    </section>
  );
}

function BillingPanelSubscriptionCancellation({
  token,
  workspaceId,
  subscription,
  pendingAction,
  redirectTo,
}: {
  token: string;
  workspaceId: string;
  subscription: NonNullable<WorkspaceBillingSummary["subscription"]>;
  pendingAction: string | null;
  redirectTo: BillingPanelRedirect;
}) {
  return (
    <section className="settings-billing-section" aria-label={BILLING_PANEL_COPY.cancellation}>
      <h3>{BILLING_PANEL_COPY.cancellation}</h3>
      {subscription.cancelAtPeriodEnd ? (
        <p className="settings-billing-section-note">
          {formatCancelledPlanLead(subscription.currentPeriodEnd)}
          <button
            type="button"
            className="settings-billing-inline-link"
            disabled={pendingAction !== null}
            onClick={() =>
              redirectTo({ action: "renew", getUrl: () => openWorkspaceBillingPortal({ token, workspaceId }) })
            }
          >
            {pendingAction === "renew" ? BILLING_PANEL_COPY.opening : BILLING_PANEL_COPY.renewPlan}
          </button>
        </p>
      ) : (
        <div className="settings-billing-row">
          <span className="settings-billing-cancel-label">{BILLING_PANEL_COPY.cancelPlan}</span>
          <button
            type="button"
            className="settings-billing-cancel-button"
            disabled={pendingAction !== null}
            onClick={() =>
              redirectTo({ action: "cancel", getUrl: () => openWorkspaceBillingPortal({ token, workspaceId }) })
            }
          >
            {pendingAction === "cancel" ? BILLING_PANEL_COPY.opening : BILLING_PANEL_COPY.cancel}
          </button>
        </div>
      )}
    </section>
  );
}

function BillingPanelSubscriptionPaymentAndCredits({
  token,
  workspaceId,
  billing,
  pendingAction,
  redirectTo,
  isCheckoutAvailable,
  extraBalanceMicroUsd,
  onOpenTopupModal,
}: {
  token: string;
  workspaceId: string;
  billing: WorkspaceBillingSummary;
  pendingAction: string | null;
  redirectTo: BillingPanelRedirect;
  isCheckoutAvailable: boolean;
  extraBalanceMicroUsd: number;
  onOpenTopupModal: () => void;
}) {
  return (
    <>
      <section className="settings-billing-section" aria-label={BILLING_PANEL_COPY.payment}>
        <h3>{BILLING_PANEL_COPY.payment}</h3>
        <div className="settings-billing-row">
          <span className="settings-billing-payment-method">
            {billing.paymentMethod !== null
              ? paymentMethodLabel(billing.paymentMethod)
              : BILLING_PANEL_COPY.noPaymentMethod}
          </span>
          <button
            type="button"
            className="settings-secondary-button"
            disabled={pendingAction !== null}
            onClick={() =>
              redirectTo({ action: "payment", getUrl: () => openWorkspaceBillingPortal({ token, workspaceId }) })
            }
          >
            {pendingAction === "payment" ? BILLING_PANEL_COPY.opening : BILLING_PANEL_COPY.update}
          </button>
        </div>
      </section>

      <section className="settings-billing-section" aria-label={BILLING_PANEL_COPY.creditsBalance}>
        <h3>{BILLING_PANEL_COPY.creditsBalance}</h3>
        <p className="settings-billing-section-note">{BILLING_PANEL_COPY.creditsBalanceNote}</p>
        <div className="settings-billing-inner-card">
          <div className="settings-billing-row">
            <div className="settings-billing-balance">
              <strong>{formatMicroUsd(extraBalanceMicroUsd)}</strong>
              <span>{BILLING_PANEL_COPY.currentBalance}</span>
            </div>
            <button
              type="button"
              className="settings-secondary-button"
              disabled={!isCheckoutAvailable || pendingAction !== null}
              onClick={onOpenTopupModal}
            >
              {BILLING_PANEL_COPY.buyCredits}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

function BillingPanelActiveSubscription({
  token,
  workspaceId,
  subscription,
  billing,
  pendingAction,
  redirectTo,
  isCheckoutAvailable,
  extraBalanceMicroUsd,
  isShowingAllInvoices,
  setIsShowingAllInvoices,
  onOpenTopupModal,
}: BillingPanelActiveSubscriptionProps) {
  return (
    <>
      <header className="settings-billing-plan-header">
        <div className="settings-billing-plan-title">
          <h2>
            {billing.plan === "max" ? BILLING_PANEL_COPY.maxPlan : BILLING_PANEL_COPY.proPlan}
            <span className="settings-billing-interval">
              {subscription.planInterval === "year" ? BILLING_PANEL_COPY.yearly : BILLING_PANEL_COPY.monthly}
            </span>
          </h2>
          {subscription.currentPeriodEnd !== null ? (
            <p>
              {subscription.cancelAtPeriodEnd
                ? `${BILLING_PANEL_COPY.subscriptionEndsOn} ${formatDate(subscription.currentPeriodEnd)}.`
                : `${BILLING_PANEL_COPY.subscriptionRenewsOn} ${formatDate(subscription.currentPeriodEnd)}.`}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="settings-secondary-button"
          disabled={pendingAction !== null}
          onClick={() =>
            redirectTo({ action: "portal", getUrl: () => openWorkspaceBillingPortal({ token, workspaceId }) })
          }
        >
          {pendingAction === "portal" ? BILLING_PANEL_COPY.opening : BILLING_PANEL_COPY.managePlan}
        </button>
      </header>

      {subscription.status !== "active" ? (
        <p className="settings-billing-status-warning">{formatSubscriptionStatusWarning(subscription.status)}</p>
      ) : null}

      <BillingPanelSubscriptionPaymentAndCredits
        token={token}
        workspaceId={workspaceId}
        billing={billing}
        pendingAction={pendingAction}
        redirectTo={redirectTo}
        isCheckoutAvailable={isCheckoutAvailable}
        extraBalanceMicroUsd={extraBalanceMicroUsd}
        onOpenTopupModal={onOpenTopupModal}
      />

      <BillingPanelSubscriptionSeats subscription={subscription} />

      <BillingPanelSubscriptionInvoices
        billing={billing}
        isShowingAllInvoices={isShowingAllInvoices}
        setIsShowingAllInvoices={setIsShowingAllInvoices}
      />

      <BillingPanelSubscriptionCancellation
        token={token}
        workspaceId={workspaceId}
        subscription={subscription}
        pendingAction={pendingAction}
        redirectTo={redirectTo}
      />
    </>
  );
}

function BillingPanelPlanPickerOverlay({
  token,
  workspaceId,
  billing,
  freePlanFeatures,
  planInterval,
  setPlanInterval,
  pendingAction,
  redirectTo,
  error,
  setIsPlanSelectionOpen,
}: {
  token: string;
  workspaceId: string;
  billing: WorkspaceBillingSummary | null;
  freePlanFeatures: string[];
  planInterval: "month" | "year";
  setPlanInterval: (value: "month" | "year") => void;
  pendingAction: string | null;
  redirectTo: BillingPanelRedirect;
  error: string | null;
  setIsPlanSelectionOpen: (value: boolean) => void;
}) {
  return (
    <div
      className="plan-select-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={BILLING_PANEL_COPY.choosePlanAriaLabel}
    >
      <button
        type="button"
        className="plan-select-back"
        aria-label={BILLING_PANEL_COPY.backToBilling}
        onClick={() => setIsPlanSelectionOpen(false)}
      >
        <BackArrowIcon />
      </button>

      <div className="plan-select-content">
        <h1 className="plan-select-title">{BILLING_PANEL_COPY.upgradeYourPlan}</h1>

        <div className="plan-select-toggle-row">
          <div className="plan-select-toggle" role="group" aria-label={BILLING_PANEL_COPY.billingInterval}>
            <button
              type="button"
              className={planInterval === "month" ? "plan-select-toggle-active" : ""}
              onClick={() => setPlanInterval("month")}
            >
              {BILLING_PANEL_COPY.monthlyLabel}
            </button>
            <button
              type="button"
              className={planInterval === "year" ? "plan-select-toggle-active" : ""}
              onClick={() => setPlanInterval("year")}
            >
              {BILLING_PANEL_COPY.yearlyLabel}
            </button>
          </div>
        </div>

        <PricingPlanCards
          freePlanFeatures={freePlanFeatures}
          planInterval={planInterval}
          freeCtaLabel={BILLING_PANEL_COPY.yourCurrentPlan}
          freeCtaDisabled
          proCtaLabel={pendingAction === planInterval ? BILLING_PANEL_COPY.opening : BILLING_PANEL_COPY.getProPlan}
          proCtaDisabled={
            pendingAction !== null || !canStartSubscriptionCheckout({ billing, plan: "pro", interval: planInterval })
          }
          maxCtaDisabled={
            pendingAction !== null || !canStartSubscriptionCheckout({ billing, plan: "max", interval: planInterval })
          }
          maxCtaLabel={pendingAction === `max-${planInterval}` ? BILLING_PANEL_COPY.opening : "Choose Max"}
          onMaxCta={() =>
            redirectTo({
              action: `max-${planInterval}`,
              getUrl: () => startWorkspaceBillingCheckout({ token, workspaceId, interval: planInterval, plan: "max" }),
            })
          }
          onProCta={() =>
            redirectTo({
              action: planInterval,
              getUrl: () =>
                startWorkspaceBillingCheckout({
                  token,
                  workspaceId,
                  interval: planInterval,
                }),
            })
          }
        />
      </div>

      {error !== null ? <p className="settings-error plan-select-error">{error}</p> : null}

      {billing !== null ? (
        <footer className="plan-select-footer">
          <p className="settings-billing-note">{formatPlanSelectFooter(billing.activeSeatCount)}</p>
        </footer>
      ) : null}
    </div>
  );
}

type BillingPanelTopupModalProps = {
  token: string;
  workspaceId: string;
  billing: WorkspaceBillingSummary | null;
  isCheckoutAvailable: boolean;
  pendingAction: string | null;
  redirectTo: BillingPanelRedirect;
  error: string | null;
  setIsTopupModalOpen: (value: boolean) => void;
};

function BillingPanelTopupModal({
  token,
  workspaceId,
  billing,
  isCheckoutAvailable,
  pendingAction,
  redirectTo,
  error,
  setIsTopupModalOpen,
}: BillingPanelTopupModalProps) {
  if (billing === null) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="private-beta-application-backdrop credit-topup-backdrop settings-modal-backdrop"
        aria-label={BILLING_PANEL_COPY.closeBuyCredits}
        onClick={() => setIsTopupModalOpen(false)}
      />
      <section className="credit-topup-modal" role="dialog" aria-modal="true" aria-labelledby="credit-topup-title">
        <button
          type="button"
          className="workspace-settings-modal-close credit-topup-close"
          aria-label={BILLING_PANEL_COPY.closeBuyCredits}
          onClick={() => setIsTopupModalOpen(false)}
        >
          <span>{BILLING_PANEL_COPY.modalCloseSymbol}</span>
        </button>
        <h2 id="credit-topup-title">{BILLING_PANEL_COPY.buyCreditsTitle}</h2>
        <p>{BILLING_PANEL_COPY.topupDescription}</p>
        <div className="credit-topup-options">
          {TOPUP_PRESETS.map((credits) => {
            const isOpening = pendingAction === `topup-${credits}`;

            return (
              <button
                key={credits}
                type="button"
                className={`credit-topup-option${isOpening ? " is-opening" : ""}`}
                disabled={!isCheckoutAvailable || pendingAction !== null}
                onClick={() =>
                  redirectTo({
                    action: `topup-${credits}`,
                    getUrl: () => startWorkspaceCreditTopup({ token, workspaceId, credits }),
                  })
                }
              >
                {isOpening ? (
                  BILLING_PANEL_COPY.opening
                ) : (
                  <>
                    <strong>
                      {credits.toLocaleString()} {BILLING_PANEL_COPY.creditsLabel}
                    </strong>
                    <span>{formatMicroUsd(credits * billing.topup.pricePerCreditMicroUsd)}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
        {error !== null ? <p className="settings-error">{error}</p> : null}
      </section>
    </>
  );
}

function BillingPanelUpgradePrompt({
  token,
  workspaceId,
  isCheckoutAvailable,
  pendingAction,
  redirectTo,
  setIsPlanSelectionOpen,
}: {
  token: string;
  workspaceId: string;
  isCheckoutAvailable: boolean;
  pendingAction: string | null;
  redirectTo: BillingPanelRedirect;
  setIsPlanSelectionOpen: (value: boolean) => void;
}) {
  return (
    <div
      className="settings-billing-plan-card settings-billing-upgrade-card"
      aria-label={BILLING_PANEL_COPY.upgradeToProAriaLabel}
    >
      <header className="settings-billing-plan-header">
        <div className="settings-billing-plan-title">
          <h2>{BILLING_PANEL_COPY.upgradeToPro}</h2>
          <p>
            {BILLING_PANEL_COPY.dollarPrefix}
            {MONTHLY_PRICE_USD} {BILLING_PANEL_COPY.perActiveUserMonthly}
          </p>
        </div>
        <div className="settings-billing-upgrade-actions">
          <button type="button" className="settings-billing-manage-button" onClick={() => setIsPlanSelectionOpen(true)}>
            {BILLING_PANEL_COPY.viewAllPlans}
          </button>
          <button
            type="button"
            className="settings-accent-button settings-billing-upgrade-button"
            disabled={!isCheckoutAvailable || pendingAction !== null}
            onClick={() =>
              redirectTo({
                action: "month",
                getUrl: () => startWorkspaceBillingCheckout({ token, workspaceId, interval: "month" }),
              })
            }
          >
            {pendingAction === "month" ? BILLING_PANEL_COPY.opening : BILLING_PANEL_COPY.upgradeNow}
          </button>
        </div>
      </header>
      <ul className="settings-billing-feature-list">
        {businessPlanFeatures().map((feature) => (
          <li key={feature}>
            <PlanCheckIcon className="settings-billing-check-icon" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <PricingPlanNote />
    </div>
  );
}

function BillingPanelStatusMessages({
  isLoading,
  billing,
  checkout,
  subscription,
  isPaymentProcessing,
  billingNotice,
  isBillingQueryError,
  onBillingRetry,
  token,
  workspaceId,
  redirectTo,
}: {
  isLoading: boolean;
  billing: WorkspaceBillingSummary | null;
  checkout: { status?: string; kind?: string } | null | undefined;
  subscription: WorkspaceBillingSummary["subscription"] | null;
  isPaymentProcessing: boolean;
  billingNotice: string | null;
  isBillingQueryError: boolean;
  onBillingRetry: () => void;
  token: string;
  workspaceId: string;
  redirectTo: BillingPanelRedirect;
}) {
  return (
    <>
      {isLoading && billing === null ? (
        <p className="workspace-loading-status" role="status">
          {BILLING_PANEL_COPY.loadingBilling}
        </p>
      ) : null}
      {checkout?.status === "failed" ? (
        <p className="settings-billing-note" role="alert">
          {BILLING_PANEL_COPY.paymentFailedRetry}
          {subscription !== null && checkout.kind === "subscription" ? (
            <button
              onClick={() =>
                redirectTo({ action: "payment", getUrl: () => openWorkspaceBillingPortal({ token, workspaceId }) })
              }
            >
              {BILLING_PANEL_COPY.fixPayment}
            </button>
          ) : null}
        </p>
      ) : isPaymentProcessing ? (
        <p className="settings-billing-note" role="status">
          {BILLING_PANEL_COPY.paymentProcessingAutoUpdate}
        </p>
      ) : billingNotice !== null ? (
        <p className="settings-billing-note" role="status">
          {billingNotice}
        </p>
      ) : null}
      {isBillingQueryError ? (
        <p role="alert">
          {BILLING_PANEL_COPY.couldNotLoadBilling}
          <button onClick={onBillingRetry}>{BILLING_PANEL_COPY.tryAgain}</button>
        </p>
      ) : null}
    </>
  );
}

function BillingPanelNonSubscriptionPlanCard({
  billing,
  isPrivateBetaPro,
  isPaymentProcessing,
  isCheckoutAvailable,
  freePlanFeatures,
  pendingAction,
  setIsPlanSelectionOpen,
}: {
  billing: WorkspaceBillingSummary;
  isPrivateBetaPro: boolean;
  isPaymentProcessing: boolean;
  isCheckoutAvailable: boolean;
  freePlanFeatures: string[];
  pendingAction: string | null;
  setIsPlanSelectionOpen: (value: boolean) => void;
}) {
  if (isPrivateBetaPro) {
    return (
      <>
        <header className="settings-billing-plan-header">
          <div className="settings-billing-plan-title">
            <h2>{BILLING_PANEL_COPY.privateBetaPro}</h2>
            <p>{BILLING_PANEL_COPY.privateBetaProNote}</p>
          </div>
        </header>

        <ul className="settings-billing-feature-list">
          {PRIVATE_BETA_PRO_FEATURES.map((feature) => (
            <li key={feature}>
              <PlanCheckIcon className="settings-billing-check-icon" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      <header className="settings-billing-plan-header">
        <div className="settings-billing-plan-title">
          <h2>{BILLING_PANEL_COPY.freePlan}</h2>
          <p>{formatFreePlanSeatLine(billing.activeSeatCount)}</p>
        </div>
        <button
          type="button"
          className="settings-billing-manage-button"
          disabled={pendingAction !== null || isPaymentProcessing}
          onClick={() => setIsPlanSelectionOpen(true)}
        >
          {BILLING_PANEL_COPY.managePlan}
        </button>
      </header>

      <ul className="settings-billing-feature-list">
        {freePlanFeatures.map((feature) => (
          <li key={feature}>
            <PlanCheckIcon className="settings-billing-check-icon" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      {!isCheckoutAvailable ? <p className="settings-billing-note">{BILLING_PANEL_COPY.checkoutUnavailable}</p> : null}
    </>
  );
}

function BillingPanelLoadedBillingContent({
  token,
  workspaceId,
  billing,
  subscription,
  isPrivateBetaPro,
  isPaymentProcessing,
  isCheckoutAvailable,
  extraBalanceMicroUsd,
  freePlanFeatures,
  pendingAction,
  redirectTo,
  isShowingAllInvoices,
  setIsShowingAllInvoices,
  setIsPlanSelectionOpen,
  setIsTopupModalOpen,
}: {
  token: string;
  workspaceId: string;
  billing: WorkspaceBillingSummary;
  subscription: WorkspaceBillingSummary["subscription"] | null;
  isPrivateBetaPro: boolean;
  isPaymentProcessing: boolean;
  isCheckoutAvailable: boolean;
  extraBalanceMicroUsd: number;
  freePlanFeatures: string[];
  pendingAction: string | null;
  redirectTo: BillingPanelRedirect;
  isShowingAllInvoices: boolean;
  setIsShowingAllInvoices: (value: boolean) => void;
  setIsPlanSelectionOpen: (value: boolean) => void;
  setIsTopupModalOpen: (value: boolean) => void;
}) {
  return (
    <>
      <section className="settings-billing-plan-card">
        {subscription !== null ? (
          <BillingPanelActiveSubscription
            token={token}
            workspaceId={workspaceId}
            subscription={subscription}
            billing={billing}
            pendingAction={pendingAction}
            redirectTo={redirectTo}
            isCheckoutAvailable={isCheckoutAvailable}
            extraBalanceMicroUsd={extraBalanceMicroUsd}
            isShowingAllInvoices={isShowingAllInvoices}
            setIsShowingAllInvoices={setIsShowingAllInvoices}
            onOpenTopupModal={() => setIsTopupModalOpen(true)}
          />
        ) : (
          <BillingPanelNonSubscriptionPlanCard
            billing={billing}
            isPrivateBetaPro={isPrivateBetaPro}
            isPaymentProcessing={isPaymentProcessing}
            isCheckoutAvailable={isCheckoutAvailable}
            freePlanFeatures={freePlanFeatures}
            pendingAction={pendingAction}
            setIsPlanSelectionOpen={setIsPlanSelectionOpen}
          />
        )}
      </section>

      {subscription === null && !isPrivateBetaPro && !isPaymentProcessing ? (
        <BillingPanelUpgradePrompt
          token={token}
          workspaceId={workspaceId}
          isCheckoutAvailable={canStartSubscriptionCheckout({ billing, plan: "pro", interval: "month" })}
          pendingAction={pendingAction}
          redirectTo={redirectTo}
          setIsPlanSelectionOpen={setIsPlanSelectionOpen}
        />
      ) : null}

      {subscription === null && !isPrivateBetaPro && billing.pool.balance > 0 ? (
        <WorkspaceCreditUsagePanel billing={billing} />
      ) : null}
    </>
  );
}

type BillingPanelViewProps = {
  token: string;
  workspaceId: string;
  isLoading: boolean;
  billing: WorkspaceBillingSummary | null;
  checkout: { status?: string; kind?: string } | null | undefined;
  subscription: WorkspaceBillingSummary["subscription"] | null;
  billingNotice: string | null;
  isBillingQueryError: boolean;
  onBillingRetry: () => void;
  isPaymentProcessing: boolean;
  isCheckoutAvailable: boolean;
  isPrivateBetaPro: boolean;
  extraBalanceMicroUsd: number;
  freePlanFeatures: string[];
  pendingAction: string | null;
  redirectTo: BillingPanelRedirect;
  isShowingAllInvoices: boolean;
  setIsShowingAllInvoices: (value: boolean) => void;
  isPlanSelectionOpen: boolean;
  setIsPlanSelectionOpen: (value: boolean) => void;
  planInterval: "month" | "year";
  setPlanInterval: (value: "month" | "year") => void;
  isTopupModalOpen: boolean;
  setIsTopupModalOpen: (value: boolean) => void;
  error: string | null;
};

function BillingPanelView({
  token,
  workspaceId,
  isLoading,
  billing,
  checkout,
  subscription,
  billingNotice,
  isBillingQueryError,
  onBillingRetry,
  isPaymentProcessing,
  isCheckoutAvailable,
  isPrivateBetaPro,
  extraBalanceMicroUsd,
  freePlanFeatures,
  pendingAction,
  redirectTo,
  isShowingAllInvoices,
  setIsShowingAllInvoices,
  isPlanSelectionOpen,
  setIsPlanSelectionOpen,
  planInterval,
  setPlanInterval,
  isTopupModalOpen,
  setIsTopupModalOpen,
  error,
}: BillingPanelViewProps) {
  return (
    <section className="settings-billing-panel" aria-label={BILLING_PANEL_COPY.planAndBillingAriaLabel}>
      <BillingPanelStatusMessages
        isLoading={isLoading}
        billing={billing}
        checkout={checkout}
        subscription={subscription}
        isPaymentProcessing={isPaymentProcessing}
        billingNotice={billingNotice}
        isBillingQueryError={isBillingQueryError}
        onBillingRetry={onBillingRetry}
        token={token}
        workspaceId={workspaceId}
        redirectTo={redirectTo}
      />

      {billing !== null ? (
        <BillingPanelLoadedBillingContent
          token={token}
          workspaceId={workspaceId}
          billing={billing}
          subscription={subscription}
          isPrivateBetaPro={isPrivateBetaPro}
          isPaymentProcessing={isPaymentProcessing}
          isCheckoutAvailable={isCheckoutAvailable}
          extraBalanceMicroUsd={extraBalanceMicroUsd}
          freePlanFeatures={freePlanFeatures}
          pendingAction={pendingAction}
          redirectTo={redirectTo}
          isShowingAllInvoices={isShowingAllInvoices}
          setIsShowingAllInvoices={setIsShowingAllInvoices}
          setIsPlanSelectionOpen={setIsPlanSelectionOpen}
          setIsTopupModalOpen={setIsTopupModalOpen}
        />
      ) : null}

      {error !== null ? <p className="settings-error">{error}</p> : null}

      {isPlanSelectionOpen && !isPaymentProcessing ? (
        <BillingPanelPlanPickerOverlay
          token={token}
          workspaceId={workspaceId}
          billing={billing}
          freePlanFeatures={freePlanFeatures}
          planInterval={planInterval}
          setPlanInterval={setPlanInterval}
          pendingAction={pendingAction}
          redirectTo={redirectTo}
          error={error}
          setIsPlanSelectionOpen={setIsPlanSelectionOpen}
        />
      ) : null}

      {isTopupModalOpen ? (
        <BillingPanelTopupModal
          token={token}
          workspaceId={workspaceId}
          billing={billing}
          isCheckoutAvailable={isCheckoutAvailable}
          pendingAction={pendingAction}
          redirectTo={redirectTo}
          error={error}
          setIsTopupModalOpen={setIsTopupModalOpen}
        />
      ) : null}
    </section>
  );
}

async function readWorkspaceBilling(input: { token: string; workspaceId: string }) {
  return getWorkspaceBilling(input);
}

function useWorkspaceBillingData(input: {
  token: string | null | undefined;
  workspaceId: string;
  isPaymentProcessing: boolean;
  pendingAction: string | null;
}) {
  const queryClient = useQueryClient();
  const billingQuery = useQuery({
    queryKey: ["workspace-billing", input.workspaceId],
    queryFn: () => {
      if (input.token === null || input.token === undefined) {
        throw new Error(BILLING_PANEL_COPY.billingSessionMissing);
      }

      return readWorkspaceBilling({ token: input.token, workspaceId: input.workspaceId });
    },
    enabled: input.token !== null && input.token !== undefined,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval:
      input.isPaymentProcessing || input.pendingAction === "confirming" ? BILLING_REFETCH_INTERVAL_MS : false,
  });
  const loadBilling = useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: ["workspace-billing", input.workspaceId],
        queryFn: () => {
          if (input.token === null || input.token === undefined) {
            throw new Error(BILLING_PANEL_COPY.billingSessionMissing);
          }

          return readWorkspaceBilling({ token: input.token, workspaceId: input.workspaceId });
        },
        staleTime: 0,
      }),
    [input.token, input.workspaceId, queryClient],
  );

  return {
    queryClient,
    billingQuery,
    billing: billingQuery.data ?? null,
    isLoading: billingQuery.isPending,
    loadBilling,
  };
}

function buildBillingPanelFreePlanFeatures(trialOffer: ReturnType<typeof useTrialOffer>) {
  if (trialOffer.isFetchedAfterMount && trialOffer.isSuccess) {
    const meetingLabel =
      trialOffer.remaining === 1 ? BILLING_PANEL_COPY.meetingSingular : BILLING_PANEL_COPY.meetingsPlural;

    return [
      `${trialOffer.remaining} ${BILLING_PANEL_COPY.freeMeetingsLeftPrefix} ${meetingLabel} ${BILLING_PANEL_COPY.freeMeetingsLeftSuffix}`,
      ...FREE_PLAN_FEATURES.slice(1),
    ];
  }

  return FREE_PLAN_FEATURES;
}

function canStartSubscriptionCheckout(input: {
  billing: WorkspaceBillingSummary | null | undefined;
  plan: "pro" | "max";
  interval: "month" | "year";
}): boolean {
  return (
    input.billing?.subscriptionCheckoutOptions.some(
      (option) => option.plan === input.plan && option.interval === input.interval,
    ) ?? false
  );
}

function getBillingPanelPresentation(input: {
  checkout: { status?: string; kind?: string } | null | undefined;
  isPaymentProcessing: boolean;
  billing: WorkspaceBillingSummary | null;
}) {
  const subscription =
    input.checkout?.kind === "subscription" && input.isPaymentProcessing ? null : (input.billing?.subscription ?? null);
  const isCheckoutAvailable = input.billing?.checkoutAvailable ?? false;
  const isPrivateBetaPro = input.billing ? hasPrivateBetaWorkspaceAccess(input.billing) : false;
  const extraCredits = input.billing ? input.billing.pool.topupCredits + input.billing.pool.promotionalCredits : 0;
  const extraBalanceMicroUsd = input.billing ? extraCredits * input.billing.topup.pricePerCreditMicroUsd : 0;

  return { subscription, isCheckoutAvailable, isPrivateBetaPro, extraBalanceMicroUsd };
}

export function BillingPanel({ token, workspaceId }: { token?: string | null; workspaceId: string }) {
  const trialOffer = useTrialOffer(token, workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isPlanSelectionOpen, setIsPlanSelectionOpen] = useState(false);
  const [planInterval, setPlanInterval] = useState<"month" | "year">("year");
  const [isTopupModalOpen, setIsTopupModalOpen] = useState(false);
  const [isShowingAllInvoices, setIsShowingAllInvoices] = useState(false);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const [isConfirmingCheckout, setIsConfirmingCheckout] = useState(false);

  const checkout = trialOffer.data?.checkout;
  const isPaymentProcessing = checkout?.status === "processing" || isConfirmingCheckout;
  const { queryClient, billingQuery, billing, isLoading, loadBilling } = useWorkspaceBillingData({
    token,
    workspaceId,
    isPaymentProcessing,
    pendingAction,
  });

  useBillingPanelEffects({
    token,
    workspaceId,
    queryClient,
    loadBilling,
    hasSubscriptionActive: trialOffer.data?.subscriptionActive,
    checkoutStatus: checkout?.status,
    isPlanSelectionOpen,
    isTopupModalOpen,
    setPlanInterval,
    setIsPlanSelectionOpen,
    setIsTopupModalOpen,
    setIsConfirmingCheckout,
    setPendingAction,
    setBillingNotice,
    setError,
  });

  const redirectTo = useCallback((input: { action: string; getUrl: () => Promise<string> }) => {
    setPendingAction(input.action);
    setError(null);
    void (async () => {
      try {
        const url = await input.getUrl();
        window.location.assign(url);
      } catch (nextError) {
        setError(getApiErrorMessage({ error: nextError, fallback: BILLING_PANEL_COPY.stripeOpenError }));
        setPendingAction(null);
      }
    })();
  }, []);

  if (token === null || token === undefined) {
    return null;
  }

  const { subscription, isCheckoutAvailable, isPrivateBetaPro, extraBalanceMicroUsd } = getBillingPanelPresentation({
    checkout,
    isPaymentProcessing,
    billing,
  });
  const freePlanFeatures = buildBillingPanelFreePlanFeatures(trialOffer);

  return (
    <BillingPanelView
      token={token}
      workspaceId={workspaceId}
      isLoading={isLoading}
      billing={billing}
      checkout={checkout}
      subscription={subscription}
      billingNotice={billingNotice}
      isBillingQueryError={billingQuery.isError}
      onBillingRetry={() => void billingQuery.refetch()}
      isPaymentProcessing={isPaymentProcessing}
      isCheckoutAvailable={isCheckoutAvailable}
      isPrivateBetaPro={isPrivateBetaPro}
      extraBalanceMicroUsd={extraBalanceMicroUsd}
      freePlanFeatures={freePlanFeatures}
      pendingAction={pendingAction}
      redirectTo={redirectTo}
      isShowingAllInvoices={isShowingAllInvoices}
      setIsShowingAllInvoices={setIsShowingAllInvoices}
      isPlanSelectionOpen={isPlanSelectionOpen}
      setIsPlanSelectionOpen={setIsPlanSelectionOpen}
      planInterval={planInterval}
      setPlanInterval={setPlanInterval}
      isTopupModalOpen={isTopupModalOpen}
      setIsTopupModalOpen={setIsTopupModalOpen}
      error={error}
    />
  );
}
