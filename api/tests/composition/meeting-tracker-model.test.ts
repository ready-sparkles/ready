import { type MeetingTrackerItem } from "@readymeet/shared";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";

import {
  analyzeMeetingTracker,
  type AnalyzeMeetingTrackerOptions,
  applyTrackerChanges,
  selectTrackerContext,
  type TrackerInput,
  type TrackerSegment,
} from "../../application/meeting-tracker-model";

const THREE = 3;
const GATE_WITH_REVIEW_CALLS = 2;
const PRIVATE_REPORTS_DECISION = "Keep reports private after the meeting";
const MAX_EVIDENCE_QUOTES = 8;
const BACKLOG_SEGMENT_LENGTH = 5000;
const BACKLOG_SPACING_MS = 100000;
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const MERGED_PLAN_TEXT = "Send the plan Friday";
const DECISION_QUOTE = "The plan goes out Friday.";
const PLAN_QUOTE = "I will send the plan Friday.";
const OPEN_QUESTION = "Who will send the plan?";
const GATE_THRESHOLD = 0.3;
const LOW_PROBABILITY = 0.01;
const MID_PROBABILITY = 0.5;
const HIGH_PROBABILITY = 0.99;
const OUT_OF_RANGE_PROBABILITY = 3;
const TOO_MANY_REQUESTS = 429;
const PAYLOAD_TOO_LARGE = 413;
const LARGE_SEGMENT_LENGTH = 31_000;
const OUTPUT_TOKENS_PER_ITEM = 320;
const MAX_TRACKER_ITEMS = 200;
const PARTIAL_BULK_COUNT = 51;
const BULK_COUNTS = [PARTIAL_BULK_COUNT, MAX_TRACKER_ITEMS];
const SETTLED_AGREEMENT = "Personaa will send the plan Friday.";
const GATE_AND_EXTRACTION_REQUESTS = 2;
const GATE_URL = "https://api.typesafe.ai/v1/systemone";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const EMPTY_CHANGES_TEXT = '{"changes":[]}';

const input: TrackerInput = {
  transcript: [
    { id: first, speaker: "Personbr", content: OPEN_QUESTION },
    { id: second, speaker: "Personaa", content: PLAN_QUOTE },
  ],
  newSegmentIds: [second],
  items: [],
};
const change = {
  id: null,
  section: "next_step",
  text: "Send the plan",
  status: "active",
  owner: "Personaa",
  due: "Friday",
  evidence: [{ segmentId: second, quote: PLAN_QUOTE }],
};
const testKeys = { typesafeKey: "test", openaiKey: "test", model: "test" };

const openAiInputContentSchema = z.union([z.string(), z.array(z.object({ text: z.string() }))]);

function openAiInputText(content: z.infer<typeof openAiInputContentSchema> | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined) {
    return "";
  }

  return content.map((part) => part.text).join("");
}

const requestBodySchema = z
  .object({
    store: z.boolean().optional(),
    state: z
      .object({ items: z.array(z.unknown()), recentTranscript: z.array(z.unknown()), newSpeech: z.array(z.unknown()) })
      .optional(),
    questions: z.object({ changed: z.object({ instructions: z.string() }) }).optional(),
    input: z.array(z.object({ content: openAiInputContentSchema })).optional(),
    max_output_tokens: z.number().optional(),
    text: z
      .object({
        format: z.object({
          schema: z.object({ properties: z.object({ changes: z.object({ maxItems: z.number() }) }) }),
        }),
      })
      .optional(),
  })
  .passthrough();
const trackerContextSchema = z.object({ items: z.array(z.unknown()), transcript: z.array(z.unknown()) });
type RequestBody = z.infer<typeof requestBodySchema>;

function parseRequestBody(options: RequestInit | undefined): RequestBody {
  const body = typeof options?.body === "string" ? options.body : "";

  return requestBodySchema.parse(JSON.parse(body));
}

function gateResponse(probability: number): Response {
  return new Response(JSON.stringify({ answers: { changed: { type: "noul", noul: probability } } }));
}

function extractionResponse(text: string): Response {
  return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text }] }] }));
}

function createdItem(text: string): MeetingTrackerItem {
  const [created] = applyTrackerChanges({ input, raw: { changes: [{ ...change, text }] } });
  assert.ok(created);

  return created;
}

void test("creates evidence-backed items and updates stable IDs when questions are resolved", () => {
  const [created] = applyTrackerChanges({ input, raw: { changes: [change] } });
  assert.ok(created);
  assert.equal(created.owner, "Personaa");
  const existing: MeetingTrackerItem = {
    ...created,
    id: itemId,
    section: "open_item",
    text: OPEN_QUESTION,
    owner: null,
    due: null,
  };
  const updated = applyTrackerChanges({
    input: { ...input, items: [existing] },
    raw: { changes: [{ ...change, id: itemId, section: "open_item", status: "resolved" }] },
  });
  const [resolved] = updated;
  assert.equal(updated.length, 1);
  assert.ok(resolved);
  assert.equal(resolved.id, itemId);
  assert.equal(resolved.status, "resolved");
});

