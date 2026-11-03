"use client";

import { useEffect } from "react";

import { getDayIconHref } from "../../domain/day-logo";

export function DynamicFavicon() {
  useEffect(() => {
    const dayNumber = new Date().getDate();
    const href = getDayIconHref({ dayNumber });

    setFaviconLink({ rel: "icon", href });
    setFaviconLink({ rel: "shortcut icon", href });
  }, []);

  return null;
}

function setFaviconLink(input: { rel: "icon" | "shortcut icon"; href: string }) {
  const { rel, href } = input;
  const selector = `link[rel="${rel}"][data-ready-dynamic-favicon="true"]`;
  const existing = document.head.querySelector<HTMLLinkElement>(selector);
  const link = existing ?? document.createElement("link");

  link.rel = rel;
  link.type = "image/svg+xml";
  link.href = href;
  link.dataset.readyDynamicFavicon = "true";

  if (!existing) {
    document.head.appendChild(link);
  }
}
