"use client";

import type { WorkspaceBillingSummary } from "@readymeet/shared";

const MAX_CURRENCY_FRACTION_DIGITS = 2;
const MICRO_USD_PER_USD = 1_000_000;
const CREDIT_USAGE_WORKSPACE_ARIA_LABEL = "Workspace credits";
const CREDIT_USAGE_WORKSPACE_TITLE = "Workspace credits";
const CREDIT_USAGE_WORKSPACE_BODY = "Purchased and promotional credits held by your workspace.";
const CREDIT_USAGE_BALANCE_LABEL = "Current balance";

function formatDollarAmount(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 === 0 ? 0 : MAX_CURRENCY_FRACTION_DIGITS,
  }).format(value);
}

export function workspaceCreditBalanceMicroUsd(input: {
  poolCredits: number;
  poolPricePerCreditMicroUsd: number;
}): number {
  return input.poolCredits * input.poolPricePerCreditMicroUsd;
}

export function WorkspaceCreditUsagePanel({ billing }: { billing: Pick<WorkspaceBillingSummary, "pool" | "topup"> }) {
  const balanceMicroUsd = workspaceCreditBalanceMicroUsd({
    poolCredits: billing.pool.balance,
    poolPricePerCreditMicroUsd: billing.topup.pricePerCreditMicroUsd,
  });

  return (
    <section className="workspace-credit-usage-card" aria-label={CREDIT_USAGE_WORKSPACE_ARIA_LABEL}>
      <div className="workspace-credit-usage-hero">
        <h2>{CREDIT_USAGE_WORKSPACE_TITLE}</h2>
        <p>{CREDIT_USAGE_WORKSPACE_BODY}</p>
      </div>

      <div className="workspace-credit-balance">
        <strong>{formatDollarAmount(balanceMicroUsd / MICRO_USD_PER_USD)}</strong>
        <span>{CREDIT_USAGE_BALANCE_LABEL}</span>
      </div>
    </section>
  );
}
