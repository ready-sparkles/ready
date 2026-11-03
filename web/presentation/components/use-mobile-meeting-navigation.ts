"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

const HISTORY_KEY = "readyMobileMeeting";

type MobileMeetingNavigation = {
  isMobile: boolean;
  isOpen: boolean;
  detailId: string | null;
  open: (id: string) => void;
  close: () => void;
  reset: () => void;
  backButton: RefObject<HTMLButtonElement | null>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Keep both mobile screens mounted so Back preserves the list and its scroll. */
export function useMobileMeetingNavigation(input: {
  view: "past" | "upcoming";
  initialMeetingId: string | null;
}): MobileMeetingNavigation {
  const { view, initialMeetingId } = input;
  const [isMobile, setIsMobile] = useState(false);
  const [isOpen, setIsOpen] = useState(Boolean(initialMeetingId));
  const [detailId, setDetailId] = useState<string | null>(initialMeetingId);
  const backButton = useRef<HTMLButtonElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const listUrl = `/workspace?view=${view}`;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1000px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);

    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const sync = () => {
      const url = new URL(window.location.href);
      const id =
        view === "upcoming"
          ? url.searchParams.get("event")
          : (url.pathname.match(/^\/workspace\/([0-9a-f-]{36})\/?$/i)?.[1] ?? null);
      if (id !== null && id !== "") {
        setDetailId(id);
      }
      setIsOpen(Boolean(id));
    };
    setDetailId(initialMeetingId);
    setIsOpen(Boolean(initialMeetingId));
    if (view === "upcoming") {
      sync();
    }
    window.addEventListener("popstate", sync);

    return () => window.removeEventListener("popstate", sync);
  }, [view, initialMeetingId]);

  useEffect(() => {
    if (!isMobile) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (isOpen) {
        backButton.current?.focus({ preventScroll: true });
      } else if (origin.current?.isConnected === true) {
        origin.current.focus({ preventScroll: true });
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [isMobile, isOpen]);

  const open = useCallback(
    (id: string) => {
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDetailId(id);
      setIsOpen(true);
      const url = view === "past" ? `/workspace/${id}` : `${listUrl}&event=${encodeURIComponent(id)}`;
      // Next supports native history updates without remounting the two screens.
      window.history.pushState({ [HISTORY_KEY]: view }, "", url);
    },
    [view, listUrl],
  );

  const close = useCallback(() => {
    setIsOpen(false);
    const historyState = isRecord(window.history.state) ? window.history.state : null;
    if (historyState?.[HISTORY_KEY] === view) {
      window.history.back();
    } else {
      window.history.replaceState(null, "", listUrl);
    }
  }, [view, listUrl]);

  const reset = useCallback(() => {
    setIsOpen(false);
    setDetailId(null);
    origin.current = null;
    if (isMobile) {
      window.history.replaceState(null, "", listUrl);
    }
  }, [isMobile, listUrl]);

  return { isMobile, isOpen, detailId, open, close, reset, backButton };
}
