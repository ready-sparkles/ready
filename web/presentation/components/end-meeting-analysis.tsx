"use client";

import type { ReactNode } from "react";
import { ThinkingOrb } from "thinking-orbs";

import type { MeetingDetailPayload } from "../../domain/types";

type EndMeetingAnalysisPhase =
  | "closing_room"
  | "waiting_for_idle"
  | "finalizing_transcript"
  | "synthesizing_notes"
  | "routing";

export type EndMeetingFlowState = {
  startedAt: number;
  phase: EndMeetingAnalysisPhase;
  detail: MeetingDetailPayload | null;
  transientError: string | null;
  activeLabel?: string;
};

const END_MEETING_ANALYSIS_SYNTHESIS_STEP_MS = 650;
export const END_MEETING_ANALYSIS_PHASE_MS = 1_000;

const END_MEETING_ANALYSIS_STEP_LABELS = [
  "Reconstructing the conversation",
  "Separating speakers and moments",
  "Mapping the flow of discussion",
  "Identifying major turning points",
  "Understanding meeting intent",
  "Identifying key themes",
  "Separating discussion from decisions",
  "Resolving what the meeting was really about",
  "Detecting decisions",
  "Measuring confidence behind decisions",
  "Distinguishing final calls from open questions",
  "Tracing tradeoffs and alternatives",
  "Extracting next steps",
  "Detecting work that can be automated",
  "Capturing facts, metrics, and assumptions",
  "Turning discussion into reusable context",
  "Linking this meeting to prior context",
  "Preparing agent actions",
  "Assembling the workspace",
] as const;

const END_MEETING_ANALYSIS_PHASES = [
  {
    label: "Understanding the conversation",
    steps: [
      "Reconstructing the conversation",
      "Separating speakers and moments",
      "Mapping the flow of discussion",
      "Identifying major turning points",
      "Understanding meeting intent",
      "Identifying key themes",
      "Separating discussion from decisions",
      "Resolving what the meeting was really about",
    ],
  },
  {
    label: "Resolving next steps",
    steps: [
      "Detecting decisions",
      "Measuring confidence behind decisions",
      "Distinguishing final calls from open questions",
      "Tracing tradeoffs and alternatives",
      "Extracting next steps",
      "Detecting work that can be automated",
      "Capturing facts, metrics, and assumptions",
    ],
  },
  {
    label: "Preparing the workspace",
    steps: [
      "Turning discussion into reusable context",
      "Linking this meeting to prior context",
      "Preparing agent actions",
      "Assembling the workspace",
    ],
  },
] as const;

type EndMeetingAnalysisOrbState = "solving";

const END_MEETING_ANALYSIS_ORB_STATE = "solving" as const satisfies EndMeetingAnalysisOrbState;

export const END_MEETING_ANALYSIS_MIN_VISIBLE_MS = 3_000;

const END_MEETING_FINALIZING_ARIA_LABEL = "Finalizing meeting";
const END_MEETING_THINKING_ORB_SIZE = 64;

type EndMeetingAnalysisStep = { label: string; status: "complete" | "active" | "pending" };

type EndMeetingAnalysisState = {
  activePhase: string;
  orbState: EndMeetingAnalysisOrbState;
  isFailed: boolean;
  steps: EndMeetingAnalysisStep[];
};

export function getEndMeetingPreparationWaitMs(input: { startedAt: number; now: number }): number {
  return Math.max(0, END_MEETING_ANALYSIS_MIN_VISIBLE_MS - (input.now - input.startedAt));
}

function buildActiveLabelSteps(activeLabel: string): EndMeetingAnalysisStep[] {
  return END_MEETING_ANALYSIS_STEP_LABELS.map((label) => ({
    label,
    status: label === activeLabel ? "active" : "pending",
  }));
}

function resolveStepProgress(input: { elapsedMs: number; phase: EndMeetingAnalysisPhase }): {
  activeStepIndex: number;
  completedStepCount: number;
} {
  const finalStepIndex = END_MEETING_ANALYSIS_STEP_LABELS.length - 1;
  const synthesisFinalIndex = Math.max(0, finalStepIndex - 1);
  const synthesisStepIndex = Math.min(
    synthesisFinalIndex,
    1 + Math.floor(input.elapsedMs / END_MEETING_ANALYSIS_SYNTHESIS_STEP_MS),
  );
  const activeStepIndex =
    input.phase === "routing" ? finalStepIndex : input.phase === "synthesizing_notes" ? synthesisStepIndex : 0;
  const completedStepCount =
    input.phase === "routing" ? finalStepIndex : input.phase === "synthesizing_notes" ? synthesisStepIndex : 0;

  return { activeStepIndex, completedStepCount };
}