void test("rejects fabricated evidence, unrelated IDs, duplicate items and changes without new evidence", () => {
  [
    { ...change, evidence: [{ segmentId: second, quote: "By Monday" }] },
    { ...change, id: itemId },
    { ...change, status: "resolved" },
    { ...change, status: "cancelled" },
  ].forEach((invalid) => {
    assert.throws(() => applyTrackerChanges({ input, raw: { changes: [invalid] } }));
  });
  assert.throws(() => applyTrackerChanges({ input, raw: { changes: [change, change] } }), /Duplicate/);
  assert.throws(
    () => applyTrackerChanges({ input, raw: { changes: [{ ...change, section: "invented" }] } }),
    /Invalid/,
  );
  const existing = createdItem("Send the plan");
  assert.throws(
    () =>
      applyTrackerChanges({
        input: { ...input, items: [existing], newSegmentIds: [first] },
        raw: { changes: [{ ...existing, status: "cancelled" }] },
      }),
    /evidence/,
  );
});

void test("a missing outcome can be recovered from the bounded recent window", () => {
  const [recovered] = applyTrackerChanges({ input: { ...input, newSegmentIds: [first] }, raw: { changes: [change] } });
  assert.equal(recovered?.text, change.text);
  assert.throws(
    () =>
      applyTrackerChanges({
        input: { ...input, transcript: input.transcript.slice(0, 1) },
        raw: { changes: [change] },
      }),
    /evidence/,
  );
});

void test("a settled open question moves to agreements under its original ID", () => {
  const openItem: MeetingTrackerItem = {
    ...change,
    id: itemId,
    section: "open_item",
    status: "active",
    text: OPEN_QUESTION,
  };
  const items = applyTrackerChanges({
    input: { ...input, items: [openItem] },
    raw: { changes: [{ ...change, id: itemId, section: "agreement", text: SETTLED_AGREEMENT }] },
  });
  const [settled] = items;
  assert.equal(items.length, 1);
  assert.ok(settled);
  assert.equal(settled.id, itemId);
  assert.equal(settled.section, "agreement");
  assert.equal(
    items.some((item) => item.section === "open_item" && item.status === "active"),
    false,
  );
});

async function assertGateProbability(probability: number): Promise<void> {
  const timings: Record<string, number> = {};
  const requests: { values: RequestBody[] } = { values: [] };
  const items = await analyzeMeetingTracker({
    input,
    options: {
      ...testKeys,
      model: "gpt-6-luna",
      onTiming: ({ stage, ms }) => {
        timings[stage] = ms;
      },
      fetcher: async ({ init: options }) => {
        requests.values = [...requests.values, parseRequestBody(options)];

        return requests.values.length === 1
          ? gateResponse(probability)
          : extractionResponse(JSON.stringify({ changes: [change] }));
      },
    },
  });
  const isExtracted = probability >= GATE_THRESHOLD;
  assert.equal(requests.values.length, isExtracted ? GATE_AND_EXTRACTION_REQUESTS : 1);
  assert.equal(items.length, isExtracted ? 1 : 0);
  assert.ok((timings.jevMs ?? -1) >= 0);
  assert.equal(timings.openaiMs !== undefined, isExtracted);
  if (isExtracted) {
    assert.equal(requests.values[1]?.store, false);
  }
}

void test("negative gate avoids extraction; uncertainty runs one structured extraction", async () => {
  await assertGateProbability(LOW_PROBABILITY);
  await assertGateProbability(MID_PROBABILITY);
  await assertGateProbability(HIGH_PROBABILITY);
});

void test("short evidence references map to bounded transcript IDs and still reject mismatched quotes", async () => {
  const boundedInput = {
    ...input,
    transcript: [
      { id: first, speaker: "Personbr", content: "x".repeat(LARGE_SEGMENT_LENGTH) },
      { id: second, speaker: "Personaa", content: PLAN_QUOTE },
    ],
  };
  const run = (evidence: { segmentId: string; quote: string }) =>
    analyzeMeetingTracker({
      input: boundedInput,
      options: {
        ...testKeys,
        fetcher: async ({ url, init }) => {
          if (url === GATE_URL) {
            return gateResponse(1);
          }
          const context = readTrackerContext({ request: parseRequestBody(init), isGate: false });
          assert.deepEqual(context.transcript, [{ id: "0", speaker: "Personaa", content: PLAN_QUOTE, order: 0 }]);

          return extractionResponse(JSON.stringify({ changes: [{ ...change, evidence: [evidence] }] }));
        },
      },
    });
  const items = await run({ segmentId: "0", quote: PLAN_QUOTE });
  assert.deepEqual(items[0]?.evidence, [{ segmentId: second, quote: PLAN_QUOTE }]);
  await assert.rejects(run({ segmentId: "1", quote: PLAN_QUOTE }), /Invalid meeting tracker output/);
  await assert.rejects(run({ segmentId: "0", quote: OPEN_QUESTION }), /evidence does not match/);
});

