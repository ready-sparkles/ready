import { type MeetingExtraction, type SignalPresence, type SourceSpan } from "@readymeet/shared";

type SignalInferenceExtraction = Pick<
  MeetingExtraction,
  "actionItems" | "decisions" | "highlights" | "keyTopics" | "openQuestions" | "risks" | "signals"
>;

const CONFIDENCE_RANK_HIGH = 3;
const CONFIDENCE_RANK_MEDIUM = 2;
const CONFIDENCE_RANK_LOW = 1;
const MAX_INFERENCE_SOURCE_SPANS = 4;

function confidenceRank(confidence: "low" | "medium" | "high") {
  return confidence === "high"
    ? CONFIDENCE_RANK_HIGH
    : confidence === "medium"
      ? CONFIDENCE_RANK_MEDIUM
      : CONFIDENCE_RANK_LOW;
}

function verifiedSourceSpans(sourceSpans: SourceSpan[]) {
  return sourceSpans.filter((span) => span.verificationStatus !== "unverified");
}

function signalEvidence(sourceSpans: SourceSpan[]) {
  return sourceSpans.map((sourceSpan, index) => ({
    ...sourceSpan,
    sourceSpanIndex: index,
  }));
}

function coreRuleSignal(input: {
  key: SignalPresence["key"];
  confidence: SignalPresence["confidence"];
  sourceSpans: SourceSpan[];
  reasoning: string;
  ruleId: string;
  entities?: Record<string, unknown>;
}): SignalPresence {
  return {
    key: input.key,
    namespace: "readymeet.core",
    confidence: input.confidence,
    sourceSpans: input.sourceSpans,
    evidence: signalEvidence(input.sourceSpans),
    entities: input.entities ?? {},
    sourcePhase: "deterministic_inference",
    origin: {
      kind: "core_rule",
      ruleId: input.ruleId,
    },
    reasoning: input.reasoning,
    createdAt: new Date().toISOString(),
  };
}

function strongestConfidence(confidences: ("low" | "medium" | "high")[]) {
  return [...confidences].sort((left, right) => confidenceRank(right) - confidenceRank(left))[0] ?? "medium";
}

function inferDecisionsMadeSignal(extraction: SignalInferenceExtraction): SignalPresence | null {
  if (extraction.signals.some((signal) => signal.key === "decisions_made")) {
    return null;
  }

  const decisionsWithVerifiedSpans = extraction.decisions
    .map((decision) => ({
      decision,
      sourceSpans: verifiedSourceSpans(decision.sourceSpans),
    }))
    .filter((item) => item.sourceSpans.length !== 0);

  if (decisionsWithVerifiedSpans.length === 0) {
    return null;
  }

  return coreRuleSignal({
    key: "decisions_made",
    confidence: strongestConfidence(decisionsWithVerifiedSpans.map((item) => item.decision.confidence)),
    sourceSpans: decisionsWithVerifiedSpans.flatMap((item) => item.sourceSpans).slice(0, MAX_INFERENCE_SOURCE_SPANS),
    reasoning: "Derived from validated decisions extracted from the meeting.",
    ruleId: "decisions_from_verified_decisions_v1",
  });
}

function textMatchesEngineeringIssue(text: string) {
  const issueTerms =
    /\b(bug|defect|regression|crash|error|exception|failure|failing|broken|incorrect|wrong|overflow|layout|spacing)\b/i;
  const fixTerms = /\b(fix|debug|patch|repair|resolve)\b/i;
  const technicalContext =
    /\b(api|auth|backend|button|database|frontend|interface|job|layout|login|modal|page|panel|screen|service|settings|sso|ui)\b/i;

  return issueTerms.test(text) || (fixTerms.test(text) && technicalContext.test(text));
}

