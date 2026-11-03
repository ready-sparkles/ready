"use client";

import Link from "next/link";
import React, { useState } from "react";

import { type PlanInterval, PricingPlanCards } from "./pricing-plan-cards";
import { PublicFaqSection } from "./public-faq-section";
import { PublicTopbar } from "./public-topbar";

const PUBLIC_PRICING_ARIA_LABEL = "Ready pricing";
const PUBLIC_PRICING_TITLE_ID = "public-pricing-title";
const PUBLIC_PRICING_TITLE = "Pricing";
const PUBLIC_PRICING_BILLING_INTERVAL_LABEL = "Billing interval";
const PUBLIC_PRICING_TOGGLE_MONTHLY = "Monthly";
const PUBLIC_PRICING_TOGGLE_YEARLY = "Yearly";
const PUBLIC_PRICING_FREE_DESCRIPTION = "For trying Ready in your next three meetings.";
const PUBLIC_PRICING_PRO_DESCRIPTION = "For people and teams who meet regularly.";
const PUBLIC_PRICING_CTA = "Start a trial";
const PUBLIC_PRICING_FAQ_ID = "public-pricing-faq";
const PUBLIC_PRICING_FOOTER_COPYRIGHT_PREFIX = "© ";
const PUBLIC_PRICING_FOOTER_COPYRIGHT_SUFFIX = " Ready";
const PUBLIC_PRICING_FOOTER_UPDATES = "Updates";
const PUBLIC_PRICING_FOOTER_PRIVACY = "Privacy";
const PUBLIC_PRICING_FOOTER_TERMS = "Terms";

const PRICING_FAQ_ITEMS = [
  {
    question: "What can I try for free?",
    answer:
      "Your trial includes up to 3 meetings with live summaries, context on the people you meet, voice chat with Ready, and automatic notes and tasks. Talk with your Ready agent when you’re alone in the meeting. AI usage limits apply. When you upgrade, your paid plan’s allowance starts fresh.",
  },
  {
    question: "How much does Pro cost?",
    answer:
      "Pro costs $25 per active user each month, or $204 per active user per year. Annual billing works out to $17 per month, a saving of 32%. Pro includes unlimited meetings. AI features use credits, so unlimited meetings does not mean unlimited AI usage.",
  },
  {
    question: "What does Max include?",
    answer:
      "Max costs $100 per active user per month when billed annually ($1,200 per year), or $120 per user on monthly billing. It includes everything in Pro and 250 credits per user each month. Those credits go further: for the same models and tasks, Max can provide up to 10× as much AI usage as Pro. Small tasks may see a smaller difference because each charge rounds up to a whole credit. Max is for people who need more AI usage, such as frequent live summaries, assistant answers, and research. Usage limits still apply.",
  },
  {
    id: "usage",
    question: "What does usage mean?",
    answer:
      "Usage is the AI work Ready does for you, measured in credits. You can choose which models Ready uses for meeting intelligence. Different models use different amounts of credits for the same work. Choosing a model that uses fewer credits makes your allowance last longer; choosing one that uses more credits uses up your allowance faster. Live summary and live help use more credits because they keep working as the conversation unfolds. Longer meetings and more AI activity can use more of your allowance. Meeting notes, assistant answers, and research also use credits based on the work they do. Check Settings → Billing to see your remaining usage.",
  },
  {
    question: "How do AI credits work?",
    answer:
      "AI features use credits based on the work they do. Your paid plan’s included credits are used first. If you need more, you can buy credits for $0.10 each in packs of 100 or more. Purchased credits never expire.",
  },
  {
    question: "How is my meeting data protected?",
    answer:
      "Ready uses encryption in transit, secure sign-in, access controls, and monitoring to protect your data. Your meeting content is not used to train AI models. AI providers process it only to deliver the Ready features you use.",
  },
  {
    question: "Can I cancel my plan?",
    answer:
      "Yes. Cancel anytime in Settings → Billing. You keep Pro until the end of the period you have paid for, then your workspace returns to Free.",
  },
] as const;

export function PublicPricingPage(): React.JSX.Element {
  const [planInterval, setPlanInterval] = useState<PlanInterval>("year");
  const proSignupHref = `/signup?callbackUrl=${encodeURIComponent(
    `/workspace/settings?tab=billing&upgrade=${planInterval}`,
  )}`;

  return (
    <main className="public-pricing-page" aria-label={PUBLIC_PRICING_ARIA_LABEL}>
      <PublicTopbar surface="light" />

      <section className="public-pricing-shell" aria-labelledby={PUBLIC_PRICING_TITLE_ID}>
        <div className="plan-select-content public-pricing-content">
          <h1 id={PUBLIC_PRICING_TITLE_ID} className="plan-select-title public-pricing-title">
            {PUBLIC_PRICING_TITLE}
          </h1>

          <div className="plan-select-toggle-row">
            <div className="plan-select-toggle" role="group" aria-label={PUBLIC_PRICING_BILLING_INTERVAL_LABEL}>
              <button
                type="button"
                className={planInterval === "month" ? "plan-select-toggle-active" : ""}
                aria-pressed={planInterval === "month"}
                onClick={() => setPlanInterval("month")}
              >
                {PUBLIC_PRICING_TOGGLE_MONTHLY}
              </button>
              <button
                type="button"
                className={planInterval === "year" ? "plan-select-toggle-active" : ""}
                aria-pressed={planInterval === "year"}
                onClick={() => setPlanInterval("year")}
              >
                {PUBLIC_PRICING_TOGGLE_YEARLY}
              </button>
            </div>
          </div>

          <PricingPlanCards
            planInterval={planInterval}
            freeDescription={PUBLIC_PRICING_FREE_DESCRIPTION}
            proDescription={PUBLIC_PRICING_PRO_DESCRIPTION}
            freeCtaLabel={PUBLIC_PRICING_CTA}
            freeCtaVariant="outline"
            freeCtaHref="/signup"
            proCtaLabel={PUBLIC_PRICING_CTA}
            proCtaHref={proSignupHref}
            maxCtaLabel={PUBLIC_PRICING_CTA}
            maxCtaHref="/signup"
          />
        </div>
      </section>

      <PublicFaqSection id={PUBLIC_PRICING_FAQ_ID} items={PRICING_FAQ_ITEMS} className="public-pricing-faq" />

      <footer className="public-home-footer public-pricing-footer">
        <span className="public-home-footer-copyright">
          {PUBLIC_PRICING_FOOTER_COPYRIGHT_PREFIX}
          {new Date().getFullYear()}
          {PUBLIC_PRICING_FOOTER_COPYRIGHT_SUFFIX}
        </span>
        <Link href="/updates">{PUBLIC_PRICING_FOOTER_UPDATES}</Link>
        <Link href="/privacy">{PUBLIC_PRICING_FOOTER_PRIVACY}</Link>
        <Link href="/terms">{PUBLIC_PRICING_FOOTER_TERMS}</Link>
      </footer>
    </main>
  );
}