void test("provider failures and incomplete output do not produce tracker state", async () => {
  await Promise.all(
    [{}, { answers: { changed: { type: "noul", noul: OUT_OF_RANGE_PROBABILITY } } }].map(async (body) =>
      assert.rejects(
        analyzeMeetingTracker({
          input,
          options: { ...testKeys, fetcher: async () => new Response(JSON.stringify(body)) },
        }),
        /Invalid/,
      ),
    ),
  );
  await assert.rejects(
    analyzeMeetingTracker({
      input,
      options: { ...testKeys, fetcher: async () => new Response("", { status: TOO_MANY_REQUESTS }) },
    }),
    /429/,
  );
});

void test("gate is concise and extraction requires confirmed outcomes", async () => {
  const requests: { values: RequestBody[] } = { values: [] };
  await analyzeMeetingTracker({
    input,
    options: {
      ...testKeys,
      fetcher: async ({ init }) => {
        requests.values = [...requests.values, parseRequestBody(init)];

        return requests.values.length === 1 ? gateResponse(1) : extractionResponse(EMPTY_CHANGES_TEXT);
      },
    },
  });
  const gate = requests.values[0]?.questions?.changed.instructions ?? "";
  const extraction = openAiInputText(requests.values[1]?.input?.[0]?.content);
  assert.ok(gate.length < extraction.length);
  assert.match(gate, /clear uncompleted commitment/);
  assert.match(extraction, /latest 8,000 characters/);
  assert.doesNotMatch(extraction, /needs_context/);
});

function readTrackerContext(input: { request: RequestBody; isGate: boolean }): z.infer<typeof trackerContextSchema> {
  const schema = z.object({
    items: z.array(z.unknown()),
    newSpeech: z.array(z.unknown()),
    recentTranscript: z.array(z.unknown()),
  });
  const context = input.isGate
    ? schema.parse(input.request.state)
    : schema.parse(JSON.parse(openAiInputText(input.request.input?.[1]?.content)));

  return trackerContextSchema.parse({
    items: context.items,
    transcript: [...context.recentTranscript, ...context.newSpeech],
  });
}

async function applyStatusCommand(input: {
  state: TrackerInput;
  original: MeetingTrackerItem;
  segment: TrackerSegment;
  status: MeetingTrackerItem["status"];
}): Promise<TrackerInput> {
  const { original, segment, status } = input;
  const state: TrackerInput = {
    ...input.state,
    transcript: [...input.state.transcript, segment],
    newSegmentIds: [segment.id],
  };
  const calls = { count: 0 };
  const items = await analyzeMeetingTracker({
    input: state,
    options: {
      ...testKeys,
      fetcher: async ({ init: options }) => {
        const context = readTrackerContext({ request: parseRequestBody(options), isGate: calls.count === 0 });
        calls.count += 1;
        assert.deepEqual(
          context.items,
          state.items.map(({ evidence: _evidence, id, ...item }) => (calls.count === 1 ? item : { id, ...item })),
        );
        assert.deepEqual(
          z
            .array(z.object({ content: z.string() }))
            .parse(context.transcript)
            .map((segment) => segment.content),
          state.transcript.map((segment) => segment.content),
        );
        if (calls.count === 1) {
          return gateResponse(HIGH_PROBABILITY);
        }

        return extractionResponse(
          JSON.stringify({
            changes: [
              {
                ...original,
                status,
                evidence: [...original.evidence, { segmentId: segment.id, quote: segment.content }],
              },
            ],
          }),
        );
      },
    },
  });
  const [updatedItem] = items;
  assert.equal(items.length, 1);
  assert.ok(updatedItem);
  assert.equal(updatedItem.status, status);
  assert.deepEqual({ ...updatedItem, status: original.status, evidence: original.evidence }, original);

  return { ...state, items };
}

void test("cleared next steps stay in model context and can be restored under their original IDs", async () => {
  const [original] = applyTrackerChanges({ input, raw: { changes: [change] } });
  assert.ok(original);
  const cleared = await applyStatusCommand({
    state: { ...input, items: [original] },
    original,
    segment: {
      id: "44444444-4444-4444-8444-444444444444",
      speaker: "Personbr",
      content: "Clear all the next steps from this Summary panel.",
    },
    status: "cancelled",
  });
  await applyStatusCommand({
    state: cleared,
    original,
    segment: {
      id: "55555555-5555-4555-8555-555555555555",
      speaker: "Personbr",
      content: "Actually bring back the next steps we had before in this Summary panel.",
    },
    status: "active",
  });
});

