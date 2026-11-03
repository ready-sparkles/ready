import type { CalendarEventPrepRow } from "@readymeet/db";
import type { NormalizedCalendarEvent } from "@readymeet/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import {
  buildCalendarPrepParallelRuns,
  buildCalendarPrepProgress,
  buildCalendarPrepTargetPlan,
  buildCompanyLatestSearchRequest,
  buildCompletedPrepProgress,
  buildPendingPrepProgress,
  normalizeParallelPrepResults,
  normalizeParallelRunProgress,
  parseParallelRunEvents,
  responseFromPrepRow,
} from "../../application/calendar-meeting-prep";

const EXTERNAL_ATTENDEE_COUNT = 8;
const PEOPLE_TARGET_CAP = 6;
const COMPANY_RUN_COUNT = 1;
const MAX_AGE_SECONDS = 86400;
const TASK_GROUP_RUN_COUNT = 3;
const PROGRESS_HALF_PERCENT = 50;
const PROGRESS_QUARTER_PERCENT = 25;
const PROGRESS_THIRTY_SEVEN_PERCENT = 37;
const PROGRESS_FORTY_TWO_PERCENT = 42;
const PARALLEL_PROGRESS_EVENT_COUNT = 25;
const LONG_MESSAGE_PADDING_LENGTH = 300;
const RETAINED_PROGRESS_MESSAGE_COUNT = 20;
const MAX_PROGRESS_MESSAGE_LENGTH = 240;
const ACTIVE_RUNNING_RUN_COUNT = 2;
const COMPLETED_PREP_RUN_COUNT = 2;
const FULL_PROGRESS_PERCENT = 100;
const PENDING_PREP_TOTAL_RUNS = 3;
const PENDING_PREP_PEOPLE_RUN_COUNT = 2;
const NORMALIZED_SOURCE_COUNT = 2;

const MESSAGE_READING_COMPANY_PAGES_FOR_MAYA = "Reading company pages for Personqe Personqn";
const MESSAGE_READING_NEWS_EXAMPLE_STORY = "Reading news.example.com/story";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTaskOutputSchemaProperties(outputSchema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(outputSchema)) {
    return undefined;
  }
  const jsonSchema = outputSchema.json_schema;

  if (!isRecord(jsonSchema)) {
    return undefined;
  }
  const properties = jsonSchema.properties;
  if (!isRecord(properties)) {
    return undefined;
  }

  return properties;
}

function readParticipantExactEmailIdentityHints(input: unknown): unknown[] | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const participant = input.participant;
  if (!isRecord(participant)) {
    return undefined;
  }
  const hints = participant.exact_email_identity_hints;
  if (hints === undefined) {
    return undefined;
  }

  return Array.isArray(hints) ? hints : undefined;
}

function calendarEventPrepRowForTest(row: CalendarEventPrepRow): CalendarEventPrepRow {
  return row;
}

