export type PlanInterval = "month" | "year";
type FreePlanCtaVariant = "secondary" | "outline";

const MONTHS_PER_YEAR = 12;

const DEFAULT_FREE_DESCRIPTION = "Everything you need to try Ready.";
const DEFAULT_PRO_DESCRIPTION = "Ready for every meeting.";

const COPY_FREE_PLAN_TITLE = "Free";
const COPY_FREE_PLAN_PRICE = "$0";
const COPY_PRO_PLAN_TITLE = "Pro";
const COPY_PRO_PRICE_PREFIX = "$";
const COPY_PER_ACTIVE_USER_MONTH = "per active user / month";
const COPY_BILLED_ANNUALLY = "Billed annually";
const COPY_BILLED_MONTHLY = "Billed monthly";
const PRICING_USAGE_HREF = "/pricing#usage";
const COPY_USAGE_MARKER = "* ";
const COPY_USAGE_LIMITS = "Usage limits";
const COPY_PRICING_NOTE =
  "apply. Prices shown don’t include applicable tax. Ready may update prices and plans at its discretion.";
const COPY_PRO_FEATURE_LEAD = "Everything in Free, plus:";

// Display prices only; the billing implementer will update the Stripe catalog and credit allowances separately.
export const MONTHLY_PRICE_USD = 25;
const YEARLY_PRICE_USD = 204;
const MAX_MONTHLY_PRICE_USD = 120;
const MAX_YEARLY_PRICE_USD = 1200;

export const FREE_PLAN_FEATURES = [
  "Up to 3 free meetings · AI limits apply",
  "Live summaries, decisions, and tasks",
  "Live context on the people you meet",
  "Connect your calendar",
];

export function businessPlanFeatures() {
  return ["More usage*", "Memory across conversations"];
}

