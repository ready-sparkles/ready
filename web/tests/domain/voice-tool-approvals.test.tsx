import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVoiceToolApprovalCard,
  parseVoiceToolApprovalRpcPayload,
  upsertVoiceToolApprovalCard,
} from "../../domain/voice-tool-approvals";

void test("calendar RPC payload creates a connect card definition", () => {
  const request = parseVoiceToolApprovalRpcPayload(
    JSON.stringify({ tool: "calendar", provider: "google_calendar", meetingId: "meeting-1" }),
  );
  const card = buildVoiceToolApprovalCard(request);

  assert.equal(request.provider, "google_calendar");
  assert.equal(card.kind, "connect");
  assert.equal(card.id, "calendar:google_calendar");
  assert.equal(card.title, "Google Calendar");
  assert.equal(card.actionLabel, "Connect");
});

void test("provider-only calendar RPC payload infers calendar tool", () => {
  const request = parseVoiceToolApprovalRpcPayload(JSON.stringify({ provider: "Outlook" }));
  const card = buildVoiceToolApprovalCard(request);

  assert.equal(request.tool, "calendar");
  assert.equal(request.provider, "outlook_calendar");
  assert.equal(card.title, "Outlook Calendar");
});

void test("calendar tool label can carry the provider", () => {
  const request = parseVoiceToolApprovalRpcPayload(JSON.stringify({ tool: "Google Calendar" }));
  const card = buildVoiceToolApprovalCard(request);

  assert.equal(request.tool, "calendar");
  assert.equal(request.provider, "google_calendar");
  assert.equal(card.title, "Google Calendar");
});

void test("calendar disconnect payload carries disable action", () => {
  const request = parseVoiceToolApprovalRpcPayload(JSON.stringify({ tool: "calendar", action: "disconnect" }));

  assert.equal(request.tool, "calendar");
  assert.equal(request.provider, null);
  assert.equal(request.action, "disable");
});

void test("unsupported tool payload creates request workflow card", () => {
  const request = parseVoiceToolApprovalRpcPayload(JSON.stringify({ tool: "notion" }));
  const card = buildVoiceToolApprovalCard(request);

  assert.equal(card.kind, "request_workflow");
  assert.equal(card.id, "request:notion:default");
  assert.equal(card.actionLabel, "Request workflow");
});

void test("web search skill request normalizes to the built-in tool", () => {
  const request = parseVoiceToolApprovalRpcPayload(JSON.stringify({ tool: "Request web search" }));

  assert.equal(request.tool, "web_search");
});

void test("repeated voice tool requests dedupe cards by id", () => {
  const request = parseVoiceToolApprovalRpcPayload(JSON.stringify({ tool: "calendar", provider: "google" }));
  const card = buildVoiceToolApprovalCard(request);
  const cards = upsertVoiceToolApprovalCard({
    cards: upsertVoiceToolApprovalCard({ cards: [], nextCard: { ...card, status: "idle" } }),
    nextCard: {
      ...card,
      status: "starting",
    },
  });

  assert.equal(cards.length, 1);
  const [firstCard] = cards;
  assert.ok(firstCard);
  assert.equal(firstCard.id, "calendar:google_calendar");
  assert.equal(firstCard.status, "starting");
});
