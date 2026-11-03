import "../../../composition/wire";

import { MEETING_TASK_IDENTIFICATION_RULES } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import type { RunExtractionInput } from "../../../application/extraction-orchestrator";
import {
  buildGlobalMeetingTaskVerificationPrompt,
  buildMeetingTaskReconciliationPrompt,
  buildMeetingTasksPrompt,
  buildPersonalListTaskPrompt,
  globalTaskVerificationTimeoutMs,
  type MeetingTasksRunner,
  runMeetingTasks,
} from "../../../application/extraction-tasks";

const OUTPUT_LANGUAGE_CUE = "Selec" + "t the output language";
const TASKS_TEST_DURATION_MS = 1_800_000;
const TASKS_TEST_VERIFICATION_TOKENS_SMALL = 10_000;
const TASKS_TEST_VERIFICATION_TOKENS_LARGE = 250_000;
const TASKS_TEST_VERIFICATION_TOKENS_MAX = 5_000_000;
const TASKS_TEST_VERIFICATION_TIMEOUT_MAX_MS = 240_000;
const TASKS_TEST_RUSSIAN_REPEAT = 450;
const TASKS_TEST_ENGLISH_REPEAT = 500;

function segment(input: {
  id: string;
  content: string;
  speakerName?: string;
  startedAt?: string;
  speakerRole?: RunExtractionInput["transcript"][number]["speakerRole"];
}): RunExtractionInput["transcript"][number] {
  return {
    id: input.id,
    speakerIdentity: input.speakerName ?? "Personbr",
    speakerName: input.speakerName ?? "Personbr",
    speakerRole: input.speakerRole,
    content: input.content,
    startedAt: input.startedAt ?? "2026-04-26T18:00:00.000Z",
    endedAt: null,
  };
}

function extractionInput(segments: RunExtractionInput["transcript"]): RunExtractionInput {
  return {
    meetingId: "11111111-1111-4111-8111-111111111111",
    transcript: segments,
    metadata: {
      title: "Sprint planning",
      participants: [{ name: "Personbr" }, { name: "Personaj" }],
      startedAt: "2026-04-26T18:00:00.000Z",
      durationMs: TASKS_TEST_DURATION_MS,
    },
  };
}

class MockTaskRunner implements MeetingTasksRunner {
  private readonly callState: { entries: Parameters<MeetingTasksRunner["createTasks"]>[0][] } = { entries: [] };

  constructor(private readonly respond: (input: { systemPrompt: string; userMessage: string }) => string) {}

  get calls() {
    return this.callState.entries;
  }

  async createTasks(input: Parameters<MeetingTasksRunner["createTasks"]>[0]) {
    this.callState.entries = [...this.callState.entries, input];

    return this.respond(input);
  }
}

void test("global task verification prompt treats candidates as hints rather than truth", () => {
  const prompt = buildGlobalMeetingTaskVerificationPrompt();

  assert.match(prompt, /preliminary candidates as useful hints, never as truth/i);
  assert.match(prompt, /recover any important explicit commitment the first pass missed/i);
  assert.match(prompt, /entire human transcript/i);
  assert.match(prompt, /exact segmentId printed beside that quote/i);
  assert.match(prompt, /best-supported explicit or inferred owner over null/i);
});

void test("task prompts prefer calibrated contextual owners without assigning recipients", () => {
  const prompt = buildMeetingTasksPrompt();
  const reconciliationPrompt = buildMeetingTaskReconciliationPrompt();

  assert.match(prompt, /Prefer the best-supported likely owner over null/i);
  assert.match(prompt, /strong contextual owner/i);
  assert.match(prompt, /requester, recipient, beneficiary, and downstream actor/i);
  assert.match(prompt, /I need GitHub access, then I can start/i);
  assert.match(prompt, /sourceReason must state whether ownership is explicit or inferred/i);
  assert.match(reconciliationPrompt, /best-supported likely owner over null/i);
  assert.match(reconciliationPrompt, /participant who needs access is not thereby responsible for granting it/i);
});

void test("reconciliation prompt requires the evidence segment ID", () => {
  const prompt = buildMeetingTaskReconciliationPrompt();

  assert.match(prompt, /"segmentId": string \| null/);
  assert.match(prompt, /Copy quote, speaker, timestamp, and segmentId/i);
});

void test("task prompt excludes in-meeting AI assistant requests that were handled immediately", () => {
  const prompt = buildMeetingTasksPrompt();

  assert.match(prompt, /requests addressed to the in-meeting AI assistant for immediate help/i);
  assert.match(prompt, /search the internet/i);
  assert.match(prompt, /assistant attempts or completes the request during the meeting/i);
  assert.match(prompt, /remain unfinished after the meeting/i);
});

