import {
  memoryCandidateSchema,
  memoryFactIdentitySchema,
  type MemoryGenerationInput,
  MemoryGenerationRejected,
  memoryGenerationSchema,
  memoryImportanceSchema,
  memoryNewReferenceSchema,
  rejectMemoryValidation,
  validateMemoryGeneration,
} from "@readymeet/shared";
import { z } from "zod";

import { MEMORY_EXTRACTION_PROMPT, MEMORY_PERSON_PROMPT, type MemoryModelRunner } from "./relationship-memory";

const MEMORY_GENERATION_PROMPT = `${MEMORY_EXTRACTION_PROMPT}
SINGLE COMPLETE MEETING: All transcript segments are supplied together in chronological order. Read the whole conversation once. Connect related passages anywhere in the meeting, including a request at the beginning and an answer or correction at the end. There are no chunks, revisits, previousMemories or later reconciliation calls.
The compact segment fields are id (evidence reference), at (original timestamp), text (verbatim speech), speaker (You means the owner), and personId (a direct contact when identified). If a supporting segment contains sensitive personal information, mark the memory sensitive; when includeSensitive is false omit it, because the server retains that entire segment as evidence.
Return memories with unique response-local refs N1, N2, etc. Return one people entry for EVERY supplied direct contact, even if its summary and standing are empty. In this same response, update each person's relationship summary and current standing from the new memories AND their supplied historical memories. Do not return old memories as newly extracted ones. Historical memory refs are H1, H2, etc.; newly extracted refs are N1, N2, etc. Cite these in memoryRefs. Each assertion must be supported by memories belonging to that person. Never cite a discarded, suppressed, sensitive-excluded or low-confidence candidate. Empty new memories is a valid result.
Saved memories may be newer than this meeting when a guest links their account later. Resolve developments by occurredAt, not by which information was supplied last. Do not roll a relationship back to an older state.
${MEMORY_PERSON_PROMPT.replaceAll("memoryIds", "memoryRefs")}`;

const MEMORY_SENTENCE_MAX_LENGTH = 1_200;
const MEMORY_EXISTING_FACT_KEY_MAX_LENGTH = 160;
const MEMORY_PERSON_SUMMARY_MAX_ITEMS = 3;
const MEMORY_STANDING_MAX_ITEMS = 5;
const MEMORY_STANDING_TEXT_MAX_LENGTH = 500;
const MESSAGE_UNKNOWN_TRANSCRIPT_REFERENCE = "Unknown transcript reference";
const CODE_INVALID_SEGMENT_REFERENCE = "invalid_segment_reference";
const STAGE_EVIDENCE = "evidence";
const EMPTY_MODEL_LABEL = "empty";
const SEGMENT_ID_PATTERN = /^S[1-9]\d*$/;
const MEMORY_REF_PATTERN = /\s*\[(?:H|N)\d+(?:,?\s*(?:H|N)?\d+)*\]/g;

type MemoryGenerationResult = {
  value: z.infer<typeof memoryGenerationSchema>;
  model: string;
};

const MEMORY_GENERATION_NO_PEOPLE_MESSAGE = "Memory generation requires at least one person";

function buildPersonIdTuple(people: MemoryGenerationInput["people"]): [string, ...string[]] {
  const [firstPerson, ...remainingPeople] = people;
  if (firstPerson === undefined) {
    throw new Error(MEMORY_GENERATION_NO_PEOPLE_MESSAGE);
  }

  return [firstPerson.id, ...remainingPeople.map((person) => person.id)];
}

function buildMemoryGenerationSchema(input: {
  generationInput: MemoryGenerationInput;
  personIds: [string, ...string[]];
}) {
  const { generationInput, personIds } = input;
  const sentence = z.object({
    text: z.string().min(1).max(MEMORY_SENTENCE_MAX_LENGTH),
    memoryRefs: z.array(z.string().regex(/^[HN][1-9]\d*$/)).min(1),
  });

  return z.object({
    memories: z.array(
      memoryCandidateSchema
        .omit({
          /** @external zod omit spec */
          evidence: true,
          /** @external zod omit spec */
          personIds: true,
          /** @external zod omit spec */
          candidateSubjectId: true,
        })
        .extend({
          ref: memoryNewReferenceSchema,
          factIdentity: memoryFactIdentitySchema,
          importance: memoryImportanceSchema,
          existingFactKey:
            generationInput.knownFacts !== undefined && generationInput.knownFacts.length !== 0
              ? z.string().min(1).max(MEMORY_EXISTING_FACT_KEY_MAX_LENGTH).nullable()
              : z.null(),
          personIds: z.array(z.enum(personIds)).min(1),
          candidateSubjectId: z.enum(personIds).nullable(),
          evidence: z.array(z.object({ segmentId: z.string().regex(SEGMENT_ID_PATTERN) })).min(1),
        }),
    ),
    people: z
      .array(
        z.object({
          personId: z.enum(personIds),
          summary: z.array(sentence).max(MEMORY_PERSON_SUMMARY_MAX_ITEMS),
          standing: z
            .array(sentence.extend({ text: z.string().max(MEMORY_STANDING_TEXT_MAX_LENGTH).min(1) }))
            .max(MEMORY_STANDING_MAX_ITEMS),
        }),
      )
      .length(generationInput.people.length),
  });
}

