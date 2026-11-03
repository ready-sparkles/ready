import type { CapabilitySelectionCapability, MeetingExtraction, MeetingTaskList } from "@readymeet/shared";

import type { RankedCapability } from "./ranking";

const JSON_INDENT_SPACES = 2;

export const SELECTION_PROMPT_VERSION = "1.0.4";

export function buildSelectionSystemPrompt(): string {
  return `You generate meeting-specific reasoning and pre-filled payloads for capabilities that deterministic code already selected.

Non-negotiable boundaries:
- Do not add capabilities.
- Do not remove capabilities.
- Do not reorder capabilities.
- Do not decide whether a capability applies. That already happened deterministically.
- Your job is only to call one payload tool per selected capability.

Reasoning and payload requirements:
- Reasoning must be one sentence and must reference actual decisions, open questions, highlights, signals, or key topics from the extraction.
- Generic reasoning such as "This capability is useful for this meeting" is not acceptable.
- Payloads must be grounded in the extraction artifact.
- Native Ready Tasks are pre-validated meeting work. Use them as supporting context for payloads, but do not treat generic tasks as proof that a specialized capability should do external work.
- Do not invent transcript details, owners, dates, accounts, commitments, or open questions.
- If the extraction is weak, sparse, partial, or ambiguous, use low confidence.
- For file_issue_or_bug, identify every distinct bug or engineering defect that is explicitly supported by the extraction. Populate issues with one item per bug. Do not collapse unrelated bugs into one umbrella issue just because they came from the same meeting.
- For file_issue_or_bug, if there are multiple issues, the top-level description and reproduction_context should also use numbered per-bug sections so older workflow readers can still recover separate drafts.
- For research_open_question, treat the user-facing capability as Deep Research. Create a standalone query that can be executed by web Search, Extract, FindAll, and synthesis without rereading the meeting.
- For research_open_question, prefer concrete research tasks: comparing companies, finding entities, extracting from mentioned URLs or PDFs, building a dataset, validating current facts, or answering a question that needs public sources.
- For research_open_question, action_label must describe the visible action, such as "Deep research on relevant AI note-taking companies". Do not use vague labels like "Research the question".
- For research_open_question, include seed_urls only when URLs, PDFs, pages, or domains were actually mentioned. Do not invent sources.
- Call payload tools in the selected ranking order.`;
}

export function buildSelectionUserMessage(input: {
  title?: string | null;
  extraction: MeetingExtraction;
  selected: RankedCapability[];
  tasks?: MeetingTaskList | null;
  connectedIntegrations?: string[];
}): string {
  return JSON.stringify(
    {
      meeting: {
        title: input.title ?? null,
        type: input.extraction.meetingType,
        participants: input.extraction.participants,
        summary: {
          short: input.extraction.summaryShort,
          bullets: input.extraction.summaryBullets,
        },
        highlights: input.extraction.highlights,
        decisions: input.extraction.decisions,
        actionItems: input.extraction.actionItems,
        openQuestions: input.extraction.openQuestions,
        risks: input.extraction.risks,
        keyTopics: input.extraction.keyTopics,
        signals: input.extraction.signals.map((signal) => ({
          key: signal.key,
          confidence: signal.confidence,
          reasoning: signal.reasoning,
        })),
      },
      nativeTasks: input.tasks
        ? {
            status: input.tasks.status,
            items: input.tasks.items.map((task) => ({
              title: task.title,
              description: task.description,
              type: task.type,
              workKind: task.workKind,
              status: task.status,
              owner: task.owner,
              dueDate: task.dueDate,
              confidence: task.confidence,
              sourceReason: task.sourceReason,
              sourceQuotes: task.sourceQuotes,
            })),
          }
        : null,
      connectedIntegrations: input.connectedIntegrations ?? [],
      selectedCapabilities: input.selected.map((selection, index) => ({
        rank: index + 1,
        capability: summarizeCapability(selection.capability),
        ranking: {
          rawScore: selection.rawScore,
          finalScore: selection.finalScore,
          matchedSignals: selection.signalsMatched,
          missingSignals: selection.signalsMissing,
          exclusionSignalsChecked: selection.exclusionSignalsChecked,
        },
      })),
    },
    null,
    JSON_INDENT_SPACES,
  );
}

function summarizeCapability(capability: CapabilitySelectionCapability) {
  return {
    key: capability.key,
    name: capability.name,
    description: capability.description,
    category: capability.category,
    requiredSignals: capability.requiredSignals,
    exclusionSignals: capability.exclusionSignals,
  };
}
