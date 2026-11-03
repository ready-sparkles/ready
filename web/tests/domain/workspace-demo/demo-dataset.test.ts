import {
  compareRelationshipMemories,
  meetingListResponseSchema,
  memoryProjectionSchema,
  personalAssignedTasksResponseSchema,
  userSchema,
  workspaceMembersResponseSchema,
} from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkspaceDemoDataset, shiftDatesInText } from "../../../domain/workspace-demo/demo-dataset";
import { DEMO_MEETINGS, DEMO_MOMENTS, DEMO_PEOPLE } from "../../../domain/workspace-demo/demo-fixtures";

const now = Date.parse("2026-09-28T20:00:00-07:00");
const dataset = buildWorkspaceDemoDataset({ now });

const TEST_VALUE_10 = 10;
const TEST_VALUE_200 = 200;
const TEST_VALUE_21 = 21;
const TEST_VALUE_3 = 3;
const TEST_VALUE_30 = 30;
const TEST_VALUE_5 = 5;
const TEST_VALUE_50 = 50;
const TEST_VALUE_86_400_000 = 86_400_000;
const LAUNCH_FIXTURE_TEXT = "Launch on Friday, September 11. Onsite Sep 2; the July 25 call.";
const MAY_JOIN_FIXTURE_TEXT = "You may join in May 2026.";
void test("the shipped fixtures and runtime stay bounded to the latest 30 records", () => {
  [DEMO_PEOPLE, DEMO_MOMENTS, DEMO_MEETINGS, dataset.people, dataset.memories, dataset.meetings].forEach((records) => {
    assert.equal(records.length, TEST_VALUE_30);
  });
  assert.equal(dataset.personById.size, TEST_VALUE_30);
  assert.equal(dataset.memorySourceById.size, TEST_VALUE_30);
  assert.equal(dataset.meetingSources.size, TEST_VALUE_30);
  const firstPerson = DEMO_PEOPLE[0];
  const lastPerson = DEMO_PEOPLE.at(-1);
  const lastMeeting = DEMO_MEETINGS.at(-1);
  const lastMoment = DEMO_MOMENTS.at(-1);
  assert.ok(firstPerson);
  assert.ok(lastPerson);
  assert.ok(lastMeeting);
  assert.ok(lastMoment);
  assert.equal(firstPerson.name, "Danny Ocean");
  assert.equal(lastPerson.name, "Ashwin Reddy");
  assert.equal(lastMeeting.title, "Leo debrief · Reference questions");
  assert.equal(lastMoment.id, "m-181");
  const descending = (dates: string[]) =>
    dates.every((date, index) => {
      const previous = dates[index - 1];

      return index === 0 || (previous !== undefined && Date.parse(previous) >= Date.parse(date));
    });
  assert.ok(descending(DEMO_PEOPLE.map((person) => person.lastContact)));
  assert.ok(descending(DEMO_MEETINGS.map((meeting) => meeting.startedAt)));
  assert.ok(descending(DEMO_MOMENTS.map((memory) => memory.ts)));
  const people = new Set(dataset.people.map((person) => person.id));
  assert.ok(dataset.memories.every((memory) => memory.personIds.every((id) => people.has(id))));
  dataset.people.forEach((person) => {
    const detail = dataset.getPersonDetail(person.id);
    assert.ok(detail);
    assert.ok(detail.meetings.every((meeting) => dataset.meetingSources.has(meeting.id)));
    assert.ok(detail.memories.every((memory) => dataset.memorySourceById.has(memory.id)));
  });
});

void test("demo payloads satisfy the API response schemas", () => {
  userSchema.parse(dataset.user);
  meetingListResponseSchema.parse({ meetings: dataset.meetings });
  personalAssignedTasksResponseSchema.parse({ tasks: dataset.tasks });
  workspaceMembersResponseSchema.parse({ members: dataset.members });
  dataset.people.slice(0, TEST_VALUE_50).forEach((person) => {
    const detail = dataset.getPersonDetail(person.id);
    if (detail?.projection) {
      memoryProjectionSchema.parse(detail.projection);
    }
  });
});

void test("fixture keys map to distinct ids", () => {
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  assert.ok(unique(dataset.memories.map((memory) => memory.id)));
  assert.ok(unique(dataset.people.map((person) => person.id)));
  assert.ok(unique(dataset.meetings.map((meeting) => meeting.id)));
  assert.ok(unique(dataset.tasks.map((task) => task.taskId)));
});