function textMatchesWebResearchTask(text: string) {
  const normalized = text.toLowerCase();
  const researchTerms =
    /\b(research|investigate|validate|verify|compare|comparison|competitive|market map|find|identify|discover|list|extract|scrape|dataset|spreadsheet|table|open web|sources|citations?|pages?|pdfs?|urls?|companies|vendors|startups|tools|products)\b/i;
  const actionableResearchPatterns = [
    /\bfind (?:and )?(?:compare|list|identify|discover)\b/i,
    /\b(compare|rank|benchmark) .{0,80}\b(companies|vendors|tools|products|options|competitors|startups)\b/i,
    /\b(extract|pull|read) .{0,80}\b(pages?|pdfs?|urls?|websites?|documents?)\b/i,
    /\b(build|create|compile) .{0,80}\b(dataset|spreadsheet|table|list|market map)\b/i,
    /\b(current|latest|recent|public|web-backed|sourced|citation)\b/i,
  ];
  const proceduralQuestion =
    /\b(any questions|have questions|questions for me|what questions do you have|interview process|next round|scheduling)\b/i;
  if (proceduralQuestion.test(normalized)) {
    return false;
  }

  return researchTerms.test(normalized) && actionableResearchPatterns.some((pattern) => pattern.test(normalized));
}

