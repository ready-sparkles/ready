"use client";

import { useEffect, useState } from "react";

import { formatReleaseAge } from "../../domain/updates/format-release-age";

const MINUTE_MS = 60_000;

export function ReleaseAge({ date, fullDate }: { date: string; fullDate: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const update = () => {
      setLabel(formatReleaseAge({ date, fullDate }));
    };
    update();
    const timer = window.setInterval(update, MINUTE_MS);

    return () => window.clearInterval(timer);
  }, [date, fullDate]);

  return (
    <time dateTime={date} title={fullDate} style={label === null ? { visibility: "hidden" } : undefined}>
      {label ?? "\u00a0"}
    </time>
  );
}
