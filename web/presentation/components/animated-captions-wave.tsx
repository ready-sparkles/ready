"use client";

import { useEffect, useRef, useState } from "react";

import { createTimerGroup } from "../lib/timer-group";

import { CaptionsWaveIcon } from "./live-meeting-visuals";

const CAPTIONS_PHASE_SPEED = 0.55;
const CAPTIONS_PHASE_INTERVAL_HZ = 90;
const CAPTIONS_FRAME_INTERVAL_MS = 60;
const CAPTIONS_PHASE_STEP = (CAPTIONS_PHASE_SPEED / CAPTIONS_PHASE_INTERVAL_HZ) * CAPTIONS_FRAME_INTERVAL_MS;

/** Keep decorative frame updates out of the meeting page's render cycle. */
export function AnimatedCaptionsWave({
  isEnabled,
  isActive,
  isError,
  readLevel,
}: {
  isEnabled: boolean;
  isActive: boolean;
  isError: boolean;
  readLevel: () => number;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const isIntersectingRef = useRef(true);
  const [frame, setFrame] = useState({ phase: 0, level: 0 });

  useEffect(() => {
    if (!isEnabled || !isActive || isError) {
      return;
    }
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timers = createTimerGroup();
    const pause = () => {
      timers.clear();
    };
    const sync = () => {
      pause();
      if (document.hidden || !isIntersectingRef.current || reducedMotion.matches) {
        return;
      }
      timers.setInterval({
        run: () => {
          setFrame((current) => ({ phase: current.phase + CAPTIONS_PHASE_STEP, level: readLevel() }));
        },
        intervalMs: CAPTIONS_FRAME_INTERVAL_MS,
      });
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) => {
            isIntersectingRef.current = entry?.isIntersecting ?? false;
            sync();
          });
    if (element.current) {
      observer?.observe(element.current);
    }
    document.addEventListener("visibilitychange", sync);
    reducedMotion.addEventListener("change", sync);
    sync();

    return () => {
      pause();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reducedMotion.removeEventListener("change", sync);
    };
  }, [isEnabled, isActive, isError, readLevel]);

  return (
    <span ref={element} style={{ display: "inline-flex" }}>
      <CaptionsWaveIcon
        isEnabled={isEnabled}
        isActive={isActive}
        isError={isError}
        level={isEnabled && isActive && !isError ? frame.level : 0}
        phase={frame.phase}
      />
    </span>
  );
}
