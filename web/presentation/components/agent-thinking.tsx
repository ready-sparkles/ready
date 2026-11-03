import type { ReactNode, RefObject } from "react";
import React from "react";
import { ThinkingOrb } from "thinking-orbs";

type InlineAgentOrbState = "shaping" | "breathing";

function AgentThinkingSignal({ state }: { state: InlineAgentOrbState }) {
  return <ThinkingOrb state={state} size={20} theme="auto" className="workspace-thinking-signal" aria-hidden="true" />;
}

export function AgentBreathingSignal() {
  return <AgentThinkingSignal state="breathing" />;
}

export function AgentThinkingBlock({
  title,
  detail,
  className,
  blockRef,
  orbState = "shaping",
}: {
  title: string;
  detail: ReactNode;
  className?: string;
  blockRef?: RefObject<HTMLElement | null>;
  orbState?: InlineAgentOrbState;
}) {
  return (
    <div
      ref={(node) => {
        const targetRef = blockRef;
        if (targetRef) {
          targetRef.current = node;
        }
      }}
      className={`workspace-thinking-block${className !== undefined && className !== "" ? ` ${className}` : ""}`}
      role="status"
    >
      <AgentThinkingSignal state={orbState} />
      <div className="workspace-thinking-block-copy">
        <div className="workspace-thinking-block-line">{title}</div>
        <p>{detail}</p>
      </div>
    </div>
  );
}
