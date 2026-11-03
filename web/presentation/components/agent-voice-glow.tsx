"use client";

import { useCallback } from "react";
import { VoiceBeam, type VoiceBeamLevel } from "voice-glow";

// VoiceBeam applies this gain to streams, but manual level inputs bypass it.
const VOICE_BEAM_DEFAULT_SENSITIVITY = 3.1;

// Match the new memory card's --shimmer-blue-* palette in memory-stack.css.
const memoryBlues = [
  "rgb(114, 151, 207)",
  "rgb(96, 124, 164)",
  "rgb(82, 107, 143)",
  "rgb(66, 88, 119)",
  "rgb(49, 65, 87)",
  "rgb(35, 45, 58)",
  "rgb(114, 151, 207)",
];
const memoryBlueBand = {
  core: "rgb(114, 151, 207)",
  above: "rgb(82, 107, 143)",
  mid: "rgb(96, 124, 164)",
  below: "rgb(66, 88, 119)",
};

type AgentVoiceGlowProps = {
  /** @external VoiceBeam consumer prop */
  active: boolean;
  /** @external VoiceBeam consumer prop */
  speaking: boolean;
  level: VoiceBeamLevel;
};

/** Decorative audio feedback along the toolbar without changing its hit targets. */
export function AgentVoiceGlow(props: AgentVoiceGlowProps) {
  const isActive = props.active;
  const isSpeaking = props.speaking;
  const level = props.level;

  const readLevel = useCallback(() => {
    const raw = typeof level === "function" ? level() : level;

    // Use the library's standard gain with its unchanged gate and envelope.
    return isSpeaking && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw * VOICE_BEAM_DEFAULT_SENSITIVITY)) : 0;
  }, [level, isSpeaking]);

  return (
    <VoiceBeam
      aria-hidden="true"
      className="live-agent-voice-glow"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 0,
      }}
      theme="dark"
      type="default"
      active={isActive}
      colors={memoryBlues}
      bandColors={memoryBlueBand}
      staticColors
      saturation={1}
      borderRadius={999}
      level={readLevel}
    >
      <span />
    </VoiceBeam>
  );
}
