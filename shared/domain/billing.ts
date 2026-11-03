import { z } from "zod";

import { userPlanSchema } from "./types";

const MAX_BILLING_CHECKOUT_SESSION_ID_LENGTH = 255;

/** Paid access remains available briefly while Stripe retries a failed invoice. */
export const BILLING_PAST_DUE_GRACE_DAYS = 7;

export const billingPlanIntervalSchema = z.enum(["month", "year"]);

export const billingSubscriptionSummarySchema = z.object({
  status: z.string().min(1),
  planInterval: billingPlanIntervalSchema,
  includedCreditsPerPeriod: z.number().int().nonnegative(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});

export const billingPaymentMethodSchema = z.object({
  type: z.enum(["card", "link", "other"]),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
});

export const billingInvoiceSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  totalMicroUsd: z.number().int(),
  status: z.string().min(1),
  hostedInvoiceUrl: z.string().url().nullable(),
});

export const billingSummarySchema = z.object({
  plan: z.string().min(1),
  privateBetaPro: z.boolean(),
  subscription: billingSubscriptionSummarySchema.nullable(),
  credits: z.object({
    balance: z.number().int().nonnegative(),
    subscriptionCredits: z.number().int().nonnegative(),
    topupCredits: z.number().int().nonnegative(),
    promotionalCredits: z.number().int().nonnegative(),
    nextExpiry: z.string().nullable(),
  }),
  topup: z.object({
    minCredits: z.number().int().positive(),
    maxCredits: z.number().int().positive(),
    pricePerCreditMicroUsd: z.number().int().positive(),
  }),
  /** False when the API is missing Stripe configuration (e.g. local dev). */
  checkoutAvailable: z.boolean(),
  paymentMethod: billingPaymentMethodSchema.nullable(),
  invoices: z.array(billingInvoiceSchema),
});

export const billingSummaryResponseSchema = z.object({
  billing: billingSummarySchema,
});

// --- Workspace-subject billing -------------------------------------------------

export const workspaceBillingSubscriptionSummarySchema = z.object({
  status: z.string().min(1),
  planInterval: billingPlanIntervalSchema,
  /** Monthly credit allowance each paid seat includes (derived, not pooled). */
  includedCreditsPerSeat: z.number().int().nonnegative(),
  seatQuantity: z.number().int().positive(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});

export const subscriptionCheckoutOptionSchema = z.object({
  plan: z.enum(["pro", "max"]),
  interval: billingPlanIntervalSchema,
});
export type SubscriptionCheckoutOption = z.infer<typeof subscriptionCheckoutOptionSchema>;

export const workspaceBillingSummarySchema = z.object({
  plan: z.string().min(1),
  /** Current billable member count used as Checkout quantity. */
  activeSeatCount: z.number().int().positive(),
  /** The viewing Owner's legacy private-beta entitlement. */
  privateBetaPro: z.boolean(),
  subscription: workspaceBillingSubscriptionSummarySchema.nullable(),
  /** Purchased top-ups shared by the whole workspace (allowance overflow). */
  pool: z.object({
    balance: z.number().int().nonnegative(),
    topupCredits: z.number().int().nonnegative(),
    promotionalCredits: z.number().int().nonnegative(),
    nextExpiry: z.string().nullable(),
  }),
  /** Aggregate eligible free-trial remainder across active workspace members. */
  freeTrial: z.object({
    memberCount: z.number().int().nonnegative(),
    remainingCredits: z.number().int().nonnegative(),
  }),
  topup: z.object({
    minCredits: z.number().int().positive(),
    maxCredits: z.number().int().positive(),
    pricePerCreditMicroUsd: z.number().int().positive(),
  }),
  checkoutAvailable: z.boolean(),
  /** Plan and interval pairs whose Checkout can start (Stripe and that plan's price are configured). */
  subscriptionCheckoutOptions: z.array(subscriptionCheckoutOptionSchema),
  paymentMethod: billingPaymentMethodSchema.nullable(),
  invoices: z.array(billingInvoiceSchema),
});

export const workspaceBillingSummaryResponseSchema = z.object({
  billing: workspaceBillingSummarySchema,
});

/** A member's own spending power inside one workspace. */
export const workspaceMemberBillingSchema = z.object({
  checkout: z
    .object({
      kind: z.enum(["subscription", "topup"]),
      status: z.enum(["processing", "failed"]),
      startedAt: z.string(),
    })
    .nullable()
    .default(null),
  plan: userPlanSchema,
  subscriptionActive: z.boolean(),
  allowanceCredits: z.number().int().nonnegative(),
  allowanceUsed: z.number().int().nonnegative(),
  allowanceRemaining: z.number().int().nonnegative(),
  allowanceWindowEnd: z.string().nullable(),
  poolBalance: z.number().int().nonnegative(),
  trialEligible: z.boolean(),
  trialCreditsUsed: z.number().int().nonnegative(),
  hasTrialCredits: z.boolean(),
  trialMeetingsRemaining: z.number().int().nonnegative().default(0),
});

export const workspaceMemberBillingResponseSchema = z.object({
  billing: workspaceMemberBillingSchema,
});

export const billingCheckoutRequestSchema = z.object({
  plan: z.enum(["pro", "max"]).default("pro"),
  interval: billingPlanIntervalSchema,
});

export const billingTopupRequestSchema = z.object({
  credits: z.number().int().positive(),
});

export const billingRedirectResponseSchema = z.object({
  url: z.string().url(),
});

export const billingCheckoutConfirmationRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(MAX_BILLING_CHECKOUT_SESSION_ID_LENGTH),
});

export const billingCheckoutConfirmationResponseSchema = z.object({
  confirmed: z.boolean(),
  status: z.enum(["open", "processing", "expired", "failed"]).optional(),
});

export type BillingPlanInterval = z.infer<typeof billingPlanIntervalSchema>;
export type BillingSummary = z.infer<typeof billingSummarySchema>;
export type WorkspaceBillingSummary = z.infer<typeof workspaceBillingSummarySchema>;
export type WorkspaceMemberBilling = z.infer<typeof workspaceMemberBillingSchema>;
export type BillingPaymentMethod = z.infer<typeof billingPaymentMethodSchema>;
export type BillingInvoice = z.infer<typeof billingInvoiceSchema>;

export const FREE_PLAN_INCLUDED_NOTES_MEETINGS = 3;

export function getTrialOfferMeetingsRemaining(input: {
  isTrialEligible: boolean;
  hasTrialCredits: boolean;
  hasPaidAccess: boolean;
  hasGrantCredits: boolean;
  allowanceRemaining: number;
  poolBalance: number;
  hostedMeetings: number;
}): number {
  const hasCreditAccess = input.hasGrantCredits || input.allowanceRemaining > 0 || input.poolBalance > 0;

  return input.isTrialEligible && !input.hasPaidAccess && !hasCreditAccess
    ? Math.max(0, FREE_PLAN_INCLUDED_NOTES_MEETINGS - input.hostedMeetings)
    : 0;
}