void test("Jev context rejection uses only the same bounded transcript", async () => {
  const large: TrackerInput = {
    ...input,
    newSegmentIds: [itemId],
    transcript: [...input.transcript, { id: itemId, speaker: "Personbr", content: "x".repeat(BACKLOG_SEGMENT_LENGTH) }],
  };
  const urls: { values: string[] } = { values: [] };
  await analyzeMeetingTracker({
    input: large,
    options: {
      ...testKeys,
      fetcher: async ({ url }) => {
        urls.values = [...urls.values, url];
        if (urls.values.length === 1) {
          return new Response("{}", { status: PAYLOAD_TOO_LARGE });
        }

        return extractionResponse(EMPTY_CHANGES_TEXT);
      },
    },
  });
  assert.deepEqual(urls.values, [GATE_URL, OPENAI_URL]);
});

function bulkFetcher(input: { count: number; changes: MeetingTrackerItem[] }): AnalyzeMeetingTrackerOptions["fetcher"] {
  const requests = { count: 0 };

  return async ({ init: options }) => {
    requests.count += 1;
    if (requests.count === 1) {
      return gateResponse(1);
    }
    const request = parseRequestBody(options);
    assert.ok((request.max_output_tokens ?? 0) >= input.count * OUTPUT_TOKENS_PER_ITEM);
    assert.equal(request.text?.format.schema.properties.changes.maxItems, MAX_TRACKER_ITEMS);

    return extractionResponse(JSON.stringify({ changes: input.changes }));
  };
}

async function applyBulkStatus(input: {
  count: number;
  transcript: TrackerSegment[];
  items: MeetingTrackerItem[];
  status: "cancelled" | "active";
}): Promise<{ transcript: TrackerSegment[]; items: MeetingTrackerItem[] }> {
  const segment = {
    id: randomUUID(),
    speaker: "Personbr",
    content: input.status === "cancelled" ? "Clear all tasks from this Summary." : "Restore all tasks in this Summary.",
  };
  const changes = input.items.map((item) => ({
    ...item,
    status: input.status,
    evidence: [...item.evidence, { segmentId: segment.id, quote: segment.content }],
  }));
  const transcript = [...input.transcript, segment];
  const items = await analyzeMeetingTracker({
    input: { transcript, newSegmentIds: [segment.id], items: input.items },
    options: { ...testKeys, fetcher: bulkFetcher({ count: input.count, changes }) },
  });
  assert.equal(items.length, input.count);
  assert.deepEqual(
    items.map((item) => item.id),
    input.items.map((item) => item.id),
  );
  assert.ok(items.every((item) => item.status === input.status));

  return { transcript, items };
}

BULK_COUNTS.forEach((count) => {
  void test(`bulk clear and restore updates all ${count} retained tasks`, async () => {
    const items = Array.from({ length: count }, (_, index) => createdItem(`Send proposal ${index}`));
    const cleared = await applyBulkStatus({ count, transcript: input.transcript, items, status: "cancelled" });
    await applyBulkStatus({ count, ...cleared, status: "active" });
  });
});

void test("character window retains recent text regardless of elapsed time", () => {
  const transcript = [
    { id: first, speaker: "Personbr", content: "Old proposal", startedAt: "2026-10-14T10:00:00Z" },
    { id: second, speaker: "Personaa", content: "Yes", startedAt: "2026-10-14T10:10:00Z" },
  ];
  assert.deepEqual(selectTrackerContext({ transcript, items: [], newSegmentIds: [second] }).transcript, transcript);
});

void test("both providers receive at most 8000 characters, without an older-context retry", async () => {
  const maximum = 8000;
  const calls = { count: 0 };
  await analyzeMeetingTracker({
    input: {
      items: [],
      newSegmentIds: [second],
      transcript: [
        { id: first, speaker: "Personbr", content: "x".repeat(LARGE_SEGMENT_LENGTH) },
        { id: second, speaker: "Personaa", content: PLAN_QUOTE },
      ],
    },
    options: {
      ...testKeys,
      model: "gpt-6-luna",
      fetcher: async ({ init }) => {
        calls.count++;
        const body = parseRequestBody(init);
        const context = readTrackerContext({ request: body, isGate: calls.count === 1 });
        const speech = z.array(z.object({ content: z.string() })).parse(context.transcript);
        assert.ok(speech.reduce((total, segment) => total + segment.content.length, 0) <= maximum);
        if (calls.count === 1) {
          return gateResponse(1);
        }
        assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });

        return extractionResponse(EMPTY_CHANGES_TEXT);
      },
    },
  });
  assert.equal(calls.count, GATE_AND_EXTRACTION_REQUESTS);
});

