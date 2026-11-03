import type { Metadata } from "next";

import { PublicPricingPage } from "../../presentation/components/public-pricing-page";

export const metadata: Metadata = {
  title: "Pricing | Ready",
  description: "Ready pricing and plans.",
};

export default function PricingPage() {
  return <PublicPricingPage />;
}