function inferActionCommitmentSignal(extraction: SignalInferenceExtraction): SignalPresence | null {
  if (extraction.signals.some((signal) => signal.key === "action_commitments_made")) {
    return null;
  }

  const actionItemsWithVerifiedSpans = extraction.actionItems
    .map((actionItem) => ({
      actionItem,
      sourceSpans: verifiedSourceSpans(actionItem.sourceSpans),
    }))
    .filter((item) => item.sourceSpans.length !== 0);

  const commitmentTerms =
    /\b(can you|could you|will|you'?re on|own(?:ing)?|take that on|start on|send|ship|fix|draft|prepare|schedule|assign|add it|follow up|ping|sync with|review|deploy|create|build)\b/i;
  const commitmentEvidence = [
    ...extraction.decisions.map((decision) => ({
      text: decision.text,
      confidence: decision.confidence,
      sourceSpans: verifiedSourceSpans(decision.sourceSpans),
    })),
    ...extraction.highlights.map((highlight) => ({
      text: [highlight.theme, highlight.takeaway].join(" "),
      confidence: "medium" as const,
      sourceSpans: verifiedSourceSpans(highlight.sourceSpans),
    })),
  ].filter(
    (candidate) =>
      candidate.sourceSpans.length !== 0 &&
      commitmentTerms.test([candidate.text, ...candidate.sourceSpans.map((span) => span.excerpt)].join(" ")),
  );

  if (actionItemsWithVerifiedSpans.length === 0 && commitmentEvidence.length === 0) {
    return null;
  }

  const sourceSpans =
    actionItemsWithVerifiedSpans.length !== 0
      ? actionItemsWithVerifiedSpans.flatMap((item) => item.sourceSpans).slice(0, MAX_INFERENCE_SOURCE_SPANS)
      : commitmentEvidence.flatMap((item) => item.sourceSpans).slice(0, MAX_INFERENCE_SOURCE_SPANS);
  const confidence =
    actionItemsWithVerifiedSpans.length !== 0
      ? strongestConfidence(actionItemsWithVerifiedSpans.map((item) => item.actionItem.confidence))
      : strongestConfidence(commitmentEvidence.map((item) => item.confidence));

  return coreRuleSignal({
    key: "action_commitments_made",
    confidence,
    sourceSpans,
    reasoning:
      actionItemsWithVerifiedSpans.length !== 0
        ? "Derived from validated tasks extracted from the meeting."
        : "Derived from validated decisions and highlights that include explicit ownership or follow-up language.",
    ruleId:
      actionItemsWithVerifiedSpans.length !== 0
        ? "commitments_from_verified_action_items_v1"
        : "commitments_from_grounded_notes_v1",
  });
}

function inferEngineeringIssueSignal(extraction: SignalInferenceExtraction): SignalPresence | null {
  if (extraction.signals.some((signal) => signal.key === "engineering_issue_identified")) {
    return null;
  }

  const candidates: {
    text: string;
    confidence: "low" | "medium" | "high";
    sourceSpans: SourceSpan[];
  }[] = [
    ...extraction.actionItems.map((actionItem) => ({
      text: [actionItem.title, actionItem.description].filter(Boolean).join(" "),
      confidence: actionItem.confidence,
      sourceSpans: verifiedSourceSpans(actionItem.sourceSpans),
    })),
    ...extraction.decisions.map((decision) => ({
      text: decision.text,
      confidence: decision.confidence,
      sourceSpans: verifiedSourceSpans(decision.sourceSpans),
    })),
    ...extraction.risks.map((risk) => ({
      text: risk.text,
      confidence: risk.severity,
      sourceSpans: verifiedSourceSpans(risk.sourceSpans),
    })),
    ...extraction.highlights.map((highlight) => ({
      text: [highlight.theme, highlight.takeaway].join(" "),
      confidence: "medium" as const,
      sourceSpans: verifiedSourceSpans(highlight.sourceSpans),
    })),
  ];

  const matchingCandidates = candidates.filter(
    (candidate) =>
      candidate.sourceSpans.length !== 0 &&
      textMatchesEngineeringIssue([candidate.text, ...candidate.sourceSpans.map((span) => span.excerpt)].join(" ")),
  );
  if (matchingCandidates.length === 0) {
    return null;
  }

  return coreRuleSignal({
    key: "engineering_issue_identified",
    confidence: strongestConfidence(matchingCandidates.map((candidate) => candidate.confidence)),
    sourceSpans: matchingCandidates.flatMap((candidate) => candidate.sourceSpans).slice(0, MAX_INFERENCE_SOURCE_SPANS),
    reasoning: "Derived from validated meeting notes that describe a concrete bug or technical problem.",
    ruleId: "engineering_issue_from_grounded_notes_v1",
  });
}

function inferWebResearchTaskSignal(extraction: SignalInferenceExtraction): SignalPresence | null {
  if (extraction.signals.some((signal) => signal.key === "web_research_task_identified")) {
    return null;
  }

  const candidates: {
    text: string;
    confidence: "low" | "medium" | "high";
    sourceSpans: SourceSpan[];
  }[] = [
    ...extraction.openQuestions.map((question) => ({
      text: question.text,
      confidence: question.priority === "high" ? ("high" as const) : ("medium" as const),
      sourceSpans: verifiedSourceSpans(question.sourceSpans),
    })),
    ...extraction.actionItems.map((actionItem) => ({
      text: [actionItem.title, actionItem.description].filter(Boolean).join(" "),
      confidence: actionItem.confidence,
      sourceSpans: verifiedSourceSpans(actionItem.sourceSpans),
    })),
    ...extraction.highlights.map((highlight) => ({
      text: [highlight.theme, highlight.takeaway].join(" "),
      confidence: "medium" as const,
      sourceSpans: verifiedSourceSpans(highlight.sourceSpans),
    })),
    ...extraction.risks.map((risk) => ({
      text: risk.text,
      confidence: risk.severity,
      sourceSpans: verifiedSourceSpans(risk.sourceSpans),
    })),
  ];

  const matchingCandidates = candidates.filter(
    (candidate) =>
      candidate.sourceSpans.length !== 0 &&
      textMatchesWebResearchTask([candidate.text, ...candidate.sourceSpans.map((span) => span.excerpt)].join(" ")),
  );

  if (matchingCandidates.length === 0) {
    return null;
  }

  return coreRuleSignal({
    key: "web_research_task_identified",
    confidence: strongestConfidence(matchingCandidates.map((candidate) => candidate.confidence)),
    sourceSpans: matchingCandidates.flatMap((candidate) => candidate.sourceSpans).slice(0, MAX_INFERENCE_SOURCE_SPANS),
    reasoning:
      "Derived from validated meeting content that asks for web-backed research, extraction, discovery, comparison, or dataset work.",
    ruleId: "web_research_task_from_grounded_notes_v1",
  });
}

export function inferSignalsFromValidatedContent(extraction: SignalInferenceExtraction): SignalPresence[] {
  return [
    inferDecisionsMadeSignal,
    inferActionCommitmentSignal,
    inferEngineeringIssueSignal,
    inferWebResearchTaskSignal,
  ].reduce<{ inferredSignals: SignalPresence[]; currentSignals: SignalPresence[] }>(
    (state, inferSignal) => {
      const signal = inferSignal({
        ...extraction,
        signals: state.currentSignals,
      });
      if (signal === null) {
        return state;
      }

      return {
        inferredSignals: [...state.inferredSignals, signal],
        currentSignals: [...state.currentSignals, signal],
      };
    },
    { inferredSignals: [], currentSignals: extraction.signals },
  ).inferredSignals;
}