void test("oversized backlog is processed chronologically without future context", async () => {
  const transcript = Array.from({ length: THREE }, (_, i) => ({
    id: randomUUID(),
    speaker: "Personbr",
    content: String(i).repeat(BACKLOG_SEGMENT_LENGTH),
    startedAt: new Date(i * BACKLOG_SPACING_MS),
  }));
  const seen: { values: string[][] } = { values: [] };
  await analyzeMeetingTracker({
    input: { transcript, items: [], newSegmentIds: transcript.map((s) => s.id) },
    options: {
      ...testKeys,
      fetcher: async ({ init }) => {
        const body = z
          .object({
            state: z.object({
              newSpeech: z.array(z.object({ content: z.string() })),
              recentTranscript: z.array(z.object({ content: z.string() })),
            }),
          })
          .parse(JSON.parse(typeof init.body === "string" ? init.body : ""));
        seen.values = [...seen.values, body.state.newSpeech.map((s) => s.content)];
        assert.equal(body.state.newSpeech.at(-1)?.content, transcript[seen.values.length - 1]?.content);

        return gateResponse(0);
      },
    },
  });
  assert.deepEqual(
    seen.values,
    transcript.map((s) => [s.content]),
  );
});

void test("late speech retains later already-processed context", async () => {
  const transcript = [
    { id: first, speaker: "Personbr", content: OPEN_QUESTION, startedAt: "2026-10-14T10:00:00Z" },
    { id: second, speaker: "Personaa", content: PLAN_QUOTE, startedAt: "2026-10-14T10:05:00Z" },
  ];
  await analyzeMeetingTracker({
    input: { transcript, items: [], newSegmentIds: [first] },
    options: {
      ...testKeys,
      fetcher: async ({ url, init }) => {
        const isGate = url === GATE_URL;
        const context = readTrackerContext({ request: parseRequestBody(init), isGate });
        assert.equal(context.transcript.length, transcript.length);
        const speech = z.array(z.object({ content: z.string(), order: z.number() })).parse(context.transcript);
        assert.deepEqual(
          [...speech].sort((a, b) => a.order - b.order).map((segment) => segment.content),
          transcript.map((segment) => segment.content),
        );

        return isGate ? gateResponse(1) : extractionResponse(EMPTY_CHANGES_TEXT);
      },
    },
  });
});

void test("new and edited tasks retain all eight accepted quotes including owner and deadline support", () => {
  const support = Array.from({ length: MAX_EVIDENCE_QUOTES - 1 }, (_, index) => ({
    id: randomUUID(),
    speaker: "Personbr",
    content: `Include part ${index + 1} in the plan.`,
  }));
  const commitment = { id: randomUUID(), speaker: "Personaa", content: PLAN_QUOTE };
  const transcript = [...support, commitment];
  const evidence = transcript.map(({ id, content }) => ({ segmentId: id, quote: content }));
  const original = createdItem("Send the draft");
  [null, original.id].forEach((id) => {
    const [updated] = applyTrackerChanges({
      input: {
        transcript,
        newSegmentIds: transcript.map((segment) => segment.id),
        items: id === null ? [] : [original],
      },
      raw: { changes: [{ ...change, id, evidence }] },
    });
    assert.ok(updated);
    assert.deepEqual(updated.evidence, evidence);
    assert.equal(updated.owner, "Personaa");
    assert.equal(updated.due, "Friday");
  });
});

void test("repeated corrections retain the founding quote and current evidence", () => {
  const rounds = 12;
  const maxEvidence = 8;
  const support = [
    { id: first, speaker: "Personbr", content: "Send the plan." },
    { id: second, speaker: "Personaa", content: "I will own that." },
    { id: itemId, speaker: "Personbr", content: "The deadline is Friday." },
  ];
  const supportedInput = { ...input, transcript: support, newSegmentIds: support.map((segment) => segment.id) };
  const [original] = applyTrackerChanges({
    input: supportedInput,
    raw: {
      changes: [{ ...change, evidence: support.map((segment) => ({ segmentId: segment.id, quote: segment.content })) }],
    },
  });
  assert.ok(original);
  const result = Array.from({ length: rounds }).reduce(
    (state: TrackerInput) => {
      const segment = {
        id: randomUUID(),
        speaker: "Personbr",
        content: "That task is still needed, but change its deadline.",
      };
      const next = { ...state, transcript: [...state.transcript, segment], newSegmentIds: [segment.id] };
      const items = applyTrackerChanges({
        input: next,
        raw: { changes: [{ ...original, evidence: [{ segmentId: segment.id, quote: segment.content }] }] },
      });
      const updated = items[0];
      assert.ok(updated);
      assert.equal(
        support.every((segment) => updated.evidence.some((entry) => entry.segmentId === segment.id)),
        true,
      );
      assert.equal(
        updated.evidence.some((e) => e.segmentId === second),
        true,
      );
      assert.equal(
        updated.evidence.some((e) => e.segmentId === segment.id),
        true,
      );
      assert.ok(updated.evidence.length <= maxEvidence);

      return { ...next, items };
    },
    { ...supportedInput, items: [original] },
  );
  assert.equal(result.items.length, 1);
});

