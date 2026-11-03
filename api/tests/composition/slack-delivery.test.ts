import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import * as slackDeliveryTestInternals from "../../adapters/secondary/slack/slack-message";

const LONG_SUMMARY_SENTENCE_REPEAT_COUNT = 400;
const MANY_TASK_COUNT = 12;

const slackMessageBlockSchema = z.object({
  type: z.string(),
  text: z.object({ text: z.string().optional() }).optional(),
  elements: z.array(z.object({ text: z.string().optional() })).optional(),
});

void test("Slack mrkdwn conversion handles headings, bold, and bullets", () => {
  assert.equal(
    slackDeliveryTestInternals.toSlackMrkdwn("# Summary\n**Decision:** ship it\n- Follow up"),
    "*Summary*\n*Decision:* ship it\n• Follow up",
  );
});

void test("Slack message blocks include summary, tasks, and category context", () => {
  const blocks = z.array(slackMessageBlockSchema).parse(
    slackDeliveryTestInternals.buildMessageBlocks({
      title: "Customer demo",
      categoryKey: "sales",
      summaryContent: "# Notes\nGreat call",
      tasks: [{ title: "Send proposal", assigneeName: "Personaz" }],
    }),
  );

  assert.equal(blocks[0]?.type, "header");
  assert.match(blocks[1]?.text?.text ?? "", /\*Notes\*/);
  assert.match(blocks[2]?.text?.text ?? "", /Send proposal/);
  assert.match(blocks[2]?.text?.text ?? "", /Personaz/);
  assert.match(blocks[3]?.elements?.[0]?.text ?? "", /Sales/);
});

void test("Slack client message id is deterministic and UUID-shaped", () => {
  const first = slackDeliveryTestInternals.createDeterministicSlackClientMsgId({
    meetingId: "11111111-1111-4111-8111-111111111111",
    channelId: "C123",
  });
  const second = slackDeliveryTestInternals.createDeterministicSlackClientMsgId({
    meetingId: "11111111-1111-4111-8111-111111111111",
    channelId: "C123",
  });
  const differentChannel = slackDeliveryTestInternals.createDeterministicSlackClientMsgId({
    meetingId: "11111111-1111-4111-8111-111111111111",
    channelId: "C456",
  });

  assert.equal(first, second);
  assert.notEqual(first, differentChannel);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

void test("long summaries and all tasks are retained, and Slack mentions are escaped", () => {
  const blocks = slackDeliveryTestInternals.buildMessageBlocks({
    title: "Notes",
    categoryKey: "sales",
    summaryContent: `${"A long sentence. ".repeat(LONG_SUMMARY_SENTENCE_REPEAT_COUNT)}Final decision <!channel>`,
    tasks: Array.from({ length: MANY_TASK_COUNT }, (_, index) => ({ title: `Task ${index + 1}`, assigneeName: null })),
  });
  const output = JSON.stringify(blocks);
  assert.match(output, /Final decision &lt;!channel&gt;/);
  assert.match(output, /Task 12/);
});
