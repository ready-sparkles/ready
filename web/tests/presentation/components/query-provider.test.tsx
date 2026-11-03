import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import { useEffect, useState } from "react";

import {
  readMeetingPreparationHandoff,
  writeModelMeetingPreparationHandoff,
} from "../../../composition/meeting-preparation";
import { meetingDetailQueryKey } from "../../../domain/query-keys";
import { ReadyQueryScope } from "../../../presentation/components/query-provider";

const COPY_ACCOUNT_A_PRIVATE_NOTES = "Account A private notes";
const COPY_AWAITING_AUTHORIZED_NOTES = "Awaiting authorized notes";
const COPY_LATE_PRIVATE_NOTES = "Late private notes";
const ERROR_EXPECTED_BOTH_ACCOUNT_QUERY_CLIENTS = "Expected both account query clients";
const LABEL_NAME = "Name";
const GUEST_NAME_SAM = "Personbr";
const BUTTON_ENTER_NAME = "Enter name";
const BUTTON_END_MEETING = "End meeting";
const COPY_MEETING_ENDED = "The meeting has ended. You can join again when you’re ready.";
const ASSERT_GUEST_CREATION_MUST_NOT_STOP_MOUNTED_PREVIEW_RESOURCES =
  "guest creation must not stop mounted preview resources";
const ERROR_EXPECTED_THE_GUEST_QUERY_CLIENT = "Expected the guest query client";
const ASSERT_GUEST_CLEARING_MUST_NOT_REMOUNT_THE_WAITING_ROOM = "guest clearing must not remount the waiting room";
const ASSERT_UNSIGNED_VIEWS_KEEP_BOTH_THEIR_CLIENT_AND_QUERY_OBSERVERS =
  "unsigned views keep both their client and query observers";
const ERROR_EXPECTED_AN_ACTIVE_QUERY_CLIENT = "Expected an active query client";
const QUERY_FN_RESULT = "result";
const ASSERT_MOUNTED_OBSERVER_AND_PROVIDER_MUST_USE_THE_SAME_CLIENT =
  "mounted observer and provider must use the same client";
const CLIENT_KEY_ANONYMOUS = "anonymous";

function assertInputValue({ element, expected }: { element: HTMLElement; expected: string }): void {
  if (!(element instanceof HTMLInputElement)) {
    assert.fail("Expected an HTMLInputElement");
  }
  assert.equal(element.value, expected);
}

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

["notes", "memory"].forEach((family) => {
  void test(`${family}: account switches isolate cached data and reset retained component state`, async (t) => {
    // IndexedDB is intentionally unavailable in this test browser.
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "warn", () => {});
    const key =
      family === "notes" ? meetingDetailQueryKey("meeting") : ["relationship-memory", "a", "workspace", "people"];
    const clients = new Map<string, QueryClient>();
    const rendered: { entries: string[] } = { entries: [] };
    function Notes({ userId }: { userId: string | null }) {
      const client = useQueryClient();
      clients.set(userId ?? CLIENT_KEY_ANONYMOUS, client);
      if (userId === "a" && client.getQueryData(key) === undefined) {
        client.setQueryData(key, COPY_ACCOUNT_A_PRIVATE_NOTES);
      }
      const [retained] = useState(() => client.getQueryData<string>(key));
      const value = retained ?? client.getQueryData<string>(key) ?? COPY_AWAITING_AUTHORIZED_NOTES;
      rendered.entries = rendered.entries.concat(`${userId ?? "null"}:${value}`);

      return <div>{value}</div>;
    }
    const view = (userId: string | null) => (
      <ReadyQueryScope userId={userId} workspaceId="workspace">
        <Notes userId={userId} />
      </ReadyQueryScope>
    );
    const screen = render(view("a"));
    try {
      await act(async () => {});
      assert.equal(screen.getByText(COPY_ACCOUNT_A_PRIVATE_NOTES).textContent, COPY_ACCOUNT_A_PRIVATE_NOTES);
      screen.rerender(view("b"));
      await act(async () => {});
      assert.equal(screen.queryByText(COPY_ACCOUNT_A_PRIVATE_NOTES), null);
      assert.equal(screen.getByText(COPY_AWAITING_AUTHORIZED_NOTES).textContent, COPY_AWAITING_AUTHORIZED_NOTES);
      assert.notEqual(clients.get("a"), clients.get("b"));
      // A late callback from the old session can only write into its old client.
      const accountA = clients.get("a");
      const accountB = clients.get("b");
      if (accountA === undefined || accountB === undefined) {
        throw new Error(ERROR_EXPECTED_BOTH_ACCOUNT_QUERY_CLIENTS);
      }
      accountA.setQueryData(key, COPY_LATE_PRIVATE_NOTES);
      assert.equal(accountB.getQueryData(key), undefined);
      screen.rerender(view("b"));
      assert.equal(screen.queryByText(COPY_LATE_PRIVATE_NOTES), null);
      screen.rerender(view(null));
      await act(async () => {});
      assert.notEqual(clients.get(CLIENT_KEY_ANONYMOUS), clients.get("b"));
      assert.ok(
        rendered.entries
          .filter((value) => value.startsWith("b:") || value.startsWith("null:"))
          .every((value) => value.endsWith(COPY_AWAITING_AUTHORIZED_NOTES)),
      );
    } finally {
      cleanup();
      [...clients.values()].forEach((client) => {
        client.clear();
      });
    }
  });
});