void test("revised owner and deadline evidence survives later status updates", () => {
  const revisedQuote = "Personbr will send it Monday instead.";
  const revised = { id: randomUUID(), speaker: "Personbr", content: revisedQuote };
  const original: MeetingTrackerItem = { ...change, id: itemId, section: "next_step", status: "active" };
  const correctedInput = {
    ...input,
    items: [original],
    transcript: [...input.transcript, revised],
    newSegmentIds: [revised.id],
  };
  const corrected = applyTrackerChanges({
    input: correctedInput,
    raw: {
      changes: [
        { ...original, owner: "Personbr", due: "Monday", evidence: [{ segmentId: revised.id, quote: revisedQuote }] },
      ],
    },
  });
  const rounds = 12;
  Array.from({ length: rounds }).reduce<MeetingTrackerItem[]>((items) => {
    const status = { id: randomUUID(), speaker: "Personbr", content: "Still working on that." };
    const next = applyTrackerChanges({
      input: {
        ...correctedInput,
        items,
        transcript: [...correctedInput.transcript, status],
        newSegmentIds: [status.id],
      },
      raw: { changes: [{ ...items[0], evidence: [{ segmentId: status.id, quote: status.content }] }] },
    });
    const updated = next[0];
    assert.ok(updated);
    assert.equal(
      updated.evidence.some((entry) => entry.segmentId === revised.id),
      true,
    );
    assert.equal(updated.owner, "Personbr");
    assert.equal(updated.due, "Monday");

    return next;
  }, corrected);
});

void test("recent context cap includes only whole finalized segments", () => {
  const transcript = Array.from({ length: THREE }, (_, index) => ({
    id: randomUUID(),
    speaker: "Personbr",
    content: String(index).repeat(BACKLOG_SEGMENT_LENGTH),
    startedAt: "2026-10-14T10:00:00Z",
  }));
  const fresh = transcript.at(-1);
  assert.ok(fresh);
  const selected = selectTrackerContext({ transcript, newSegmentIds: [fresh.id], items: [] });
  const maximum = 8000;
  assert.ok(selected.transcript.reduce((total, segment) => total + segment.content.length, 0) <= maximum);
  assert.deepEqual(selected.transcript, [fresh]);
});

void test("late speech outside the last 8000 characters is not sent to a provider", async () => {
  const maximum = 8000;
  const items = [createdItem("Send the plan")];
  const result = await analyzeMeetingTracker({
    input: {
      items,
      newSegmentIds: [first],
      transcript: [
        { id: first, speaker: "Personbr", content: "An old delayed utterance" },
        { id: second, speaker: "Personbr", content: "x".repeat(maximum) },
      ],
    },
    options: {
      ...testKeys,
      fetcher: async () => {
        assert.fail("Old speech must not expand the bounded window");
      },
    },
  });
  assert.deepEqual(result, items);
});

void test("an oversized finalized segment fails without clipping it or advancing state", async () => {
  await assert.rejects(
    analyzeMeetingTracker({
      input: {
        items: [],
        newSegmentIds: [first],
        transcript: [{ id: first, speaker: "Personbr", content: "x".repeat(LARGE_SEGMENT_LENGTH) }],
      },
      options: {
        ...testKeys,
        fetcher: async () => {
          assert.fail("Oversized segments must not reach providers");
        },
      },
    }),
    /context limit/,
  );
});

void test("covered decisions merge into an evidenced existing task without cancelling either outcome", async () => {
  const task = createdItem("Send the plan");
  const decision: MeetingTrackerItem = {
    ...task,
    id: randomUUID(),
    section: "agreement",
    text: MERGED_PLAN_TEXT,
    owner: null,
    evidence: [{ segmentId: first, quote: DECISION_QUOTE }],
  };
  const gateCalls = { count: 0 };
  const result = await analyzeMeetingTracker({
    input: {
      ...input,
      transcript: [
        { id: first, speaker: "Personbr", content: DECISION_QUOTE },
        { id: second, speaker: "Personaa", content: PLAN_QUOTE },
      ],
      items: [decision, task],
    },
    options: {
      ...testKeys,
      fetcher: async ({ url }) => {
        if (url === GATE_URL) {
          gateCalls.count++;

          return gateCalls.count === 1
            ? gateResponse(1)
            : new Response(JSON.stringify({ answers: { "0": { type: "choice", choice: "supported" } } }));
        }

        return extractionResponse(
          JSON.stringify({
            changes: [{ ...task, text: MERGED_PLAN_TEXT }],
            coveredDecisions: [{ decisionId: decision.id, taskId: task.id }],
          }),
        );
      },
    },
  });
  assert.equal(gateCalls.count, GATE_WITH_REVIEW_CALLS);
  assert.equal(result.length, 1);
  const [merged] = result;
  assert.ok(merged);
  assert.equal(merged.id, task.id);
  assert.equal(merged.status, "active");
  assert.equal(merged.owner, task.owner);
  assert.ok(merged.evidence.some((entry) => entry.segmentId === first));
  assert.ok(merged.evidence.some((entry) => entry.segmentId === second));
  assert.equal(decision.status, "active");
  assert.equal(task.text, "Send the plan");
});

