"use client";

import { useEffect, useRef, useState } from "react";

import { ApiError, getApiErrorMessage, startWorkspaceBillingCheckout } from "../../composition/api";

import { DayLogoFlip } from "./day-logo-flip";
import { MONTHLY_PRICE_USD } from "./pricing-plan-cards";

const FORBIDDEN_HTTP_STATUS = 403;

const MEETING_PRO_UPGRADE_COPY = {
  ariaLabel: "Ready Pro",
  productName: "Ready Pro",
  perMonth: "/month",
  openingStripe: "Opening Stripe…",
  paymentProcessing: "Payment processing",
  tryUpgradingAgain: "Try upgrading again",
  upgradeToPro: "Upgrade to Pro",
  paymentProcessingStatus: "Pro will activate automatically once your payment is confirmed.",
  paymentFailedStatus: "Your payment failed. You can try again.",
  ownerUpgradeMessage: "Your workspace owner can upgrade your team to Pro.",
  checkoutFailedFallback: "Could not open Stripe. Please try again.",
  agentsBenefit: "Work with AI agents right inside your video meetings",
  memoryBenefit: "Memory that carries across meetings",
  pricePrefix: "$",
} as const;

function FeatureIcon({ kind }: { kind: "agents" | "memory" }) {
  const paths = {
    agents:
      "M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672ZM12 2.25V4.5m5.834.166-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243-1.59-1.59",
    // Same geometry as the person card's memory timeline.
    memory: "m15 15 6-6m0 0-6-6m6 6H9a6 6 0 0 0 0 12h3",
  };

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

function MemoryIllustration({ playbackKey }: { playbackKey?: string }) {
  return (
    <div className="meeting-pro-art" aria-hidden="true">
      <div className="meeting-pro-art-composition">
        <div className="meeting-pro-art-halo" />
        <div className="meeting-pro-art-plane is-back" />
        <div className="meeting-pro-art-plane is-middle" />
        <div className="meeting-pro-art-plane is-front">
          <DayLogoFlip playbackKey={playbackKey} />
        </div>
      </div>
    </div>
  );
}

function MeetingProBenefitsList() {
  return (
    <ul className="meeting-pro-benefits">
      <li>
        <FeatureIcon kind="agents" />
        <strong>{MEETING_PRO_UPGRADE_COPY.agentsBenefit}</strong>
      </li>
      <li>
        <FeatureIcon kind="memory" />
        <strong>{MEETING_PRO_UPGRADE_COPY.memoryBenefit}</strong>
      </li>
    </ul>
  );
}

const MEETING_PRO_UPGRADE_CLASS_NAME = "meeting-pro-upgrade workspace-notes-locked-card";

export function MeetingProUpgradeCard({
  token,
  workspaceId,
  paymentStatus,
  logoPlaybackKey,
}: {
  token?: string;
  workspaceId?: string;
  paymentStatus?: "processing" | "failed";
  logoPlaybackKey?: string;
}) {
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    if (!isOpening) {
      pending.current = false;
    }
  }, [isOpening]);

  async function openCheckout() {
    if (
      pending.current ||
      paymentStatus === "processing" ||
      token === undefined ||
      token === "" ||
      workspaceId === undefined ||
      workspaceId === ""
    ) {
      return;
    }
    pending.current = true;
    setIsOpening(true);
    setError(null);
    try {
      const url = await startWorkspaceBillingCheckout({ token, workspaceId, interval: "month" });
      window.location.assign(url);
    } catch (nextError) {
      setError(
        nextError instanceof ApiError && nextError.status === FORBIDDEN_HTTP_STATUS
          ? MEETING_PRO_UPGRADE_COPY.ownerUpgradeMessage
          : getApiErrorMessage({ error: nextError, fallback: MEETING_PRO_UPGRADE_COPY.checkoutFailedFallback }),
      );
      setIsOpening(false);
    }
  }

  return (
    <section className={MEETING_PRO_UPGRADE_CLASS_NAME} aria-label={MEETING_PRO_UPGRADE_COPY.ariaLabel}>
      <div className="meeting-pro-card">
        <div className="meeting-pro-offer">
          <h3 className="meeting-pro-name">{MEETING_PRO_UPGRADE_COPY.productName}</h3>
          <div className="meeting-pro-price">
            <strong>
              {MEETING_PRO_UPGRADE_COPY.pricePrefix}
              {MONTHLY_PRICE_USD}
            </strong>
            <span>{MEETING_PRO_UPGRADE_COPY.perMonth}</span>
          </div>
          <button
            type="button"
            className="meeting-pro-cta"
            disabled={
              isOpening ||
              paymentStatus === "processing" ||
              token === undefined ||
              token === "" ||
              workspaceId === undefined ||
              workspaceId === ""
            }
            onClick={() => void openCheckout()}
            aria-busy={isOpening}
          >
            {isOpening
              ? MEETING_PRO_UPGRADE_COPY.openingStripe
              : paymentStatus === "processing"
                ? MEETING_PRO_UPGRADE_COPY.paymentProcessing
                : paymentStatus === "failed"
                  ? MEETING_PRO_UPGRADE_COPY.tryUpgradingAgain
                  : MEETING_PRO_UPGRADE_COPY.upgradeToPro}
          </button>
          {paymentStatus !== undefined ? (
            <p className="meeting-pro-payment-status" role="status">
              {paymentStatus === "processing"
                ? MEETING_PRO_UPGRADE_COPY.paymentProcessingStatus
                : MEETING_PRO_UPGRADE_COPY.paymentFailedStatus}
            </p>
          ) : null}
          {error !== null && error !== "" ? (
            <p className="meeting-pro-error" role="alert">
              {error}
            </p>
          ) : null}
          <MeetingProBenefitsList />
        </div>
        <MemoryIllustration key={logoPlaybackKey} playbackKey={logoPlaybackKey} />
      </div>
    </section>
  );
}
