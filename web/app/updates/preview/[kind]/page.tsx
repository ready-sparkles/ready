import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ProductExample } from "./product-example";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (kind !== "summary" && kind !== "guests" && kind !== "people" && kind !== "voice" && kind !== "meeting") {
    notFound();
  }

  return <ProductExample kind={kind} />;
}