void test("decision merges reject unsupported targets, questions, inactive items and repeated removals", () => {
  const task = createdItem("Send the plan");
  const decision: MeetingTrackerItem = { ...task, id: randomUUID(), section: "agreement", owner: null };
  const pair = { decisionId: decision.id, taskId: task.id };
  const state = { ...input, items: [decision, task] };
  [
    { changes: [], coveredDecisions: [pair] },
    { changes: [task], coveredDecisions: [pair, pair] },
    { changes: [task], coveredDecisions: [{ ...pair, decisionId: randomUUID() }] },
    { changes: [task], coveredDecisions: [{ ...pair, taskId: randomUUID() }] },
    { changes: [{ ...task, status: "resolved" }], coveredDecisions: [pair] },
    { changes: [task, { ...decision, status: "cancelled" }], coveredDecisions: [pair] },
  ].forEach((raw) => {
    assert.throws(() => applyTrackerChanges({ input: state, raw }), /Invalid/);
  });
  [
    { ...decision, section: "open_item" as const },
    { ...decision, status: "cancelled" as const },
  ].forEach((invalid) => {
    assert.throws(
      () =>
        applyTrackerChanges({
          input: { ...state, items: [invalid, task] },
          raw: { changes: [task], coveredDecisions: [pair] },
        }),
      /Invalid/,
    );
  });
  assert.throws(
    () =>
      applyTrackerChanges({
        input: { ...state, newSegmentIds: [first] },
        raw: { changes: [task], coveredDecisions: [pair] },
      }),
    /evidence/,
  );
  const converted = applyTrackerChanges({
    input: { ...input, items: [decision] },
    raw: { changes: [{ ...task, id: decision.id }] },
  });
  assert.equal(converted.length, 1);
  assert.equal(converted[0]?.id, decision.id);
  assert.equal(converted[0].section, "next_step");
});

void test("merging long decisions preserves every task support quote including fresh status evidence", () => {
  const task = createdItem("Send the plan");
  const evidence = Array.from({ length: MAX_EVIDENCE_QUOTES }, (_, index) => ({
    segmentId: randomUUID(),
    quote: `Support ${index}`,
  }));
  const original = { ...task, evidence };
  const decisions: MeetingTrackerItem[] = [0, 1].map(() => ({
    ...task,
    id: randomUUID(),
    section: "agreement",
    owner: null,
    evidence: evidence.map((entry) => ({ ...entry, segmentId: randomUUID() })),
  }));
  const updated = { ...original, evidence: [{ segmentId: second, quote: PLAN_QUOTE }] };
  const state = { ...input, items: [...decisions, original] };
  const beforeMerge = applyTrackerChanges({ input: state, raw: { changes: [updated] } });
  const expected = beforeMerge.find((item) => item.id === task.id);
  assert.ok(expected);
  assert.ok(expected.evidence.some((entry) => entry.segmentId === second));
  const merged = applyTrackerChanges({
    input: state,
    raw: {
      changes: [updated],
      coveredDecisions: decisions.map((decision) => ({ decisionId: decision.id, taskId: task.id })),
    },
  });
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.evidence, expected.evidence);
  assert.equal(original.evidence.length, MAX_EVIDENCE_QUOTES);
});

