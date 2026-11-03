import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { guestMeetingNotesResponseSchema } from "@readymeet/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";

import { writeGuestNotesHandoff } from "../../../composition/guest-notes-transition";
import { GuestNotesExperience, type GuestNotesState } from "../../../presentation/components/guest-notes-experience";
import { GUEST_WAITING_FINAL_LINE } from "../../../presentation/components/meeting-waiting-state";
import { ToastProvider } from "../../../presentation/components/toast-provider";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const meetingId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const now = "2026-09-17T10:00:00.000Z";
const GUEST_NOTES_ENTRANCE_OVERLAY_MS = 3_000;
const GUEST_NOTES_ENTRANCE_STEP_ONE_MS = 520;
const GUEST_NOTES_ENTRANCE_STEP_TWO_MS = 340;
const GUEST_NOTES_ENTRANCE_STEP_THREE_MS = 420;
const GUEST_NOTES_WAITING_REJOIN_MS = 5_719;
const GUEST_NOTES_WAITING_FINAL_LINE_MS = 4_500;
const GUEST_NOTES_WAITING_STALE_CONCLUSION_MS = 20_000;
const GUEST_NOTES_TASKS_PHASE_REVEAL_MS = 2_000;

function notes(): GuestNotesState {
  return guestMeetingNotesResponseSchema.parse({
    meeting: {
      id: meetingId,
      workspaceId: userId,
      title: "Customer onboarding pilot",
      roomName: "pilot",
      createdByUserId: userId,
      status: "active",
      createdAt: now,
      startedAt: now,
      endedAt: null,
      participantNames: ["Personaa", "Personbr"],
    },
    meetingRuntime: {
      activeHumanParticipantCount: 1,
      activeHumanParticipants: [],
      allHumanParticipants: [],
      isAwaitingMeetingEnd: true,
    },
    transcript: null,
    summary: null,
    inProgressConclusions: ["The pilot starts next Tuesday.", "Three customers join the first cohort."],
  });
}

void test("guest waiting state transitions in place to notes, tasks, and the final signup banner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse(now) });
  t.mock.method(window, "setTimeout", globalThis.setTimeout);
  t.mock.method(window, "clearTimeout", globalThis.clearTimeout);
  t.mock.method(window, "setInterval", globalThis.setInterval);
  t.mock.method(window, "clearInterval", globalThis.clearInterval);
  const client = new QueryClient();
  t.after(() => {
    cleanup();
    client.clear();
  });
  const view = (data: GuestNotesState) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <GuestNotesExperience
          meetingId={meetingId}
          notes={data}
          error={null}
          currentUserId={userId}
          signupHref="/signup"
          signupAction={<a href="/signup">Create an account</a>}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
  writeGuestNotesHandoff({ meetingId, startedAt: Date.parse(now) });
  const data = notes();
  const screen = render(view(data));
  assert.equal(window.sessionStorage.getItem("readymeet-guest-notes-handoff"), null);
  const advance = async (ms: number) => {
    await act(async () => t.mock.timers.tick(ms));
  };

  assert.ok(screen.container.querySelector(".live-end-meeting-overlay"));
  assert.equal(screen.container.querySelector(".guest-notes-reveal")?.getAttribute("aria-hidden"), "true");
  await advance(GUEST_NOTES_ENTRANCE_OVERLAY_MS);
  await advance(GUEST_NOTES_ENTRANCE_STEP_ONE_MS);
  await advance(GUEST_NOTES_ENTRANCE_STEP_TWO_MS);
  await advance(GUEST_NOTES_ENTRANCE_STEP_THREE_MS);
  assert.equal(screen.container.querySelector(".live-end-meeting-overlay"), null);
  assert.equal(screen.getByText("Meeting is still in progress").textContent, "Meeting is still in progress");
  assert.equal(screen.queryByText("Conversation so far"), null);
  assert.equal(screen.container.querySelector("blockquote"), null);
  const currentLine = () =>
    screen.container.querySelector(".workspace-meeting-preparation-copy")?.getAttribute("aria-label");
  assert.equal(currentLine(), "The pilot starts next Tuesday.");
  assert.equal(screen.queryByText("Create an account"), null);
  assert.equal(screen.queryByText("Rejoin meeting"), null);
  await advance(GUEST_NOTES_WAITING_REJOIN_MS);
  assert.equal(screen.queryByText("Rejoin meeting"), null);
  await advance(1);
  assert.equal(screen.getByText("Rejoin meeting").getAttribute("href"), `/meetings/${meetingId}/live`);

  assert.equal(currentLine(), "Three customers join the first cohort.");
  assert.equal(screen.container.querySelector(".guest-notes-rejoin")?.nextElementSibling, null);
  await advance(GUEST_NOTES_WAITING_FINAL_LINE_MS);
  assert.equal(currentLine(), GUEST_WAITING_FINAL_LINE);
  screen.rerender(view({ ...data, inProgressConclusions: ["An updated conclusion from later discussion."] }));
  await advance(GUEST_NOTES_WAITING_STALE_CONCLUSION_MS);
  assert.equal(currentLine(), GUEST_WAITING_FINAL_LINE);

  const title = screen.getByText(data.meeting.title);
  const orb = screen.container.querySelector(".workspace-thinking-signal");
  const ended = {
    ...data,
    meeting: { ...data.meeting, status: "ended" as const, endedAt: now },
    inProgressConclusions: [],
  };
  screen.rerender(view(ended));
  assert.equal(screen.queryByText("Rejoin meeting"), null);
  assert.equal(screen.getByText("Preparing your notes").textContent, "Preparing your notes");
  assert.equal(screen.getByText(data.meeting.title), title);
  assert.equal(screen.container.querySelector(".workspace-thinking-signal"), orb);
  assert.equal(screen.container.querySelector(".live-end-meeting-overlay"), null);

  const ready = {
    ...ended,
    summary: {
      id: userId,
      meetingId,
      content: "Overview\n- Launch the customer pilot on Tuesday.",
      model: "test",
      generatedAt: now,
    },
    tasksStatus: {
      status: "generating" as const,
      phase: "finding_followups",
      error: null,
      isTerminal: false,
      isCurrent: true,
      tasks: null,
      progress: null,
    },
  };
  screen.rerender(view(ready));
  await advance(GUEST_NOTES_TASKS_PHASE_REVEAL_MS);
  assert.equal(screen.queryByText("Tasks"), null);
  assert.equal(screen.queryByText("Create an account"), null);
  screen.rerender(view({ ...ready, tasksStatus: { ...ready.tasksStatus, status: "completed", isTerminal: true } }));
  assert.notEqual(screen.queryByText("No tasks"), null);
  await advance(0);
  assert.equal(screen.getByText("Create an account").textContent, "Create an account");
  assert.equal(screen.container.querySelector(".guest-notes-topbar a"), null);
});

