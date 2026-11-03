import assert from "node:assert/strict";
import test from "node:test";

import { signalRegistry } from "../domain/capability-catalog";

void test("signal registry descriptions keep trigger and anti-example guidance for tightened signals", () => {
  const productDescription = signalRegistry.product_or_feature_discussion.description;
  const externalDescription = signalRegistry.external_participants_present.description;
  const followUpDescription = signalRegistry.follow_up_meeting_referenced.description;
  const crmDescription = signalRegistry.crm_relevant_context.description;
  const researchDescription = signalRegistry.research_question_identified.description;
  const webResearchDescription = signalRegistry.web_research_task_identified.description;
  const decisionsDescription = signalRegistry.decisions_made.description;
  const openQuestionsDescription = signalRegistry.open_questions_remain.description;

  assert.match(productDescription, /Triggers:/);
  assert.match(productDescription, /Does NOT trigger:/);
  assert.match(productDescription, /recruiter or salesperson describing the company product/i);

  assert.match(externalDescription, /Triggers:/);
  assert.match(externalDescription, /Does NOT trigger:/);
  assert.match(
    externalDescription,
    /recruiting and interview conversations always include at least one external participant/i,
  );

  assert.match(followUpDescription, /Triggers:/);
  assert.match(followUpDescription, /Does NOT trigger:/);
  assert.match(followUpDescription, /hiring manager next week/i);

  assert.match(crmDescription, /Triggers:/);
  assert.match(crmDescription, /Does NOT trigger:/);
  assert.match(crmDescription, /specific prospect/i);
  assert.match(crmDescription, /general discussion of go-to-market strategy/i);

  assert.match(researchDescription, /Triggers:/);
  assert.match(researchDescription, /Does NOT trigger:/);
  assert.match(researchDescription, /interviewer inviting questions/i);
  assert.match(researchDescription, /role-exploration prompts/i);

  assert.match(webResearchDescription, /Triggers:/);
  assert.match(webResearchDescription, /Does NOT trigger:/);
  assert.match(webResearchDescription, /Search, Extract, FindAll/i);

  assert.match(decisionsDescription, /Triggers:/);
  assert.match(decisionsDescription, /Does NOT trigger:/);
  assert.match(decisionsDescription, /move you to the next round/i);

  assert.match(openQuestionsDescription, /Triggers:/);
  assert.match(openQuestionsDescription, /Does NOT trigger:/);
  assert.match(openQuestionsDescription, /process steps, or interview logistics/i);
});