void test("an accepted follow-up converts its open question into one active task under the same ID", () => {
  const task = createdItem("Send the plan");
  const question: MeetingTrackerItem = { ...task, section: "open_item", text: OPEN_QUESTION, owner: null };
  const result = applyTrackerChanges({
    input: { ...input, items: [question] },
    raw: { changes: [task], coveredDecisions: [] },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, question.id);
  assert.equal(result[0].section, "next_step");
  assert.equal(result[0].status, "active");
  assert.equal(result[0].owner, "Personaa");
  assert.equal(question.section, "open_item");
});

void test("decision cancellation preserves separate decisions unless the bounded review supports the transition", async () => {
  const decision: MeetingTrackerItem = {
    ...createdItem("Allow sharing after the call"),
    section: "agreement",
    owner: null,
  };
  const cancelled = { ...decision, status: "cancelled", evidence: change.evidence };
  const outcomes = ["supported", "different_scope", "unclear"] as const;
  await Promise.all(
    outcomes.map(async (choice) => {
      const requests: { values: string[] } = { values: [] };
      const items = await analyzeMeetingTracker({
        input: { ...input, items: [decision] },
        options: {
          ...testKeys,
          fetcher: async ({ url, init }) => {
            requests.values = [...requests.values, url];
            if (url === OPENAI_URL) {
              return extractionResponse(JSON.stringify({ changes: [cancelled, change] }));
            }
            if (requests.values.length === 1) {
              return gateResponse(1);
            }
            const body = z
              .object({
                state: z.object({
                  recentTranscript: z.array(z.object({ content: z.string() })),
                  newSpeech: z.array(z.object({ content: z.string() })),
                }),
              })
              .parse(JSON.parse(typeof init.body === "string" ? init.body : ""));
            assert.deepEqual(
              [...body.state.recentTranscript, ...body.state.newSpeech].map((segment) => segment.content),
              input.transcript.map((segment) => segment.content),
            );

            return new Response(JSON.stringify({ answers: { "0": { type: "choice", choice } } }));
          },
        },
      });
      assert.deepEqual(requests.values, [GATE_URL, OPENAI_URL, GATE_URL]);
      assert.equal(
        items.find((item) => item.id === decision.id)?.status,
        choice === "supported" ? "cancelled" : "active",
      );
      assert.equal(items.filter((item) => item.section === "next_step").length, 1);
      assert.equal(decision.status, "active");
    }),
  );
});

void test("decision-to-task conversion requires support and missing review answers fail closed", async () => {
  const decision: MeetingTrackerItem = {
    ...createdItem("Allow sharing after the call"),
    section: "agreement",
    owner: null,
  };
  await Promise.all(
    (["supported", "unclear", null] as const).map(async (choice) => {
      const gateCalls = { count: 0 };
      const result = analyzeMeetingTracker({
        input: { ...input, items: [decision] },
        options: {
          ...testKeys,
          fetcher: async ({ url }) => {
            if (url === OPENAI_URL) {
              return extractionResponse(JSON.stringify({ changes: [{ ...change, id: decision.id }] }));
            }
            gateCalls.count++;

            return gateCalls.count === 1
              ? gateResponse(1)
              : new Response(JSON.stringify({ answers: choice === null ? {} : { "0": { type: "choice", choice } } }));
          },
        },
      });
      if (choice === null) {
        await assert.rejects(result, /Invalid meeting tracker gate response/);
      } else if (choice === "supported") {
        const [task] = await result;
        assert.equal(task?.id, decision.id);
        assert.equal(task.section, "next_step");
      } else {
        assert.deepEqual(await result, [decision]);
      }
    }),
  );
});

void test("rejected decision merges preserve the decision and keep only the task's own evidence", async () => {
  const task = createdItem("Send the plan");
  const decision: MeetingTrackerItem = {
    ...task,
    id: randomUUID(),
    section: "agreement",
    text: PRIVATE_REPORTS_DECISION,
    owner: null,
    evidence: [{ segmentId: first, quote: "Reports stay private." }],
  };
  await Promise.all(
    (["different_scope", "unclear", null] as const).map(async (choice) => {
      const gateCalls = { count: 0 };
      const stages: { values: string[] } = { values: [] };
      const result = analyzeMeetingTracker({
        input: { ...input, items: [decision, task] },
        options: {
          ...testKeys,
          onTiming: ({ stage }) => {
            stages.values = [...stages.values, stage];
          },
          fetcher: async ({ url }) => {
            if (url === OPENAI_URL) {
              return extractionResponse(
                JSON.stringify({
                  changes: [{ ...task, text: MERGED_PLAN_TEXT }],
                  coveredDecisions: [{ decisionId: decision.id, taskId: task.id }],
                }),
              );
            }
            gateCalls.count++;
            if (gateCalls.count === 1) {
              return gateResponse(1);
            }
            // The OpenAI timer must finish before the verification request starts.
            assert.deepEqual(stages.values, ["jevMs", "openaiMs"]);

            return new Response(
              JSON.stringify({ answers: choice === null ? {} : { "0": { type: "choice", choice } } }),
            );
          },
        },
      });
      if (choice === null) {
        await assert.rejects(result, /Invalid meeting tracker gate response/);
      } else {
        const items = await result;
        assert.deepEqual(
          items.find((item) => item.id === decision.id),
          decision,
        );
        const updated = items.find((item) => item.id === task.id);
        assert.equal(updated?.text, MERGED_PLAN_TEXT);
        assert.deepEqual(updated.evidence, task.evidence);
      }
      assert.equal(gateCalls.count, GATE_WITH_REVIEW_CALLS);
      assert.deepEqual(stages.values, ["jevMs", "openaiMs", "jevMs"]);
    }),
  );
});