void test("direct visits and refreshes show finalized notes immediately without the entrance overlay", () => {
  window.sessionStorage.clear();
  const client = new QueryClient();
  const data = notes();
  data.meeting.status = "ended";
  data.summary = {
    id: userId,
    meetingId,
    content: "Overview\n- Launch the customer pilot on Tuesday.",
    model: "test",
    generatedAt: now,
  };
  const view = () => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <GuestNotesExperience
          meetingId={meetingId}
          notes={data}
          error={null}
          currentUserId={userId}
          signupHref="/signup"
          signupAction={<a href="/signup">Create an account</a>}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
  try {
    [0, 1].forEach(() => {
      const screen = render(view());
      assert.equal(screen.container.querySelector(".live-end-meeting-overlay"), null);
      assert.equal(screen.container.querySelector(".guest-notes-reveal")?.getAttribute("aria-hidden"), "false");
      assert.ok(screen.container.querySelector(".workspace-flow-snapshot-notes.is-static"));
      assert.equal(
        screen.getByText("Launch the customer pilot on Tuesday.").textContent,
        "Launch the customer pilot on Tuesday.",
      );
      screen.unmount();
    });
  } finally {
    cleanup();
    client.clear();
  }
});

void test("a finalized fallback message remains visible to an authorized guest", (t) => {
  window.sessionStorage.clear();
  const client = new QueryClient();
  t.after(() => {
    cleanup();
    client.clear();
  });
  const data = notes();
  const content = "Meeting notes could not be generated automatically. The transcript is available for review.";
  const screen = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <GuestNotesExperience
          meetingId={meetingId}
          notes={{
            ...data,
            meeting: { ...data.meeting, status: "ended", endedAt: now },
            meetingRuntime: { ...data.meetingRuntime, isAwaitingMeetingEnd: false },
            summary: { id: userId, meetingId, content, model: "fallback-summary-v1", generatedAt: now },
          }}
          error={null}
          currentUserId={userId}
          signupHref="/signup"
          signupAction={<a href="/signup">Create an account</a>}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  assert.notEqual(screen.getByText(content), null);
  assert.equal(screen.queryByText("Preparing your notes"), null);
});

[
  {
    name: "a summary that starts with Action items",
    content: "Action items\n- Sam: send the brief.\n\nOverview\n- Beta ships Friday.",
    expected: "Beta ships Friday.",
  },
  {
    name: "a summary that is only a task section",
    content: "Tasks\n- Sam: send the brief.",
    expected: "No notes were captured for this meeting.",
  },
  { name: "an empty summary", content: "", expected: "No notes were captured for this meeting." },
].forEach(({ name, content, expected }) => {
  void test(`${name} resolves for a guest without repeating the tasks inside the notes`, (t) => {
    window.sessionStorage.clear();
    const client = new QueryClient();
    t.after(() => {
      cleanup();
      client.clear();
    });
    const data = notes();
    const screen = render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <GuestNotesExperience
            meetingId={meetingId}
            notes={{
              ...data,
              meeting: { ...data.meeting, status: "ended", endedAt: now },
              meetingRuntime: { ...data.meetingRuntime, isAwaitingMeetingEnd: false },
              summary: { id: userId, meetingId, content, model: "test", generatedAt: now },
              tasksStatus: {
                status: "completed",
                phase: "finding_followups",
                error: null,
                isTerminal: true,
                isCurrent: true,
                tasks: null,
                progress: null,
              },
            }}
            error={null}
            currentUserId={userId}
            signupHref="/signup"
            signupAction={<a href="/signup">Create an account</a>}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const overview = screen.container.querySelector(".guest-notes-content")?.textContent ?? "";
    assert.equal(overview.includes(expected), true, overview);
    assert.equal(overview.includes("Sam: send the brief."), false, overview);
    assert.equal(overview.includes("Preparing your notes"), false, overview);
    // Empty notes have nothing to reveal, so the tasks section follows immediately.
    assert.equal(
      Boolean(screen.container.querySelector(".workspace-tasks-card")),
      expected === "No notes were captured for this meeting.",
      "the tasks section follows empty notes",
    );
  });
});
