import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  chunkMemorySegments,
  memoryActionSchema,
  type MemoryCandidate,
  type MemoryExtractionInput,
  memoryExtractionPasses,
  memoryPreferencesSchema,
  validateMemoryCandidates,
  validateMemoryProjection,
} from "../domain/relationship-memory";

const MESSAGE_UNGROUNDED = /Ungrounded/;
const MESSAGE_UNKNOWN_MEMORY_PERSON = /Unknown memory person/;
const MESSAGE_INCOMPLETE_PERSON_SUMMARY = /Incomplete person summary/;
const CHUNK_TEST_SEGMENT_COUNT = 19;
const OVERSIZED_SEGMENT_INDEX = 7;
const OVERSIZED_SEGMENT_CHARS = 600;
const DEFAULT_SEGMENT_CHARS = 70;
const CHUNK_CHAR_LIMIT = 250;
const LONG_MEETING_SEGMENT_COUNT = 5;
const SINGLE_SEGMENT_PASS_LIMIT = 1;
const ACTION_FORGET = "forget";
const ACTION_PIN = "pin";
const ACTION_RESTORE = "restore";
const SUMMARY_TEXT_UNKNOWN = "Unknown";
const STANDING_TEXT_KNOWN = "Known";
const SUMMARY_TEXT_INCOMPLETE = "Personqa planned to fix the table and";

const person = randomUUID(),
  user = randomUUID(),
  segment = randomUUID();
const input: MemoryExtractionInput = {
  meetingId: randomUUID(),
  ownerUserId: randomUUID(),
  title: "Conversation",
  occurredAt: "2026-09-11T12:00:00Z",
  preferences: memoryPreferencesSchema.parse({}),
  people: [{ id: person, userId: user, name: "Personqa" }],
  segments: [
    {
      id: segment,
      speakerUserId: user,
      speakerName: "Personqa",
      content: "Korjaan taulukon, sitten voin tehdä kaavion. I can make a chart after fixing the table.",
      startedAt: "2026-09-11T12:01:00Z",
    },
  ],
};
const candidate: MemoryCandidate = {
  title: "Personqa offered a chart",
  description: "Personqa can make a chart after fixing the table.",
  category: "Partnerships",
  personIds: [person],
  candidateSubjectId: null,
  candidateSubjectKey: null,
  /** @external existing wire contract */
  sensitive: false,
  confidence: "high",
  evidence: [{ segmentId: segment, quote: "sitten voin tehdä kaavion." }],
};
void test("empty extraction is a successful zero-memory result", () =>
  assert.deepEqual(validateMemoryCandidates({ input, candidates: [] }), []));
void test("Finnish verbatim evidence supports English generated text", () =>
  assert.equal(validateMemoryCandidates({ input, candidates: [candidate] }).length, 1));
void test("unknown segments and fabricated quotes reject the extraction", () => {
  [
    [{ segmentId: randomUUID(), quote: "hello" }],
    [{ segmentId: segment, quote: "I have delivered the video." }],
  ].forEach((evidence) => {
    assert.throws(
      () => validateMemoryCandidates({ input, candidates: [{ ...candidate, evidence }] }),
      MESSAGE_UNGROUNDED,
    );
  });
});
void test("mentioned-only people cannot enter a direct-contact timeline", () =>
  assert.throws(
    () => validateMemoryCandidates({ input, candidates: [{ ...candidate, personIds: [randomUUID()] }] }),
    MESSAGE_UNKNOWN_MEMORY_PERSON,
  ));
