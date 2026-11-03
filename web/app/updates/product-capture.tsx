"use client";

import { useEffect, useRef, useState } from "react";

import styles from "../../presentation/styles/updates/updates.module.css";

const CAPTURE_WIDTH_COMPACT = 1000;
const CAPTURE_WIDTH_FULL = 1280;
const CAPTURE_HEIGHT_VOICE = 320;
const CAPTURE_HEIGHT_CLOSEUP = 667;
const CAPTURE_HEIGHT_DEFAULT = 564;
const FRAME_WIDTH_CLOSEUP = 1440;
const FRAME_HEIGHT_PEOPLE_OR_MEETING = 800;
const FRAME_HEIGHT_DEFAULT = 1000;

type ProductCaptureKind =
  | "summary"
  | "guests"
  | "people"
  | "dark-notes"
  | "voice"
  | "dark-memory"
  | "dark-tasks"
  | "meeting";

function isCloseupKind(kind: ProductCaptureKind): boolean {
  return (
    kind === "summary" ||
    kind === "meeting" ||
    kind === "dark-tasks" ||
    kind === "dark-memory" ||
    kind === "dark-notes" ||
    kind === "voice" ||
    kind === "people"
  );
}

function captureDimensions(kind: ProductCaptureKind): { width: number; height: number } {
  const isCloseup = isCloseupKind(kind);
  const width = isCloseup ? CAPTURE_WIDTH_COMPACT : CAPTURE_WIDTH_FULL;
  const height = kind === "voice" ? CAPTURE_HEIGHT_VOICE : isCloseup ? CAPTURE_HEIGHT_CLOSEUP : CAPTURE_HEIGHT_DEFAULT;

  return { width, height };
}

const CAPTURE_LABELS: Record<ProductCaptureKind, string> = {
  summary: "Ready meeting room with a shared Summary of decisions, open questions, and tasks. Example data.",
  meeting: "Ready meeting room with cameras off. Example data.",
  "dark-tasks": "Ready workspace with assigned tasks open. Example data.",
  "dark-memory": "Ready workspace with All memory open in dark mode. Example data.",
  voice: "Meeting controls in active voice chat with Ready, with the assistant orb and voice glow. Example.",
  "dark-notes": "Ready workspace showing past meeting notes and tasks in dark mode. Example data.",
  guests: "Waiting room with Sophie Chen’s name and Remember me next time selected. Example.",
  people: "Meeting room with Priya Nair’s person card, private memory, Ashby details, and web research. Example data.",
};

function captureClassName(input: { kind: ProductCaptureKind; isCloseup: boolean }): string {
  const { kind, isCloseup } = input;
  const base = styles.productCapture ?? "";
  const closeupClass = isCloseup ? ` ${styles.darkNotesCapture ?? ""}` : "";
  const voiceClass = kind === "voice" ? ` ${styles.voiceCapture ?? ""}` : "";
  const guestsClass = kind === "guests" ? ` ${styles.waitingRoomCapture ?? ""}` : "";

  return `${base}${closeupClass}${voiceClass}${guestsClass}`;
}

function frameSource(kind: ProductCaptureKind): string {
  if (kind === "dark-notes" || kind === "dark-memory" || kind === "dark-tasks") {
    return `/demo/workspace/${kind}`;
  }

  return `/updates/preview/${kind}`;
}

function frameDimensions(input: { kind: ProductCaptureKind; width: number; height: number; isCloseup: boolean }): {
  width: number;
  height: number;
} {
  if (input.kind === "voice") {
    return { width: input.width, height: input.height };
  }
  if (input.isCloseup) {
    return {
      width: FRAME_WIDTH_CLOSEUP,
      height:
        input.kind === "summary" || input.kind === "people" || input.kind === "meeting"
          ? FRAME_HEIGHT_PEOPLE_OR_MEETING
          : FRAME_HEIGHT_DEFAULT,
    };
  }

  return { width: CAPTURE_WIDTH_FULL, height: FRAME_HEIGHT_DEFAULT };
}

/** A fixed desktop viewport, scaled as a whole so the actual product UI stays 1:1. */
export function ProductCapture({ kind }: { kind: ProductCaptureKind }) {
  const container = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(0);
  const isCloseup = isCloseupKind(kind);
  const { width, height } = captureDimensions(kind);
  const label = CAPTURE_LABELS[kind];
  const frameSize = frameDimensions({ kind, width, height, isCloseup });

  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setScale(entry.contentRect.width / width);
      }
    });
    observer.observe(element);

    return () => observer.disconnect();
  }, [width]);

  return (
    <figure
      ref={container}
      className={captureClassName({ kind, isCloseup })}
      style={{ maxWidth: width, aspectRatio: `${width} / ${height}` }}
      role="img"
      aria-label={label}
    >
      <iframe
        src={frameSource(kind)}
        title={label}
        loading="lazy"
        tabIndex={-1}
        aria-hidden="true"
        className={styles.productFrame ?? ""}
        style={{
          width: frameSize.width,
          height: frameSize.height,
          transform: `scale(${scale})`,
        }}
      />
    </figure>
  );
}