function mapGeneratedEvidence(input: {
  evidence: { segmentId: string }[];
  segments: MemoryGenerationInput["segments"];
}) {
  return input.evidence.map((entry) => {
    if (!SEGMENT_ID_PATTERN.test(entry.segmentId)) {
      throw new MemoryGenerationRejected(MESSAGE_UNKNOWN_TRANSCRIPT_REFERENCE, {
        code: CODE_INVALID_SEGMENT_REFERENCE,
        stage: STAGE_EVIDENCE,
      });
    }
    const segmentIndex = Number(entry.segmentId.slice(1)) - 1;
    const segment = input.segments[segmentIndex];
    if (segment === undefined) {
      throw new MemoryGenerationRejected(MESSAGE_UNKNOWN_TRANSCRIPT_REFERENCE, {
        code: CODE_INVALID_SEGMENT_REFERENCE,
        stage: STAGE_EVIDENCE,
      });
    }

    return { segmentId: segment.id, quote: segment.content };
  });
}

export async function generateMeetingMemory(params: {
  input: MemoryGenerationInput;
  runner: MemoryModelRunner;
}): Promise<MemoryGenerationResult> {
  const { input, runner } = params;
  const segments = input.segments.filter((segment) => segment.content.trim().length > 0);
  if (input.people.length === 0 || segments.length === 0) {
    return {
      value: {
        memories: [],
        people: input.people.map((person) => ({ personId: person.id, summary: [], standing: [] })),
      },
      model: EMPTY_MODEL_LABEL,
    };
  }
  const history = [
    ...new Map(
      input.history.flatMap((person) => person.memories.map((memory) => [memory.id, memory] as const)),
    ).values(),
  ];
  const historyRefs = new Map(history.map((memory, index) => [memory.id, `H${index + 1}`]));
  const historyIds = new Map([...historyRefs].map(([id, ref]) => [ref, id]));
  const personIds = buildPersonIdTuple(input.people);
  const schema = buildMemoryGenerationSchema({ generationInput: input, personIds });
  const modelResult = await (async () => {
    try {
      return await runner.run({
        prompt: MEMORY_GENERATION_PROMPT,
        payload: {
          ownerUserId: input.ownerUserId,
          title: input.title,
          occurredAt: input.occurredAt,
          preferences: input.preferences,
          people: input.people,
          knownFacts: input.knownFacts,
          segments: segments.map((segment, index) => ({
            id: `S${index + 1}`,
            at: segment.startedAt,
            text: segment.content,
            speaker: segment.speakerUserId === input.ownerUserId ? "You" : segment.speakerName,
            personId: input.people.find((person) => person.userId === segment.speakerUserId)?.id ?? null,
          })),
          history: input.history.map((person) => ({
            personId: person.personId,
            memories: person.memories.map((memory) => ({ ...memory, id: historyRefs.get(memory.id) })),
          })),
        },
        schema,
        name: "relationship_meeting",
        meetingId: input.meetingId,
      });
    } catch (error: unknown) {
      throw rejectMemoryValidation(error, "model");
    }
  })();

  try {
    const memories = modelResult.value.memories.map((memory) => ({
      ...memory,
      evidence: mapGeneratedEvidence({ evidence: memory.evidence, segments }),
    }));
    const restore = (items: (typeof modelResult.value.people)[number]["summary"]) =>
      items.map((sentence) => ({
        ...sentence,
        text: sentence.text.replace(MEMORY_REF_PATTERN, ""),
        memoryRefs: sentence.memoryRefs.map((ref) => historyIds.get(ref) ?? ref),
      }));
    const value = memoryGenerationSchema.parse({
      memories,
      people: modelResult.value.people.map((person) => ({
        ...person,
        summary: restore(person.summary),
        standing: restore(person.standing),
      })),
    });

    return { value: validateMemoryGeneration({ input, value }), model: modelResult.model };
  } catch (error: unknown) {
    throw rejectMemoryValidation(error, STAGE_EVIDENCE);
  }
}
