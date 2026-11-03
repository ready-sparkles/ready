import "../composition/env";

import assert from "node:assert/strict";
import test from "node:test";

import { suggestSalesChannel } from "../adapters/secondary/slack/slack-connection";
import {
  permitsSlackSalesChannel,
  type SlackMeetingClassification,
} from "../adapters/secondary/slack/slack-meeting-classifier";

const SLACK_CLASSIFICATION_HIGH_CONFIDENCE = 0.99;
const SLACK_CLASSIFICATION_BELOW_THRESHOLD_CONFIDENCE = 0.97;

const transcript = "Personqo: I sell this product to teams. Personqs: I am evaluating it for our company.";
const classification: SlackMeetingClassification = {
  category: "sales",
  pureSalesCall: true,
  isInternalOneOnOne: false,
  containsSensitiveContent: false,
  sensitiveReason: null,
  salesConfidence: SLACK_CLASSIFICATION_HIGH_CONFIDENCE,
  noSensitiveContentConfidence: SLACK_CLASSIFICATION_HIGH_CONFIDENCE,
  salespersonEvidence: "I sell this product to teams.",
  customerEvidence: "I am evaluating it for our company.",
};
void test("channel eligibility requires both high confidence checks and grounded roles", () => {
  assert.equal(permitsSlackSalesChannel(classification, transcript), true);
  [
    { /** @external slack review fixture */ pureSalesCall: false },
    { /** @external slack review fixture */ containsSensitiveContent: true },
    { salesConfidence: SLACK_CLASSIFICATION_BELOW_THRESHOLD_CONFIDENCE },
    { noSensitiveContentConfidence: SLACK_CLASSIFICATION_BELOW_THRESHOLD_CONFIDENCE },
    { isInternalOneOnOne: true },
    { salespersonEvidence: "Invented sales role" },
    { customerEvidence: "" },
    { category: "customer_support" } satisfies Pick<SlackMeetingClassification, "category">,
  ].forEach((overrides) => {
    assert.equal(permitsSlackSalesChannel({ ...classification, ...overrides }, transcript), false);
  });
});
const channels = [
  { id: "C1", name: "sales-meetings", isPrivate: false },
  { id: "C2", name: "sales-updates", isPrivate: true },
];
void test("sales channel discovery prefers the dedicated meeting channel", () => {
  assert.equal(suggestSalesChannel([...channels].reverse())?.id, "C1");
  assert.equal(suggestSalesChannel([{ id: "C3", name: "engineering", isPrivate: false }]), null);
});