void test("sensitive information is excluded by default and explicitly enabled", () => {
  assert.deepEqual(
    validateMemoryCandidates({
      input,
      candidates: [{ ...candidate, /** @external existing wire contract */ sensitive: true }],
    }),
    [],
  );
  assert.equal(
    validateMemoryCandidates({
      input: {
        ...input,
        preferences: {
          ...input.preferences,
          /** @external existing wire contract */
          includeSensitive: true,
        },
      },
      candidates: [{ ...candidate, /** @external existing wire contract */ sensitive: true }],
    }).length,
    1,
  );
});
void test("low-confidence memories are withheld and duplicate candidates collapse", () => {
  assert.deepEqual(validateMemoryCandidates({ input, candidates: [{ ...candidate, confidence: "low" }] }), []);
  assert.equal(validateMemoryCandidates({ input, candidates: [candidate, candidate] }).length, 1);
});
void test("chunks retain every segment in order, including oversized and final segments", () => {
  const baseSegment = input.segments[0];
  assert.ok(baseSegment);
  const segments = Array.from({ length: CHUNK_TEST_SEGMENT_COUNT }, (_, index) => ({
    ...baseSegment,
    id: randomUUID(),
    content: "x".repeat(index === OVERSIZED_SEGMENT_INDEX ? OVERSIZED_SEGMENT_CHARS : DEFAULT_SEGMENT_CHARS),
  }));
  const chunks = chunkMemorySegments({ segments, maxChars: CHUNK_CHAR_LIMIT });
  assert.deepEqual(chunks.flat(), segments);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length !== 0));
});
void test("Forget is the only supported memory action", () => {
  const ids = [randomUUID()];
  assert.ok(memoryActionSchema.safeParse({ ids, action: ACTION_FORGET }).success);
  [ACTION_PIN, ACTION_RESTORE].forEach((action) => {
    assert.equal(memoryActionSchema.safeParse({ ids, action }).success, false);
  });
});
void test("summaries cannot cite forgotten, inaccessible or unrelated memories", () => {
  const allowed = randomUUID();
  const projectionInput = {
    meetingId: input.meetingId,
    personId: person,
    name: "Personqa",
    language: "English",
    memories: [{ id: allowed, title: "A", description: "B", occurredAt: input.occurredAt }],
  };
  assert.throws(
    () =>
      validateMemoryProjection({
        input: projectionInput,
        projection: {
          summary: [{ text: SUMMARY_TEXT_UNKNOWN, memoryIds: [randomUUID()] }],
          standing: [],
        },
      }),
    MESSAGE_UNGROUNDED,
  );
  assert.doesNotThrow(() =>
    validateMemoryProjection({
      input: projectionInput,
      projection: {
        summary: [],
        standing: [{ text: STANDING_TEXT_KNOWN, memoryIds: [allowed] }],
      },
    }),
  );
});

void test("incomplete model summary sentences cannot reach the person page", () => {
  const id = randomUUID();
  assert.throws(
    () =>
      validateMemoryProjection({
        input: {
          meetingId: input.meetingId,
          personId: person,
          name: "Personqa",
          language: "English",
          memories: [
            {
              id,
              title: "Demo plan",
              description: "He offered a demo.",
              occurredAt: input.occurredAt,
            },
          ],
        },
        projection: {
          summary: [{ text: SUMMARY_TEXT_INCOMPLETE, memoryIds: [id] }],
          standing: [],
        },
      }),
    MESSAGE_INCOMPLETE_PERSON_SUMMARY,
  );
});

void test("long meetings revisit every earlier chunk with later topic context without dropping segments", () => {
  const baseSegment = input.segments[0];
  assert.ok(baseSegment);
  const segments = Array.from({ length: LONG_MEETING_SEGMENT_COUNT }, (_, index) => ({
    ...baseSegment,
    id: randomUUID(),
    content: `Passage ${index}`,
  }));
  const passes = memoryExtractionPasses({ segments, maxChars: SINGLE_SEGMENT_PASS_LIMIT });
  const firstPassSegmentIds = passes
    .map((pass) => pass[0])
    .filter((segmentRow): segmentRow is NonNullable<(typeof passes)[number][number]> => segmentRow !== undefined)
    .map((segmentRow) => segmentRow.id);
  assert.deepEqual(
    firstPassSegmentIds,
    [...segments, ...segments.slice(0, -1)].map((segmentRow) => segmentRow.id),
  );
  assert.equal(memoryExtractionPasses({ segments: [] }).length, 0);
  const firstSegment = segments[0];
  assert.ok(firstSegment);
  assert.equal(memoryExtractionPasses({ segments: [firstSegment] }).length, 1);
});
