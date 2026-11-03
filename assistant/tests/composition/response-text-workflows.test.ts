import "../../composition/wire";

import { linearTaskReviewClassificationRequestSchema } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { generateMeetingCoachingFeedbackWithModel } from "../../application/capability-workflow-coaching";
import { planBugReportIssuesWithModel } from "../../application/capability-workflow-issue-planner";
import { classifyLinearTasksWithModel } from "../../application/linear-task-review";
import { assistantEnv } from "../../ports/assistant-env";
import { configureOpenAIClient, type OpenAIModelResponse } from "../../ports/openai-client";
import { mockAssistantUsageMetering } from "../usage-metering-fixture";

const COACHING_RESULT = {
  model: "fixture",
  promptVersion: "fixture",
  feedback: { summary: "Summary", detailFocus: "custom", detailParagraphs: [], followUpPrompts: [] },
};
const PLANNER_RESULT = { candidates: [], skippedCandidates: [], summary: "Summary" };
const LINEAR_RESULT = { candidates: [] };
const INVALID_JSON = "not JSON";
const IGNORED_TEXT = "ignored";

void test("all three workflows retain top-level preference, fallback parsing and empty-text rejection", async (t) => {
  const previous = assistantEnv().AI_GATEWAY_API_KEY;
  const fixture = mockAssistantUsageMetering(t);
  fixture.workflow.context = { requester: { userId: "requester" } };
  const metering = { meetingId: randomUUID(), workflowRunId: randomUUID() };
  fixture.workflow.meetingId = metering.meetingId;
  assistantEnv().AI_GATEWAY_API_KEY = "fixture";
  const state: { response: OpenAIModelResponse } = { response: {} };
  configureOpenAIClient({
    createOpenAIClient: () => ({
      responses: {
        create: async () => ({
          ...state.response,
          totalUsage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        }),
      },
    }),
  });
  const linearInput = linearTaskReviewClassificationRequestSchema.parse({
    meetingId: metering.meetingId,
    availableTeams: [{ id: "team", name: "Engineering", key: "ENG" }],
    tasks: [
      {
        id: randomUUID(),
        title: "Fix API crash",
        description: "The endpoint crashes",
        taskType: "task",
        workKind: "implementation",
        assigneeName: null,
        dueDate: null,
        sourceQuotes: [{ quote: "Fix the endpoint", speaker: null, timestamp: null, segmentId: null }],
      },
    ],
  });
  const workflows = [
    {
      name: "coaching",
      result: COACHING_RESULT,
      run: () => generateMeetingCoachingFeedbackWithModel({ context: {}, metering }),
    },
    {
      name: "planner",
      result: PLANNER_RESULT,
      run: () =>
        planBugReportIssuesWithModel({
          recommendation: { reasoning: "Review bug", payload: {}, signalsMatched: [] },
          evidenceBank: [],
          metering,
        }),
    },
    { name: "linear review", result: LINEAR_RESULT, run: () => classifyLinearTasksWithModel(linearInput) },
  ];
  try {
    await workflows.reduce(async (previousRun, workflow) => {
      await previousRun;
      await t.test(workflow.name, async () => {
        const text = JSON.stringify(workflow.result);
        const paddedText = ` ${text} `;
        state.response = {
          output_text: ` ${text} `,
          output: [{ type: "message", content: [{ type: "output_text", text: INVALID_JSON }] }],
        };
        const topLevel = await workflow.run();
        state.response = {
          output_text: " \n ",
          output: [
            { type: "reasoning" },
            {
              type: "message",
              content: [
                { type: "output_text", text: paddedText },
                { type: "refusal", text: IGNORED_TEXT },
              ],
            },
          ],
        };
        assert.deepEqual(await workflow.run(), topLevel);
        state.response = {};
        await assert.rejects(workflow.run(), /empty|no text/i);
      });
    }, Promise.resolve());
  } finally {
    assistantEnv().AI_GATEWAY_API_KEY = previous;
  }
});