function buildTimedSteps(input: { activeStepIndex: number; completedStepCount: number }): EndMeetingAnalysisStep[] {
  return END_MEETING_ANALYSIS_STEP_LABELS.map((label, index) => ({
    label,
    status: index < input.completedStepCount ? "complete" : index === input.activeStepIndex ? "active" : "pending",
  }));
}

function resolveVisiblePhaseIndex(input: { phase: EndMeetingAnalysisPhase; elapsedMs: number }): number {
  if (input.phase === "routing") {
    return END_MEETING_ANALYSIS_PHASES.length - 1;
  }

  return Math.min(END_MEETING_ANALYSIS_PHASES.length - 1, Math.floor(input.elapsedMs / END_MEETING_ANALYSIS_PHASE_MS));
}

export function getEndMeetingAnalysisState(input: {
  flow: EndMeetingFlowState | null;
  now: number;
}): EndMeetingAnalysisState {
  const elapsedMs = input.flow === null ? 0 : Math.max(0, input.now - input.flow.startedAt);
  const phase = input.flow?.phase ?? "closing_room";
  const visiblePhaseIndex = resolveVisiblePhaseIndex({ phase, elapsedMs });
  const isFailed = input.flow?.transientError !== null && input.flow?.transientError !== undefined;
  const activeLabel = input.flow?.activeLabel;

  if (activeLabel !== undefined && activeLabel.length > 0) {
    return {
      activePhase: activeLabel,
      orbState: END_MEETING_ANALYSIS_ORB_STATE,
      isFailed,
      steps: buildActiveLabelSteps(activeLabel),
    };
  }

  const stepProgress = resolveStepProgress({ elapsedMs, phase });
  const steps = buildTimedSteps(stepProgress);
  const activePhaseDefinition = END_MEETING_ANALYSIS_PHASES[visiblePhaseIndex] ?? END_MEETING_ANALYSIS_PHASES[0];
  const activePhase = activePhaseDefinition.label;

  return {
    activePhase,
    orbState: END_MEETING_ANALYSIS_ORB_STATE,
    isFailed,
    steps,
  };
}

type EndMeetingAnalysisOverlayProps = {
  flow: EndMeetingFlowState | null;
  now: number;
  /** @external overlay animation contract */
  disableTextAnimation?: boolean;
  isExiting?: boolean;
  isHandoff?: boolean;
  recoveryActions?: ReactNode;
};

export function EndMeetingAnalysisOverlay({
  flow,
  now,
  disableTextAnimation: isTextAnimationDisabled = false,
  isExiting = false,
  isHandoff = false,
  recoveryActions,
}: EndMeetingAnalysisOverlayProps) {
  const analysisState = getEndMeetingAnalysisState({ flow, now });
  const shouldAnimateText = !isTextAnimationDisabled && !analysisState.isFailed;

  return (
    <section
      className={`live-end-meeting-overlay${isExiting ? " is-exiting" : ""}${isHandoff ? " is-handoff" : ""}`}
      aria-live="polite"
      aria-label={END_MEETING_FINALIZING_ARIA_LABEL}
    >
      <div className="live-end-meeting-analysis">
        <div
          className={`live-end-meeting-thinking-orb-shell${analysisState.isFailed ? " is-failed" : ""}`}
          aria-hidden="true"
        >
          <ThinkingOrb
            state={analysisState.orbState}
            size={END_MEETING_THINKING_ORB_SIZE}
            theme="dark"
            paused={analysisState.isFailed}
            className="live-end-meeting-thinking-orb"
          />
        </div>
        <div className="live-end-meeting-step-text-shell" aria-live="polite">
          <p className="live-end-meeting-step-text" aria-label={analysisState.activePhase}>
            {shouldAnimateText ? (
              <span className="live-end-meeting-step-shimmer" data-text={analysisState.activePhase} aria-hidden="true">
                {analysisState.activePhase}
              </span>
            ) : (
              analysisState.activePhase
            )}
          </p>
        </div>
        {recoveryActions}
      </div>
    </section>
  );
}
