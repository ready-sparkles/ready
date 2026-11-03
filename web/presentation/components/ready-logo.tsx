"use client";

import { useEffect, useState } from "react";

import { type DayLogoTone, getDayIconHref } from "../../domain/day-logo";

type ReadyLogoProps = {
  className?: string;
  label?: string;
  /** Dark icon tiles: 'mono' is graphite gradients; 'memory' uses the memory
   * shimmer and agent voice glow blues. */
  tone?: DayLogoTone;
};

// The day-mark SVGs carry the brand palette themselves, tuned to the public
// site's action-blue ramp: lit plane #2563EB (the CTA blue), shadow plane
// #1E40AF (same ramp, one stop deeper; the #1D4ED8 CTA hover sits between),
// horizon divider #93C5FD as a pale specular edge, and the day numeral in
// #EFF6FF as the mark's single highlight (~4.7:1 on the lit plane, ~9:1 on
// the shadow plane).
export function ReadyLogo({ className, label = "Ready", tone = "brand" }: ReadyLogoProps) {
  const [dayNumber, setDayNumber] = useState<number | null>(null);

  useEffect(() => {
    setDayNumber(new Date().getDate());
  }, []);

  return <img className={className} src={getDayIconHref({ dayNumber: dayNumber ?? undefined, tone })} alt={label} />;
}