function event(overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent {
  return {
    id: "google_calendar:primary:event-1",
    provider: "google_calendar",
    providerEventId: "event-1",
    calendarId: "primary",
    title: "Customer kickoff",
    start: "2026-05-09T19:00:00.000Z",
    end: "2026-05-09T20:00:00.000Z",
    timezone: "UTC",
    location: null,
    organizer: null,
    attendees: [],
    isPrivate: false,
    isCancelled: false,
    isAllDay: false,
    joinUrl: null,
    sourceUrl: null,
    ...overrides,
  };
}

const userContext = {
  userId: "11111111-1111-4111-8111-111111111111",
  userEmail: "personqc@ready.app",
  userDisplayName: "Personqc",
  calendarAccountEmails: ["personqc@ready.app"],
};

void test("meeting prep skips company research for internal-only meetings", () => {
  const plan = buildCalendarPrepTargetPlan({
    event: event({
      organizer: { name: "Personqc", email: "personqc@ready.app", responseStatus: null },
      attendees: [
        { name: "Personqe", email: "personqe@ready.app", responseStatus: "accepted" },
        { name: "Personrg", email: "personrg@ready.app", responseStatus: "accepted" },
      ],
    }),
    userContext,
  });

  assert.deepEqual(plan.ownCompanyDomains, ["ready.app"]);
  assert.equal(plan.companyTarget, null);
  assert.equal(plan.peopleTargets.length, 0);
});

void test("meeting prep ignores freemail domains when inferring companies", () => {
  const plan = buildCalendarPrepTargetPlan({
    event: event({
      attendees: [
        { name: "Personal Guest", email: "guest@gmail.com", responseStatus: "accepted" },
        { name: "Customer", email: "customer@acme.com", responseStatus: "accepted" },
      ],
    }),
    userContext,
  });

  assert.equal(plan.companyTarget?.domain, "acme.com");
  assert.deepEqual(
    plan.externalParticipants.map((person) => person.email),
    ["guest@gmail.com", "customer@acme.com"],
  );
  assert.deepEqual(
    plan.peopleTargets.map((person) => person.emailDomain),
    ["acme.com"],
  );
});

void test("meeting prep treats connected freemail calendar accounts as the current user", () => {
  const plan = buildCalendarPrepTargetPlan({
    event: event({
      title: "Demo w/Personqc",
      organizer: { name: "Personqb Personqd", email: "personqb@example.com", responseStatus: null },
      attendees: [{ name: "Personqc Personqd", email: "personqc@ready.app", responseStatus: "accepted" }],
    }),
    userContext: {
      ...userContext,
      userDisplayName: "Personqc Personqd",
      calendarAccountEmails: ["personqc@ready.app", "personqb@example.com"],
    },
  });

  assert.deepEqual(
    plan.externalParticipants.map((person) => person.email),
    [],
  );
  assert.equal(plan.companyTarget, null);
  assert.equal(plan.peopleTargets.length, 0);
});

void test("meeting prep uses Gmail canonical self matching for connected calendar accounts", () => {
  const plan = buildCalendarPrepTargetPlan({
    event: event({
      title: "Personal block",
      attendees: [{ name: "Personqb Personqd", email: "personqb+calendar@example.com", responseStatus: "accepted" }],
    }),
    userContext: {
      ...userContext,
      userDisplayName: "Personqc Personqd",
      calendarAccountEmails: ["personqb@example.com"],
    },
  });

  assert.deepEqual(plan.externalParticipants, []);
  assert.equal(plan.companyTarget, null);
  assert.equal(plan.peopleTargets.length, 0);
});

void test("meeting prep does not create company targets for freemail-only attendees", () => {
  const plan = buildCalendarPrepTargetPlan({
    event: event({
      title: "Catch up",
      attendees: [{ name: "Personal Guest", email: "guest@gmail.com", responseStatus: "accepted" }],
    }),
    userContext,
  });

  assert.deepEqual(
    plan.externalParticipants.map((person) => person.email),
    ["guest@gmail.com"],
  );
  assert.equal(plan.companyTarget, null);
  assert.equal(plan.peopleTargets.length, 0);
});

void test("meeting prep prefers the external organizer company over attendee majority", () => {
  const plan = buildCalendarPrepTargetPlan({
    event: event({
      organizer: { name: "Organizer", email: "organizer@buyer.com", responseStatus: null },
      attendees: [
        { name: "One", email: "one@vendor.com", responseStatus: "accepted" },
        { name: "Two", email: "two@vendor.com", responseStatus: "accepted" },
      ],
    }),
    userContext,
  });

  assert.equal(plan.companyTarget?.domain, "buyer.com");
});

void test("meeting prep suppresses public research for obvious personal events", () => {
  const targetEvent = event({
    title: "Personqz Birthday Dinner",
    organizer: { name: "Personqk", email: "personqk@examplecorp.test", responseStatus: null },
    attendees: [{ name: "Personqc", email: "personqc@ready.app", responseStatus: "accepted" }],
  });
  const plan = buildCalendarPrepTargetPlan({
    event: targetEvent,
    userContext,
  });
  const runs = buildCalendarPrepParallelRuns({
    event: targetEvent,
    plan,
    processor: "core",
  });

  assert.equal(plan.meetingContext, "personal");
  assert.equal(plan.externalParticipants.length, 1);
  assert.equal(plan.peopleTargets.length, 0);
  assert.equal(plan.companyTarget, null);
  assert.equal(runs.length, 0);
});

void test("meeting prep keeps business research for weak social wording", () => {
  const targetEvent = event({
    title: "Dinner with Personqk",
    attendees: [{ name: "Personqk", email: "personqk@examplecorp.test", responseStatus: "accepted" }],
  });
  const plan = buildCalendarPrepTargetPlan({
    event: targetEvent,
    userContext,
  });

  assert.equal(plan.meetingContext, "business");
  assert.equal(plan.peopleTargets.length, 1);
  assert.equal(plan.companyTarget?.domain, "examplecorp.test");
});

void test("meeting prep keeps business research for explicit business social events", () => {
  ["Customer dinner with Personqk", "Partner launch party", "Demo w/ Personqk"].forEach((title) => {
    const targetEvent = event({
      title,
      attendees: [{ name: "Personqk", email: "personqk@examplecorp.test", responseStatus: "accepted" }],
    });
    const plan = buildCalendarPrepTargetPlan({
      event: targetEvent,
      userContext,
    });

    assert.equal(plan.meetingContext, "business", title);
    assert.equal(plan.peopleTargets.length, 1, title);
    assert.equal(plan.companyTarget?.domain, "examplecorp.test", title);
  });
});

void test("meeting prep caps people runs at six external participants", () => {
  const attendees = Array.from({ length: EXTERNAL_ATTENDEE_COUNT }, (_, index) => ({
    name: `Person ${index + 1}`,
    email: `person${index + 1}@external.com`,
    responseStatus: "accepted",
  }));
  const plan = buildCalendarPrepTargetPlan({
    event: event({ attendees }),
    userContext,
  });
  const runs = buildCalendarPrepParallelRuns({
    event: event({ attendees }),
    plan,
    processor: "core",
  });

  assert.equal(plan.peopleTargets.length, PEOPLE_TARGET_CAP);
  assert.equal(runs.filter((run) => run.ref.kind === "people").length, PEOPLE_TARGET_CAP);
  assert.equal(runs.filter((run) => run.ref.kind === "company").length, COMPANY_RUN_COUNT);
});

void test("meeting prep task specs request intelligence briefs instead of generic angles", () => {
  const plan = buildCalendarPrepTargetPlan({
    event: event({
      organizer: { name: "Organizer", email: "organizer@buyer.com", responseStatus: null },
      attendees: [{ name: "Personqe Personqn", email: "personqe@buyer.com", responseStatus: "accepted" }],
    }),
    userContext,
  });
  const runs = buildCalendarPrepParallelRuns({
    event: event({
      organizer: { name: "Organizer", email: "organizer@buyer.com", responseStatus: null },
      attendees: [{ name: "Personqe Personqn", email: "personqe@buyer.com", responseStatus: "accepted" }],
    }),
    plan,
    peopleProcessor: "core",
    companyProcessor: "pro",
  });
  const peopleRun = runs.find((run) => run.ref.kind === "people");
  const companyRun = runs.find((run) => run.ref.kind === "company");
  const peopleSchemaProperties =
    peopleRun === undefined ? undefined : readTaskOutputSchemaProperties(peopleRun.run.task_spec.output_schema);
  const companySchemaProperties =
    companyRun === undefined ? undefined : readTaskOutputSchemaProperties(companyRun.run.task_spec.output_schema);

  assert.equal(peopleRun?.run.input.task_type, "meeting_participant_public_intelligence");
  assert.equal(companyRun?.run.input.task_type, "meeting_external_company_intelligence");
  assert.equal(peopleRun.run.processor, "core");
  assert.equal(companyRun.run.processor, "pro");
  assert.ok(peopleSchemaProperties !== undefined && "recent_professional_signals" in peopleSchemaProperties);
  assert.ok(companySchemaProperties !== undefined && "latest_signals" in companySchemaProperties);
  assert.equal("conversation_angles" in peopleSchemaProperties, false);
  assert.equal("conversation_angles" in companySchemaProperties, false);
  assert.equal("sources" in peopleSchemaProperties, false);
  assert.equal("confidence" in companySchemaProperties, false);
});

void test("meeting prep passes exact email identity hints only to the matching people run", () => {
  const targetEvent = event({
    attendees: [
      { name: null, email: "personqe@buyer.com", responseStatus: "accepted" },
      { name: "Personrg", email: "personrg@buyer.com", responseStatus: "accepted" },
    ],
  });
  const plan = buildCalendarPrepTargetPlan({
    event: targetEvent,
    userContext,
  });
  const mayaTarget = plan.peopleTargets.find((person) => person.email === "personqe@buyer.com");
  assert.ok(mayaTarget);
  const runs = buildCalendarPrepParallelRuns({
    event: targetEvent,
    plan,
    peopleProcessor: "core",
    identityHints: [
      {
        participantKey: mayaTarget.key,
        email: "personqe@buyer.com",
        displayName: "Personqe Personqn",
        confidence: "high",
        reason: "Exact participant email matched a display name from email history.",
      },
    ],
  });

  const mayaRun = runs.find((run) => run.ref.participantKey === mayaTarget.key);
  const leeRun = runs.find((run) => run.ref.name === "Personrg");
  assert.deepEqual(readParticipantExactEmailIdentityHints(mayaRun?.run.input), [
    {
      email: "personqe@buyer.com",
      display_name: "Personqe Personqn",
      confidence: "high",
      reason: "Exact participant email matched a display name from email history.",
    },
  ]);
  assert.deepEqual(readParticipantExactEmailIdentityHints(leeRun?.run.input), []);
});

void test("meeting prep company search request includes freshness controls", () => {
  const plan = buildCalendarPrepTargetPlan({
    event: event({
      attendees: [{ name: "Customer", email: "customer@acme.com", responseStatus: "accepted" }],
    }),
    userContext,
  });
  assert.ok(plan.companyTarget);
  const request = buildCompanyLatestSearchRequest({
    event: event({
      attendees: [{ name: "Customer", email: "customer@acme.com", responseStatus: "accepted" }],
    }),
    target: plan.companyTarget,
    now: new Date("2026-05-08T20:00:00.000Z"),
  });

  assert.equal(request.afterDate, "2026-02-07");
  assert.equal(request.body.mode, "turbo");
  const advancedSettings = z
    .object({ source_policy: z.unknown(), fetch_policy: z.unknown() })
    .parse(request.body.advanced_settings);
  assert.deepEqual(advancedSettings.source_policy, { after_date: "2026-02-07" });
  assert.deepEqual(advancedSettings.fetch_policy, { max_age_seconds: MAX_AGE_SECONDS });
});

void test("meeting prep progress maps group status counts", () => {
  const progress = buildCalendarPrepProgress({
    runRefs: {
      taskgroupId: "taskgroup-1",
      companyVisible: true,
      runs: [
        { kind: "people", runId: "people-run-1", name: "Personqe Personqn", domain: "acme.com" },
        { kind: "people", runId: "people-run-2", name: "Personrg Personqn", domain: "acme.com" },
        { kind: "company", runId: "company-run", domain: "acme.com" },
      ],
    },
    group: {
      taskgroup_id: "taskgroup-1",
      status: {
        is_active: true,
        num_task_runs: TASK_GROUP_RUN_COUNT,
        task_run_status_counts: {
          queued: 1,
          running: 1,
          completed: 1,
        },
      },
    },
    now: new Date("2026-05-08T20:00:00.000Z"),
  });

  assert.equal(progress.totalRuns, TASK_GROUP_RUN_COUNT);
  assert.equal(progress.queuedRuns, 1);
  assert.equal(progress.runningRuns, 1);
  assert.equal(progress.completedRuns, 1);
  assert.equal(progress.failedRuns, 0);
  assert.equal(progress.peopleStatus, "running");
  assert.equal(progress.companyStatus, "running");
  assert.equal(progress.peopleMessage, "Searching public sources");
});

void test("meeting prep progress maps run events to raw messages and percent", () => {
  const events = parseParallelRunEvents(
    [
      "event: task_run.progress_msg.plan",
      'data: {"type":"task_run.progress_msg.plan","message":"Planning task..."}',
      "",
      "event: task_run.progress_stats",
      'data: {"task_run":{"state":"running","progress_stats":{"progress_meter":{"current":2,"total":4}},"progress_msg":{"message":"Searching LinkedIn and company pages for Personqe Personqn"}}}',
      "",
      "event: task_run.progress_msg.search",
      'data: {"type":"task_run.progress_msg.search","message":"Searching LinkedIn and company pages for Personqe Personqn"}}',
      "",
      "",
    ].join("\n"),
  );
  const runProgress = normalizeParallelRunProgress("people-run", events);

  assert.equal(runProgress.status, "running");
  assert.equal(runProgress.progressPercent, PROGRESS_HALF_PERCENT);
  assert.deepEqual(runProgress.messages, [
    "Planning task...",
    "Searching LinkedIn and company pages for Personqe Personqn",
    "Research progress 50%",
  ]);
  assert.equal(runProgress.message, "Research progress 50%");
});

void test("meeting prep progress maps source stats to readable progress lines", () => {
  const events = parseParallelRunEvents(
    [
      "event: task_run.progress_stats",
      'data: {"type":"task_run.progress_stats","progress_meter":25,"source_stats":{"num_sources_considered":82,"num_sources_read":6,"sources_read_sample":["https://www.acme.com/blog/launch","https://news.example.com/story","https://acme.com/changelog"]}}',
      "",
      "",
    ].join("\n"),
  );
  const runProgress = normalizeParallelRunProgress("company-run", events);

  assert.equal(runProgress.progressPercent, PROGRESS_QUARTER_PERCENT);
  assert.deepEqual(runProgress.messages, [
    "Research progress 25%",
    "Considered 82 sources and read 6",
    "Reading acme.com/blog/launch",
    "Reading news.example.com/story",
    "Reading acme.com/changelog",
  ]);
  assert.equal(runProgress.message, "Reading acme.com/changelog");
});

void test("meeting prep progress maps task run state events", () => {
  const events = parseParallelRunEvents(
    [
      "event: task_run.state",
      'data: {"type":"task_run.state","run":{"run_id":"people-run","status":"running","is_active":true,"processor":"pro"}}',
      "",
      "",
    ].join("\n"),
  );
  const runProgress = normalizeParallelRunProgress("people-run", events);

  assert.equal(runProgress.status, "running");
  assert.deepEqual(runProgress.messages, ["Looking through public sources"]);
  assert.equal(runProgress.message, "Looking through public sources");
});

void test("meeting prep progress parses raw json event lines", () => {
  const events = parseParallelRunEvents(
    [
      '{"type":"task_run.progress_msg.plan","message":"Planning task..."}',
      '{"type":"task_run.progress_stats","progress_meter":0.5}',
      "",
    ].join("\n"),
  );
  const runProgress = normalizeParallelRunProgress("people-run", events);

  assert.equal(runProgress.progressPercent, PROGRESS_HALF_PERCENT);
  assert.deepEqual(runProgress.messages, ["Planning task...", "Research progress 50%"]);
});

void test("meeting prep progress maps progress meter to a visible section line", () => {
  const progress = buildCalendarPrepProgress({
    runRefs: {
      taskgroupId: "taskgroup-1",
      companyVisible: false,
      runs: [{ kind: "people", runId: "people-run", name: "Personqe Personqn", domain: "acme.com" }],
    },
    runProgresses: [
      {
        runId: "people-run",
        status: "running",
        progressPercent: PROGRESS_THIRTY_SEVEN_PERCENT,
        message: null,
        messages: [],
      },
    ],
    now: new Date("2026-05-08T20:00:00.000Z"),
  });

  assert.deepEqual(progress.peopleMessages, ["Researching Personqe Personqn", "Checking acme.com"]);
  assert.equal(progress.peopleMessage, "Checking acme.com");
});

void test("meeting prep progress redacts emails and caps retained raw messages", () => {
  const events = parseParallelRunEvents(
    Array.from({ length: PARALLEL_PROGRESS_EVENT_COUNT }, (_, index) =>
      [
        `event: task_run.progress_msg.step`,
        `data: {"type":"task_run.progress_msg.step","message":"Message ${index} for personqe${index}@example.com ${"x".repeat(LONG_MESSAGE_PADDING_LENGTH)}"}`,
        "",
      ].join("\n"),
    ).join("\n"),
  );
  const runProgress = normalizeParallelRunProgress("people-run", events);

  assert.equal(runProgress.messages.length, RETAINED_PROGRESS_MESSAGE_COUNT);
  assert.match(runProgress.messages[0] ?? "", /^Message 5 for \[email\]/);
  assert.equal(
    runProgress.messages.some((message) => message.includes("@example.com")),
    false,
  );
  assert.equal(
    runProgress.messages.every((message) => message.length <= MAX_PROGRESS_MESSAGE_LENGTH),
    true,
  );
});

void test("meeting prep progress preserves previous progress when run events are unavailable", () => {
  const previousProgress = buildCalendarPrepProgress({
    runRefs: {
      taskgroupId: "taskgroup-1",
      companyVisible: true,
      runs: [
        { kind: "people", runId: "people-run", name: "Personqe Personqn", domain: "acme.com" },
        { kind: "company", runId: "company-run", domain: "acme.com" },
      ],
    },
    runProgresses: [
      {
        runId: "people-run",
        status: "running",
        progressPercent: PROGRESS_FORTY_TWO_PERCENT,
        message: MESSAGE_READING_COMPANY_PAGES_FOR_MAYA,
        messages: [MESSAGE_READING_COMPANY_PAGES_FOR_MAYA],
      },
    ],
    now: new Date("2026-05-08T20:00:00.000Z"),
  });
  const nextProgress = buildCalendarPrepProgress({
    runRefs: {
      taskgroupId: "taskgroup-1",
      companyVisible: true,
      runs: [
        { kind: "people", runId: "people-run", name: "Personqe Personqn", domain: "acme.com" },
        { kind: "company", runId: "company-run", domain: "acme.com" },
      ],
    },
    group: {
      taskgroup_id: "taskgroup-1",
      status: {
        is_active: true,
        num_task_runs: ACTIVE_RUNNING_RUN_COUNT,
        task_run_status_counts: {
          running: ACTIVE_RUNNING_RUN_COUNT,
        },
      },
    },
    runProgresses: [],
    previousProgress,
    now: new Date("2026-05-08T20:00:05.000Z"),
  });

  assert.equal(nextProgress.peopleProgressPercent, PROGRESS_FORTY_TWO_PERCENT);
  assert.deepEqual(nextProgress.peopleMessages, [
    "Researching Personqe Personqn",
    "Checking acme.com",
    "Reading company pages for Personqe Personqn",
  ]);
  assert.equal(nextProgress.peopleMessage, MESSAGE_READING_COMPANY_PAGES_FOR_MAYA);
  assert.equal(nextProgress.runningRuns, ACTIVE_RUNNING_RUN_COUNT);
});

void test("meeting prep progress keeps concrete source samples ahead of target-domain fallback", () => {
  const progress = buildCalendarPrepProgress({
    runRefs: {
      taskgroupId: "taskgroup-1",
      companyVisible: true,
      runs: [{ kind: "company", runId: "company-run", domain: "acme.com" }],
    },
    runProgresses: [
      {
        runId: "company-run",
        status: "running",
        progressPercent: PROGRESS_FORTY_TWO_PERCENT,
        message: MESSAGE_READING_NEWS_EXAMPLE_STORY,
        messages: [MESSAGE_READING_NEWS_EXAMPLE_STORY],
      },
    ],
    now: new Date("2026-05-08T20:00:00.000Z"),
  });

  assert.deepEqual(progress.companyMessages, ["Checking acme.com", MESSAGE_READING_NEWS_EXAMPLE_STORY]);
  assert.equal(progress.companyMessage, MESSAGE_READING_NEWS_EXAMPLE_STORY);
});

void test("meeting prep completed progress returns 100 percent for completed sections", () => {
  const progress = buildCompletedPrepProgress({
    runRefs: {
      companyVisible: true,
      runs: [
        { kind: "people", runId: "people-run", name: "Personqe Personqn", domain: "acme.com" },
        { kind: "company", runId: "company-run", domain: "acme.com" },
      ],
    },
    now: new Date("2026-05-08T20:00:00.000Z"),
  });

  assert.equal(progress.completedRuns, COMPLETED_PREP_RUN_COUNT);
  assert.equal(progress.peopleStatus, "completed");
  assert.equal(progress.companyStatus, "completed");
  assert.equal(progress.peopleProgressPercent, FULL_PROGRESS_PERCENT);
  assert.equal(progress.companyProgressPercent, FULL_PROGRESS_PERCENT);
});

void test("meeting prep pending progress preserves durable start time", () => {
  const progress = buildPendingPrepProgress({
    totalRuns: PENDING_PREP_TOTAL_RUNS,
    peopleRunCount: PENDING_PREP_PEOPLE_RUN_COUNT,
    companyVisible: true,
    startedAt: "2026-05-08T20:00:00.000Z",
    now: new Date("2026-05-08T20:00:05.000Z"),
  });

  assert.equal(progress.startedAt, "2026-05-08T20:00:00.000Z");
  assert.equal(progress.queuedRuns, PENDING_PREP_TOTAL_RUNS);
  assert.equal(progress.peopleStatus, "pending");
  assert.equal(progress.companyMessage, "Planning research");
});

void test("meeting prep normalizes completed Parallel people and company outputs", () => {
  const normalized = normalizeParallelPrepResults({
    prepId: "22222222-2222-4222-8222-222222222222",
    runRefs: {
      companyVisible: true,
      runs: [
        { kind: "people", runId: "people-run", name: "Personqe Personqn", domain: "acme.com" },
        { kind: "company", runId: "company-run", domain: "acme.com" },
      ],
    },
    results: [
      {
        run: { run_id: "people-run", status: "completed" },
        output: {
          content: {
            participant_identity: {
              name: "Personqe Personqn",
              current_title: "VP Product",
              current_company: "Acme",
              public_profile_url: "https://example.com/personqe",
            },
            likely_scope: "Owns onboarding and product adoption work.",
            why_this_person_matters_for_meeting:
              "Personqe appears relevant because the kickoff is about onboarding rollout.",
            recent_professional_signals: [],
            relevant_background: [
              {
                fact: "Held product analytics leadership roles from 2021-08 to 2025-04.",
                why_it_matters: "Useful context for rollout metrics.",
              },
            ],
            company_connection: "Works at Acme.",
            unknown_or_low_confidence_items: [],
          },
          basis: [{ citations: [{ title: "Personqe profile", url: "https://example.com/personqe" }] }],
        },
      },
      {
        run: { run_id: "company-run", status: "completed" },
        output: {
          content: {
            company_identity: {
              name: "Acme",
              website: "https://acme.com",
              one_line_business_description: "Acme builds onboarding software.",
              company_stage_or_type: "Private software company.",
              headquarters_or_main_location: "San Francisco, CA",
            },
            why_this_company_context_matters:
              "On February 24, 2026, Acme expanded its onboarding investment, which is the center of this kickoff.",
            latest_signals: [
              {
                date: "2026-04-28",
                signal: "Acme launched an enterprise onboarding product.",
                why_it_matters_for_meeting: "The rollout could shape implementation priorities.",
                source_type: "official announcement",
              },
            ],
            current_company_priorities: [],
            business_health_or_momentum: [
              {
                indicator: "Acme reported enterprise onboarding momentum.",
                date: "February 2026",
                interpretation: "Suggests increased implementation demand.",
              },
            ],
            product_or_market_context: [],
            risks_or_sensitive_context: [],
            unknown_or_low_confidence_items: [],
          },
          basis: [{ citations: [{ title: "Acme", url: "https://acme.com" }] }],
        },
      },
    ],
  });

  assert.equal(normalized.status, "completed");
  assert.match(normalized.people.bullets[0] ?? "", /Personqe Personqn/);
  assert.match(normalized.people.bullets[1] ?? "", /^Owns onboarding/);
  assert.match(normalized.people.bullets[2] ?? "", /^Held product analytics leadership roles from 8\/2021 to 4\/2025/);
  assert.doesNotMatch(normalized.people.bullets[2] ?? "", /2021-08|2025-04/);
  assert.equal(
    normalized.people.bullets.some((bullet) => /^Background:|^Scope:/.test(bullet)),
    false,
  );
  assert.equal(normalized.company?.companyName, "Acme");
  assert.match(normalized.company.bullets[0] ?? "", /^On 2\/24\/2026/);
  assert.match(normalized.company.bullets[1] ?? "", /^4\/28\/2026:/);
  assert.match(normalized.company.bullets[2] ?? "", /^2\/2026:/);
  assert.equal(normalized.sources.length, NORMALIZED_SOURCE_COUNT);
  assert.equal(normalized.progress?.peopleProgressPercent, FULL_PROGRESS_PERCENT);
  assert.equal(normalized.progress.companyProgressPercent, FULL_PROGRESS_PERCENT);
});

void test("meeting prep normalizes stored bullet date formats when reading rows", () => {
  const response = responseFromPrepRow(
    calendarEventPrepRowForTest({
      id: "22222222-2222-4222-8222-222222222222",
      userId: userContext.userId,
      calendarAccountId: null,
      calendarEventId: "google_calendar:primary:event-1",
      eventFingerprint: "fingerprint",
      legacyFingerprintKey: null,
      taskgroupId: "taskgroup-1",
      status: "completed",
      eventSnapshot: {},
      runRefs: {
        /** @external calendar prep run refs company visible wire field */
        companyVisible: true,
        runs: [],
      },
      result: {
        status: "completed",
        brief: {
          status: "completed",
          bullets: ["Recent email: Personqe sent the implementation deck on 2026-02-24T10:00:00.000Z."],
        },
        people: {
          status: "completed",
          bullets: ["Held recruiting roles from 2021-08 to 2025-04 before joining the current team."],
          sources: [],
        },
        company: {
          status: "completed",
          companyName: "Acme",
          website: "https://acme.com/",
          bullets: ["February 24, 2026: Acme announced a product expansion."],
          sources: [],
        },
        sources: [],
        error: null,
        progress: buildCompletedPrepProgress({
          runRefs: {
            /** @external calendar prep run refs company visible wire field */
            companyVisible: true,
            runs: [],
          },
          startedAt: "2026-05-08T20:00:00.000Z",
        }),
      },
      error: null,
      createdAt: new Date("2026-05-08T20:00:00.000Z"),
      updatedAt: new Date("2026-05-08T20:00:01.000Z"),
    }),
  );

  assert.equal(response.brief.bullets[0], "Recent email: Personqe sent the implementation deck on 2/24/2026.");
  assert.equal(
    response.people.bullets[0],
    "Held recruiting roles from 8/2021 to 4/2025 before joining the current team.",
  );
  assert.equal(response.company?.bullets[0], "2/24/2026: Acme announced a product expansion.");
});

void test("meeting prep preserves stored private brief while public research is running", () => {
  const response = responseFromPrepRow(
    calendarEventPrepRowForTest({
      id: "22222222-2222-4222-8222-222222222222",
      userId: userContext.userId,
      calendarAccountId: null,
      calendarEventId: "google_calendar:primary:event-1",
      eventFingerprint: "fingerprint",
      legacyFingerprintKey: null,
      taskgroupId: "taskgroup-1",
      status: "running",
      eventSnapshot: {},
      runRefs: {
        /** @external calendar prep run refs company visible wire field */
        companyVisible: true,
        taskgroupId: "taskgroup-1",
        runs: [{ kind: "people", runId: "people-run" }],
      },
      result: {
        brief: {
          status: "completed",
          bullets: ["Open loop: Send the revised deck before the meeting."],
        },
        progress: buildPendingPrepProgress({
          totalRuns: 1,
          peopleRunCount: 1,
          companyVisible: true,
          startedAt: "2026-05-08T20:00:00.000Z",
        }),
      },
      error: null,
      createdAt: new Date("2026-05-08T20:00:00.000Z"),
      updatedAt: new Date("2026-05-08T20:00:01.000Z"),
    }),
  );

  assert.equal(response.status, "running");
  assert.deepEqual(response.brief, {
    status: "completed",
    bullets: ["Open loop: Send the revised deck before the meeting."],
  });
});

void test("meeting prep normalizes stale running brief on completed rows", () => {
  const response = responseFromPrepRow(
    calendarEventPrepRowForTest({
      id: "22222222-2222-4222-8222-222222222222",
      userId: userContext.userId,
      calendarAccountId: null,
      calendarEventId: "google_calendar:primary:event-1",
      eventFingerprint: "fingerprint",
      legacyFingerprintKey: null,
      taskgroupId: "taskgroup-1",
      status: "completed",
      eventSnapshot: {},
      runRefs: {
        /** @external calendar prep run refs company visible wire field */
        companyVisible: false,
        runs: [],
      },
      result: {
        status: "completed",
        brief: { status: "running", bullets: [] },
        people: { status: "completed", bullets: [], sources: [] },
        company: null,
        sources: [],
        error: null,
        progress: buildCompletedPrepProgress({
          runRefs: {
            /** @external calendar prep run refs company visible wire field */
            companyVisible: false,
            runs: [],
          },
          startedAt: "2026-05-08T20:00:00.000Z",
        }),
      },
      error: null,
      createdAt: new Date("2026-05-08T20:00:00.000Z"),
      updatedAt: new Date("2026-05-08T20:00:01.000Z"),
    }),
  );

  assert.equal(response.status, "completed");
  assert.deepEqual(response.brief, { status: "completed", bullets: [] });
});