void test("Sophie Chen opens with the homepage demo story", () => {
  const detail = dataset.getPersonDetail(dataset.featuredPersonId);
  assert.equal(detail?.person.name, "Sophie Chen");
  assert.equal(detail.projection?.standing.length, TEST_VALUE_5);
  assert.match(detail.projection.summary.map((sentence) => sentence.text).join(" "), /Meridian’s rollout/);
  assert.match(
    detail.projection.summary.map((sentence) => sentence.text).join(" "),
    /You and Sophie are working closely/,
  );
  const standingIds = new Set(detail.projection.standing.flatMap((item) => item.memoryIds));
  assert.equal(detail.memories.filter((memory) => standingIds.has(memory.id)).length, TEST_VALUE_3);
  assert.ok(detail.meetings.length !== 0);
});

void test("recorded history stays in the past and upcoming calls stay ahead", () => {
  assert.ok(dataset.memories.every((memory) => Date.parse(memory.occurredAt) <= now));
  assert.ok(dataset.meetings.every((meeting) => Date.parse(meeting.endedAt ?? meeting.createdAt) <= now));
  assert.ok(dataset.upcoming.length !== 0);
  assert.ok(dataset.upcoming.every((meeting) => Date.parse(meeting.start) > now));
  // Whole-week shifts keep every call on its original weekday.
  const weekday = (iso: string) => new Date(iso).getUTCDay();
  assert.ok(
    dataset.meetings.slice(0, TEST_VALUE_200).every((meeting) => {
      const source = dataset.meetingSources.get(meeting.id);
      assert.ok(meeting.startedAt !== null && meeting.startedAt !== "");
      assert.ok(source !== undefined);

      return weekday(meeting.startedAt) === weekday(source.source.startedAt);
    }),
  );
});

void test("dates written in fixture text move with the timeline", () => {
  const threeWeeks = TEST_VALUE_21 * TEST_VALUE_86_400_000;
  assert.equal(
    shiftDatesInText({ text: LAUNCH_FIXTURE_TEXT, shiftMs: threeWeeks }),
    "Launch on Friday, October 2. Onsite Sep 23; the August 15 call.",
  );
  assert.equal(shiftDatesInText({ text: MAY_JOIN_FIXTURE_TEXT, shiftMs: threeWeeks }), "You may join in May 2026.");
  const planning = dataset.meetings.find((meeting) => meeting.title === "Website launch planning");
  assert.ok(
    planning !== undefined &&
      planning.notePreview !== null &&
      planning.notePreview !== undefined &&
      planning.notePreview !== "" &&
      !planning.notePreview.includes("September 11"),
  );
});

void test("memories are ordered exactly as the API orders them", () => {
  const expected = [...dataset.memories].sort(compareRelationshipMemories);
  assert.ok(expected.every((memory, index) => memory === dataset.memories[index]));
});

void test("every contact has a natural email on a domain listed for its company", () => {
  assert.ok(
    dataset.people.every(
      (person) =>
        person.email !== null &&
        person.email !== undefined &&
        person.email !== "" &&
        person.companyDomain !== null &&
        person.companyDomain !== undefined &&
        person.email.endsWith(`@${person.companyDomain}`),
    ),
  );
  assert.equal(dataset.getPersonDetail(dataset.featuredPersonId)?.person.email, "sophie@example.com");
  assert.ok(!dataset.people.some((person) => person.companyName === "Highlight"));
});

void test("all retained meeting notes follow the snapshot prompt structure", () => {
  [...dataset.meetingSources.values()].forEach(({ source }) => {
    const headings = source.notes.map((note) => note.heading);
    const overview = source.notes[0];
    assert.ok(overview);
    assert.equal(headings[0], "Overview", source.id);
    assert.ok(overview.bullets.length <= TEST_VALUE_3, source.id);
    if (headings.includes("Next steps")) {
      assert.equal(headings.at(-1), "Next steps", source.id);
    }
    const decisions = headings.indexOf("Decisions");
    if (decisions >= 0) {
      assert.ok(decisions === headings.length - 1 || headings[decisions + 1] === "Next steps", source.id);
    }
    source.notes
      .filter((item) => !["Next steps", "Decisions"].includes(item.heading))
      .forEach((note) => {
        assert.ok(note.bullets.length <= TEST_VALUE_3, `${source.id}: ${note.heading}`);
      });
  });
});

void test("the memory article uses work examples with their original evidence", () => {
  const work = buildWorkspaceDemoDataset({ now, options: { workExamplesOnly: true } });
  assert.ok(work.memories.length > TEST_VALUE_10);
  const visibleRecords = JSON.stringify([work.memories, work.people, work.meetings, work.tasks, work.upcoming]);
  assert.doesNotMatch(visibleRecords, /Bellagio|Danny Ocean|Rusty Ryan|Livingston|Reuben/);
  work.memories.forEach((memory) => {
    assert.deepEqual(work.getMemoryEvidence(memory.id), dataset.getMemoryEvidence(memory.id));
    assert.ok(memory.personIds.every((id) => work.personById.has(id)));
  });
});
