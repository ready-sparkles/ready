"use client";

import { useEffect, useState } from "react";

import { VoiceModeComposingOrb, VoiceModeIcon } from "./live-meeting-visuals";

type VoiceModeControlIconProps = {
  /** @external live meeting toolbar prop */
  active: boolean;
  /** @external live meeting toolbar prop */
  visible: boolean;
};

export function VoiceModeControlIcon(props: VoiceModeControlIconProps) {
  const isActive = props.active;
  const isVisible = props.visible;
  const [isLastVisibleActive, setIsLastVisibleActive] = useState(isActive);
  useEffect(() => {
    if (isVisible) {
      setIsLastVisibleActive(isActive);
    }
  }, [isActive, isVisible]);

  // Preserve the outgoing glyph while the disabled control fades away.
  const shouldShowComposingOrb = isVisible ? isActive : isLastVisibleActive;

  return shouldShowComposingOrb ? <VoiceModeComposingOrb /> : <VoiceModeIcon />;
}