void test("global verification timeout scales with input size and stays under the HTTP cap", () => {
  const small = globalTaskVerificationTimeoutMs({ estimatedInputTokens: TASKS_TEST_VERIFICATION_TOKENS_SMALL });
  const large = globalTaskVerificationTimeoutMs({ estimatedInputTokens: TASKS_TEST_VERIFICATION_TOKENS_LARGE });
  assert.ok(large > small, "longer transcripts must get more time");
  assert.equal(
    globalTaskVerificationTimeoutMs({ estimatedInputTokens: TASKS_TEST_VERIFICATION_TOKENS_MAX }),
    TASKS_TEST_VERIFICATION_TIMEOUT_MAX_MS,
  );
});

void test("the meeting tasks prompt shape block is balanced JSON-like text", () => {
  const prompt = buildMeetingTasksPrompt();
  const shape = prompt.slice(prompt.indexOf("Shape:"), prompt.indexOf("Task rules:"));
  const opens = (shape.match(/{/g) ?? []).length;
  const closes = (shape.match(/}/g) ?? []).length;
  assert.equal(opens, closes, "Shape block must close every brace it opens");
});

void test("task prompts ask for transcript-language compact follow-through", () => {
  assert.ok(buildMeetingTasksPrompt().includes(MEETING_TASK_IDENTIFICATION_RULES));
  const extractionPrompt = buildMeetingTasksPrompt();
  const reconciliationPrompt = buildMeetingTaskReconciliationPrompt();
  const personalListPrompt = buildPersonalListTaskPrompt();

  assert.match(extractionPrompt, /Infer the majority language from the entire human transcript/i);
  assert.match(extractionPrompt, /not the opening lines or the first coherent utterances/i);
  assert.match(extractionPrompt, /only when it has a clear majority/i);
  assert.match(extractionPrompt, /If there is no clear majority language.+in English/i);
  assert.match(extractionPrompt, /Never let a short cluster at the beginning outweigh/i);
  assert.match(extractionPrompt, /Full-meeting language context.+authoritative whole-transcript view/i);
  assert.match(extractionPrompt, /write all user-facing fields in that language/i);
  assert.match(extractionPrompt, /Preserve sourceQuotes exactly as written/i);
  assert.match(extractionPrompt, /usually 3 to 7 tasks/i);
  assert.match(extractionPrompt, /return no more than 7 tasks/i);
  assert.match(extractionPrompt, /Do not translate the tasks into another language/i);
  assert.match(extractionPrompt, /predominantly English.*must be English/i);
  assert.match(extractionPrompt, /Prioritize explicit closing commitments/i);
  assert.match(extractionPrompt, /Combine related follow-ups into one task/i);
  assert.match(extractionPrompt, /assistant-authored transcript segments/i);
  assert.match(extractionPrompt, /actual commitment, assignment, or agreement to follow up/i);
  assert.doesNotMatch(extractionPrompt, /personal-list block/i);
  assert.match(extractionPrompt, /copy that person's exact name and email from Known participants/i);
  assert.match(extractionPrompt, /product, roadmap, planning, or sprint meeting does not lower the evidence bar/i);
  assert.match(extractionPrompt, /explicitly promote them into current work/i);
  assert.match(extractionPrompt, /do not invent an "add to backlog" task/i);
  assert.match(extractionPrompt, /speaker label.*is not enough by itself/i);
  assert.match(extractionPrompt, /Offering contact details.*does not make the speaker the owner/i);
  assert.match(extractionPrompt, /nearby launch, meeting, customer-arrival, or other event date is context/i);

  assert.match(reconciliationPrompt, /merging related fragments, and reordering by post-meeting importance/i);
  assert.match(reconciliationPrompt, /Audit every candidate in two passes/i);
  assert.match(reconciliationPrompt, /exact promotion evidence/i);
  assert.match(reconciliationPrompt, /Merge by outcome rather than by title wording/i);
  assert.match(reconciliationPrompt, /Put the primary follow-through first/i);
  assert.match(reconciliationPrompt, /final quarter of the meeting/i);
  assert.match(reconciliationPrompt, /usually 3 to 7 tasks/i);
  assert.match(reconciliationPrompt, /return no more than 7 tasks/i);
  assert.match(reconciliationPrompt, /Do not translate the tasks into another language/i);
  assert.match(reconciliationPrompt, new RegExp(`${OUTPUT_LANGUAGE_CUE} from fullTranscriptLanguageContext`, "i"));
  assert.match(reconciliationPrompt, /If there is no clear majority.+in English/i);
  assert.match(reconciliationPrompt, /Never use its sampled text to create, merge, expand, prioritize/i);
  assert.match(reconciliationPrompt, /Do not merge unrelated commitments from different owners/i);
  assert.match(
    reconciliationPrompt,
    /product, roadmap, planning, or sprint meeting does not turn every product idea into a task/i,
  );
  assert.match(
    reconciliationPrompt,
    /review an existing bug list does not prove a commitment to create the list or fix every bug/i,
  );
  assert.match(reconciliationPrompt, /ownership evidence must cover the whole merged outcome/i);
  assert.match(reconciliationPrompt, /participant name, speaker label.*is not enough by itself/i);
  assert.doesNotMatch(reconciliationPrompt, /personal-list candidate/i);

  assert.match(personalListPrompt, /Personal-list mode/i);
  assert.match(personalListPrompt, /return every distinct actionable list item/i);
  assert.match(personalListPrompt, /general 3-to-7 target and seven-task maximum do not apply/i);
  assert.match(personalListPrompt, /include the exact list-introduction quote and the exact item quote/i);
  assert.match(personalListPrompt, /Assign each item to the participant who identifies the list as their own/i);
});

void test("task prompts treat participant organization domains as spelling authority", () => {
  assert.match(
    buildMeetingTasksPrompt(),
    /Participant organization domains, when provided, are the authoritative spelling/i,
  );
});

void test("task prompt asks for completion evidence for work finished during the meeting", () => {
  const prompt = buildMeetingTasksPrompt();

  assert.match(prompt, /completion\.completedDuringMeeting/);
  assert.match(prompt, /finished during the meeting itself/i);
  assert.match(prompt, /exact transcript quote that shows the completion/i);
  assert.match(prompt, /Still include the task when it was completed during the meeting/i);
});

void test("task extraction can return no tasks for in-meeting assistant requests", async () => {
  const runner = new MockTaskRunner(({ systemPrompt, userMessage }) => {
    assert.match(systemPrompt, /requests addressed to the in-meeting AI assistant for immediate help/i);
    assert.match(userMessage, /ReadyMeet Assistant, search the internet for the latest pricing/i);
    assert.doesNotMatch(userMessage, /I found the current pricing page/i);

    return JSON.stringify({ items: [] });
  });

  const result = await runMeetingTasks({
    input: extractionInput([
      segment({
        id: "11111111-1111-4111-8111-111111111105",
        speakerName: "Personbr",
        content: "ReadyMeet Assistant, search the internet for the latest pricing.",
      }),
      segment({
        id: "11111111-1111-4111-8111-111111111106",
        speakerName: "ReadyMeet Assistant",
        content: "I found the current pricing page and the starter plan is listed at $19 per seat.",
      }),
    ]),
    runner,
    model: "test-model",
  });

  assert.equal(result.items.length, 0);
});

void test("task extraction fails with a controlled error when all candidates are unusable", async () => {
  const runner = new MockTaskRunner(() =>
    JSON.stringify({
      items: [
        {
          title: "",
          sourceQuotes: [],
        },
      ],
    }),
  );

  await assert.rejects(
    () =>
      runMeetingTasks({
        input: extractionInput([
          segment({
            id: "11111111-1111-4111-8111-111111111104",
            content: "Nothing specific happened.",
          }),
        ]),
        runner,
        model: "test-model",
      }),
    /could not be parsed into supported task candidates/,
  );
});

void test("every long-meeting chunk receives whole-transcript language context", async () => {
  const russianOpening = "Да, я хочу сходить на вечеринку. ".repeat(TASKS_TEST_RUSSIAN_REPEAT);
  const englishMiddle = "The meeting continues in English with ordinary planning context. ".repeat(
    TASKS_TEST_ENGLISH_REPEAT,
  );
  const englishClosing = "English closing marker confirms the language used by the rest of the meeting.";
  const runner = new MockTaskRunner(({ systemPrompt, userMessage }) => {
    assert.match(systemPrompt, new RegExp(`${OUTPUT_LANGUAGE_CUE} from the Full-meeting language context`, "i"));
    assert.match(userMessage, /Whole-transcript script-letter counts: Latin=\d+, Cyrillic=\d+/);
    assert.match(userMessage, /English closing marker/);

    return JSON.stringify({ items: [] });
  });

  const result = await runMeetingTasks({
    input: extractionInput([
      segment({
        id: "11111111-1111-4111-8111-111111111601",
        content: russianOpening,
        startedAt: "2026-04-26T18:00:00.000Z",
      }),
      segment({
        id: "11111111-1111-4111-8111-111111111602",
        content: englishMiddle,
        startedAt: "2026-04-26T18:10:00.000Z",
      }),
      segment({
        id: "11111111-1111-4111-8111-111111111603",
        content: englishClosing,
        startedAt: "2026-04-26T18:20:00.000Z",
      }),
    ]),
    runner,
    model: "test-model",
  });

  assert.equal(result.items.length, 0);
  assert.ok(runner.calls.length > 1);
});
