import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { BillingPlanInterval } from "@readymeet/shared";

import { bindPortFunction } from "./bind-port";

const STRIPE_BILLING_PORT_IS_NOT_CONFIGURED_MESSAGE = "StripeBilling port is not configured.";

type CreditGrantResult = Awaited<ReturnType<RepositoryPort["createCreditGrant"]>>;

type StripeBillingPort = {
  hasActiveSubscription: (...args: [userId: string]) => Promise<boolean>;
  grantCurrentMonthCredits: (input: {
    userId: string;
    stripeSubscriptionId: string;
    planInterval: BillingPlanInterval;
    periodStart: Date | null;
    periodEnd: Date | null;
    now?: Date;
  }) => Promise<CreditGrantResult>;
  isStripeConfigured: () => boolean;
};

const stripeBillingState: { port?: StripeBillingPort } = {};

export function configureStripeBilling(port: StripeBillingPort): void {
  stripeBillingState.port = port;
}

function stripeBilling(): StripeBillingPort {
  if (stripeBillingState.port === undefined) {
    throw new Error(STRIPE_BILLING_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return stripeBillingState.port;
}

export const hasActiveSubscription: StripeBillingPort["hasActiveSubscription"] = bindPortFunction(
  () => stripeBilling().hasActiveSubscription,
);

export const grantCurrentMonthCredits: StripeBillingPort["grantCurrentMonthCredits"] = bindPortFunction(
  () => stripeBilling().grantCurrentMonthCredits,
);

export const isStripeConfigured: StripeBillingPort["isStripeConfigured"] = bindPortFunction(
  () => stripeBilling().isStripeConfigured,
);