// The rounded checkmark from inside the completed-task circle icon
// (workspace-tasks-section.tsx), drawn on its own without the circle.
export function PlanCheckIcon({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={className} fill="none">
      <path
        d="M3.7 8.7l3.1 3.1 5.5-5.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type PricingPlanCardsProps = {
  freePlanFeatures?: readonly string[];
  proPlanFeatures?: readonly string[];
  freeDescription?: string;
  proDescription?: string;
  planInterval: PlanInterval;
  freeCtaLabel: string;
  freeCtaVariant?: FreePlanCtaVariant;
  /** @external pricing plan card prop */
  freeCtaDisabled?: boolean;
  freeCtaHref?: string;
  onFreeCta?: () => void;
  proCtaLabel: string;
  /** @external pricing plan card prop */
  proCtaDisabled?: boolean;
  proCtaHref?: string;
  onProCta?: () => void;
  maxCtaHref?: string;
  maxCtaLabel?: string;
  /** @external pricing plan card prop */
  maxCtaDisabled?: boolean;
  onMaxCta?: () => void;
};

function planCtaHrefIsUsable(href: string | undefined): boolean {
  if (href === undefined) {
    return false;
  }

  return href !== "";
}

function resolveFreeCtaClassName(variant: FreePlanCtaVariant): string {
  if (variant === "outline") {
    return "plan-select-cta plan-select-cta-outline";
  }

  return "plan-select-cta plan-select-cta-secondary";
}

function PlanFeatureList({ features }: { features: readonly string[] }) {
  return (
    <ul className="plan-select-feature-list">
      {features.map((feature) => (
        <li key={feature}>
          <PlanCheckIcon className="plan-select-check-icon" />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}

function PlanSelectCta({
  href,
  isDisabled,
  className,
  label,
  onClick,
}: {
  href?: string;
  isDisabled: boolean;
  className: string;
  label: string;
  onClick?: () => void;
}) {
  if (planCtaHrefIsUsable(href) && !isDisabled) {
    return (
      <a className={className} href={href}>
        {label}
      </a>
    );
  }

  return (
    <button type="button" className={className} disabled={isDisabled} onClick={onClick}>
      {label}
    </button>
  );
}

function FreePlanCard({
  description,
  features,
  ctaLabel,
  ctaVariant,
  isCtaDisabled,
  ctaHref,
  onCta,
}: {
  description: string;
  features: readonly string[];
  ctaLabel: string;
  ctaVariant: FreePlanCtaVariant;
  isCtaDisabled: boolean;
  ctaHref?: string;
  onCta?: () => void;
}) {
  return (
    <div className="plan-select-card">
      <div className="plan-select-card-top">
        <div className="plan-select-card-heading">
          <h3>{COPY_FREE_PLAN_TITLE}</h3>
          <p>{description}</p>
        </div>
        <div className="plan-select-price">
          <strong>{COPY_FREE_PLAN_PRICE}</strong>
        </div>
        <PlanSelectCta
          href={ctaHref}
          isDisabled={isCtaDisabled}
          className={resolveFreeCtaClassName(ctaVariant)}
          label={ctaLabel}
          onClick={onCta}
        />
      </div>
      <PlanFeatureList features={features} />
    </div>
  );
}

function PaidPlanCard({
  title,
  featureLead,
  monthlyPriceUsd,
  yearlyPriceUsd,
  description,
  features,
  planInterval,
  ctaLabel,
  isCtaDisabled,
  ctaHref,
  onCta,
}: {
  title: string;
  featureLead: string;
  monthlyPriceUsd: number;
  yearlyPriceUsd: number;
  description: string;
  features: readonly string[];
  planInterval: PlanInterval;
  ctaLabel: string;
  isCtaDisabled: boolean;
  ctaHref?: string;
  onCta?: () => void;
}) {
  const displayPriceUsd = planInterval === "year" ? yearlyPriceUsd / MONTHS_PER_YEAR : monthlyPriceUsd;
  const billingCopy = planInterval === "year" ? COPY_BILLED_ANNUALLY : COPY_BILLED_MONTHLY;

  return (
    <div className="plan-select-card">
      <div className="plan-select-card-top">
        <div className="plan-select-card-heading">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <div className="plan-select-price">
          <strong>
            {COPY_PRO_PRICE_PREFIX}
            {displayPriceUsd}
          </strong>
          <span>
            {COPY_PER_ACTIVE_USER_MONTH}
            <br />
            {billingCopy}
          </span>
        </div>
        <PlanSelectCta
          href={ctaHref}
          isDisabled={isCtaDisabled}
          className="plan-select-cta plan-select-cta-primary"
          label={ctaLabel}
          onClick={onCta}
        />
      </div>
      <ul className="plan-select-feature-list">
        <li className="plan-select-feature-lead">{featureLead}</li>
        {features.map((feature) => (
          <li key={feature}>
            <PlanCheckIcon className="plan-select-check-icon" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PricingPlanNote() {
  return (
    <p className="plan-select-note">
      {COPY_USAGE_MARKER}
      <a href={PRICING_USAGE_HREF}>{COPY_USAGE_LIMITS}</a> {COPY_PRICING_NOTE}
    </p>
  );
}

export function PricingPlanCards(props: PricingPlanCardsProps) {
  const {
    freePlanFeatures = FREE_PLAN_FEATURES,
    proPlanFeatures = businessPlanFeatures(),
    freeDescription = DEFAULT_FREE_DESCRIPTION,
    proDescription = DEFAULT_PRO_DESCRIPTION,
    planInterval,
    freeCtaLabel,
    freeCtaVariant = "secondary",
    freeCtaHref,
    onFreeCta,
    proCtaLabel,
    proCtaHref,
    onProCta,
  } = props;
  const isFreeCtaDisabled = props.freeCtaDisabled ?? false;
  const isProCtaDisabled = props.proCtaDisabled ?? false;

  return (
    <>
      <div className="plan-select-cards">
        <FreePlanCard
          description={freeDescription}
          features={freePlanFeatures}
          ctaLabel={freeCtaLabel}
          ctaVariant={freeCtaVariant}
          isCtaDisabled={isFreeCtaDisabled}
          ctaHref={freeCtaHref}
          onCta={onFreeCta}
        />
        <PaidPlanCard
          title={COPY_PRO_PLAN_TITLE}
          featureLead={COPY_PRO_FEATURE_LEAD}
          monthlyPriceUsd={MONTHLY_PRICE_USD}
          yearlyPriceUsd={YEARLY_PRICE_USD}
          description={proDescription}
          features={proPlanFeatures}
          planInterval={planInterval}
          ctaLabel={proCtaLabel}
          isCtaDisabled={isProCtaDisabled}
          ctaHref={proCtaHref}
          onCta={onProCta}
        />
        {/* Public cards link to signup; the billing chooser supplies checkout callbacks. */}
        <PaidPlanCard
          title="Max"
          description="For people and teams who need more usage."
          featureLead="Everything in Pro"
          features={["Up to 10× as much AI usage as Pro*"]}
          monthlyPriceUsd={MAX_MONTHLY_PRICE_USD}
          yearlyPriceUsd={MAX_YEARLY_PRICE_USD}
          planInterval={planInterval}
          ctaLabel={props.maxCtaLabel ?? "Choose Max"}
          isCtaDisabled={
            props.maxCtaDisabled ?? (!planCtaHrefIsUsable(props.maxCtaHref) && props.onMaxCta === undefined)
          }
          ctaHref={props.maxCtaHref}
          onCta={props.onMaxCta}
        />
      </div>
      <PricingPlanNote />
    </>
  );
}
