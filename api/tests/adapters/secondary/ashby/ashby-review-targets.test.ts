import type { AshbyProposal } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { createAshbyClient } from "../../../../adapters/secondary/ashby/ashby-client";
import {
  isReviewStage,
  resolveAshbyItem,
  validateAshbyWriteTarget,
} from "../../../../adapters/secondary/ashby/ashby-review-targets";

const proposal: AshbyProposal = {
  kind: "stage",
  candidateName: "Personqj Personqm",
  candidateEmail: null,
  jobTitle: null,

  stageName: "Technical Interview",
  evidence: [{ segmentId: "11111111-1111-4111-8111-111111111111", quote: "Move Personqj forward." }],
};

const ASHBY_TEST_MESSAGES = {
  lostResponse: "lost response",
} as const;

const NON_REVIEW_STAGE_TYPES = ["Offer", "Archived", "Hired", "FutureType"] as const;
const DUPLICATE_CANDIDATE_COUNT = 2;

function client(options: { candidates?: unknown[]; currentStage?: string; status?: string } = {}) {
  return createAshbyClient("test", {
    fetch: async (url) => {
      const urlText =
        typeof url === "string" ? url : url instanceof URL ? url.href : url instanceof Request ? url.url : "";
      const endpoint = urlText.split("/").at(-1);
      const candidate = { id: "candidate", name: "Personqj Personqm", applicationIds: ["app"] };
      const results =
        endpoint === "candidate.search"
          ? (options.candidates ?? [candidate])
          : endpoint === "candidate.info"
            ? candidate
            : endpoint === "application.info"
              ? {
                  id: "app",
                  candidate: { id: "candidate" },
                  status: options.status ?? "Active",
                  job: { title: "Designer" },
                  currentInterviewStage: {
                    id: options.currentStage ?? "screen",
                    title: "Screen",
                    interviewPlanId: "plan",
                  },
                }
              : [
                  {
                    id: "tech",
                    title: "Technical Interview",
                    type: "Active",
                    interviewPlanId: "plan",
                  },
                  { id: "hire", title: "Hired", type: "Hired", interviewPlanId: "plan" },
                ];

      return Response.json({
        /** @external Ashby API success flag */
        success: true,
        results,
      });
    },
  });
}
void test("resolves exact candidate, application, and real nonterminal stage", async () => {
  const item = await resolveAshbyItem(client(), proposal);
  assert.equal(item.candidateId, "candidate");
  assert.equal(item.applicationId, "app");
  assert.equal(item.stageId, "tech");
  assert.deepEqual(item.stages, [{ id: "tech", name: "Technical Interview" }]);
  await validateAshbyWriteTarget(client(), item);
  await assert.rejects(validateAshbyWriteTarget(client({ currentStage: "other" }), item), /stage changed/);
  await assert.rejects(validateAshbyWriteTarget(client({ status: "Archived" }), item), /no longer active/);
});
void test("first names and duplicate identities require an explicit choice", async () => {
  assert.equal((await resolveAshbyItem(client(), { ...proposal, candidateName: "Personqj" })).candidateId, null);
  const candidates = [
    { id: "one", name: "Personqj Personqm" },
    { id: "two", name: "Personqj Personqm" },
  ];
  const item = await resolveAshbyItem(client({ candidates }), {
    ...proposal,
  });
  assert.equal(item.candidateId, null);
  assert.equal(item.candidates.length, DUPLICATE_CANDIDATE_COUNT);
  const chosen = await resolveAshbyItem(client({ candidates }), item.proposal, {
    candidateId: "two",
    applicationId: "stale",
    stageId: "stale",
  });
  assert.equal(chosen.candidateId, "two");
  assert.equal(chosen.applicationId, null);
  assert.equal(chosen.stageId, null);
});
void test("offers, terminal stages, and unknown stage types fail closed", () => {
  NON_REVIEW_STAGE_TYPES.forEach((type) => {
    assert.equal(isReviewStage({ type, title: "Stage" }), false);
  });
  assert.equal(isReviewStage({ type: "Active", title: "Offer discussion" }), false);
});
void test("a non-idempotent write is attempted only once on lost response", async () => {
  const callState = { count: 0 };
  const c = createAshbyClient("test", {
    fetch: async () => {
      callState.count += 1;
      throw new Error(ASHBY_TEST_MESSAGES.lostResponse);
    },
    sleep: async () => {},
  });
  await assert.rejects(c.write("application.changeStage", { applicationId: "application", interviewStageId: "stage" }));
  assert.equal(callState.count, 1);
});

void test("a malformed successful response is uncertain, never a definite rejection", async () => {
  const callState = { count: 0 };
  const c = createAshbyClient("test", {
    fetch: async () => {
      callState.count += 1;

      return Response.json({});
    },
  });
  await assert.rejects(
    c.write("application.changeStage", {}),
    (error) => error instanceof Error && "kind" in error && error.kind === "server",
  );
  assert.equal(callState.count, 1);
});

void test("an old email cannot silently override a corrected candidate name", async () => {
  const item = await resolveAshbyItem(
    client({
      candidates: [{ id: "old", name: "Personqj Personqm", primaryEmailAddress: { value: "personqj@example.test" } }],
    }),
    { ...proposal, candidateName: "Personqp Personqq", candidateEmail: "personqj@example.test" },
  );
  assert.equal(item.candidateId, null);
});