void test("meeting preparation handoffs remove legacy plaintext and rely on a server refetch", () => {
  const lines = ["Pricing remains the central rollout constraint."];
  window.sessionStorage.setItem("readymeet-workspace-end-meeting-preparation", JSON.stringify({ lines }));
  writeModelMeetingPreparationHandoff("meeting", { lines, source: "model" }, "a");
  assert.equal(readMeetingPreparationHandoff("meeting", "a"), null);
  assert.equal(window.sessionStorage.getItem("readymeet-workspace-end-meeting-preparation"), null);
  window.sessionStorage.clear();
});

void test("creating and clearing a guest session preserves waiting-room state and mounted resources", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const lifecycle = { mounts: 0, cleanups: 0 };
  const clients = new Map<string, QueryClient>();
  function WaitingRoom({ userId }: { userId: string | null }) {
    clients.set(userId ?? CLIENT_KEY_ANONYMOUS, useQueryClient());
    const [name, setName] = useState("");
    const [hasEnded, setHasEnded] = useState(false);
    useEffect(() => {
      lifecycle.mounts += 1;

      return () => {
        lifecycle.cleanups += 1;
      };
    }, []);

    return (
      <>
        <input aria-label={LABEL_NAME} value={name} readOnly />
        <button onClick={() => setName(GUEST_NAME_SAM)}>{BUTTON_ENTER_NAME}</button>
        <button onClick={() => setHasEnded(true)}>{BUTTON_END_MEETING}</button>
        {hasEnded ? <div>{COPY_MEETING_ENDED}</div> : null}
      </>
    );
  }
  const view = (userId: string | null) => (
    <ReadyQueryScope userId={null} workspaceId={null}>
      <WaitingRoom userId={userId} />
    </ReadyQueryScope>
  );
  const screen = render(view(null));
  try {
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: BUTTON_ENTER_NAME }));
    assertInputValue({ element: screen.getByLabelText(LABEL_NAME), expected: GUEST_NAME_SAM });
    screen.rerender(view("guest-a"));
    await act(async () => {});
    assertInputValue({ element: screen.getByLabelText(LABEL_NAME), expected: GUEST_NAME_SAM });
    assert.equal(lifecycle.mounts, 1);
    assert.equal(lifecycle.cleanups, 0, ASSERT_GUEST_CREATION_MUST_NOT_STOP_MOUNTED_PREVIEW_RESOURCES);
    const guestClient = clients.get("guest-a");
    if (guestClient === undefined) {
      throw new Error(ERROR_EXPECTED_THE_GUEST_QUERY_CLIENT);
    }
    fireEvent.click(screen.getByRole("button", { name: BUTTON_END_MEETING }));
    screen.rerender(view(null));
    await act(async () => {});
    assert.equal(screen.getByText(COPY_MEETING_ENDED).textContent, COPY_MEETING_ENDED);
    assertInputValue({ element: screen.getByLabelText(LABEL_NAME), expected: GUEST_NAME_SAM });
    assert.equal(lifecycle.mounts, 1);
    assert.equal(lifecycle.cleanups, 0, ASSERT_GUEST_CLEARING_MUST_NOT_REMOUNT_THE_WAITING_ROOM);
    assert.equal(
      clients.get(CLIENT_KEY_ANONYMOUS),
      guestClient,
      ASSERT_UNSIGNED_VIEWS_KEEP_BOTH_THEIR_CLIENT_AND_QUERY_OBSERVERS,
    );
  } finally {
    cleanup();
    [...clients.values()].forEach((client) => {
      client.clear();
    });
  }
});

void test("guest transitions keep query observers attached to the active cache", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  const observed: { client: QueryClient | undefined } = { client: undefined };
  const seenClients = new Set<QueryClient>();
  function QueryConsumer({ userId }: { userId: string | null }) {
    observed.client = useQueryClient();
    seenClients.add(observed.client);
    useQuery({
      queryKey: ["guest-observer-probe", userId],
      queryFn: async () => QUERY_FN_RESULT,
      enabled: false,
      gcTime: 0,
    });

    return null;
  }
  const view = (userId: string | null) => (
    <ReadyQueryScope userId={null} workspaceId={null}>
      <QueryConsumer userId={userId} />
    </ReadyQueryScope>
  );
  const screen = render(view(null));
  try {
    await act(async () => {});
    if (observed.client === undefined) {
      throw new Error(ERROR_EXPECTED_AN_ACTIVE_QUERY_CLIENT);
    }
    assert.ok(observed.client.getQueryState(["guest-observer-probe", null]));
    screen.rerender(view("guest-a"));
    await act(async () => {});
    assert.ok(
      observed.client.getQueryState(["guest-observer-probe", "guest-a"]),
      ASSERT_MOUNTED_OBSERVER_AND_PROVIDER_MUST_USE_THE_SAME_CLIENT,
    );
  } finally {
    cleanup();
    [...seenClients].forEach((client) => {
      client.clear();
    });
  }
});
