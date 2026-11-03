import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ConnectionState, ParticipantKind, type Room, type RpcInvocationData } from "livekit-client";
import assert from "node:assert/strict";
import { registerHooks, type ResolveHookSync } from "node:module";
import test, { after } from "node:test";

GlobalRegistrator.register();
after(() => GlobalRegistrator.unregister());

const resolveCss: ResolveHookSync = (specifier, context, nextResolve) =>
  specifier.endsWith(".module.css")
    ? { shortCircuit: true, url: "data:text/javascript,export default {};" }
    : nextResolve(specifier, context);
const css = registerHooks({ resolve: resolveCss });
const {
  runLiveMeetingLinearActionPanelRpcEffect,
  runLiveMeetingMeetingAnswerResultsRpcEffect,
  runLiveMeetingRoomRpcMethodRegistrationEffect,
} = await import("../../../presentation/components/live-meeting-page");
css.deregister();

type RpcRoom = Pick<Room, "remoteParticipants" | "registerRpcMethod" | "unregisterRpcMethod">;
type RpcHandler = (data: RpcInvocationData) => Promise<string>;

const MEETING_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_MEETING_ID = "00000000-0000-4000-8000-000000000000";
const AGENT_IDENTITY = "readymeet-assistant-AJ_123";
const MEMBER_IDENTITY = "f4d0d24c-b5f8-4903-903f-238973e631f1:browser";
const TRANSCRIBER_IDENTITY = "readymeet-transcriber-1";
const IGNORED = JSON.stringify({ status: "ignored" });
const SHOWN = JSON.stringify({ status: "shown" });
const RESPONSE_TIMEOUT_MS = 10_000;

function isRpcRoom(value: object): value is RpcRoom {
  return "remoteParticipants" in value && "registerRpcMethod" in value && "unregisterRpcMethod" in value;
}

function fakeRoom(): { room: RpcRoom; handlers: Map<string, RpcHandler> } {
  const handlers = new Map<string, RpcHandler>();
  const remoteParticipants = new Map<string, object>([
    [AGENT_IDENTITY, { identity: AGENT_IDENTITY, kind: ParticipantKind.AGENT, attributes: {} }],
    // A signed-in member can set their own attributes, including assistantRole.
    [
      MEMBER_IDENTITY,
      { identity: MEMBER_IDENTITY, kind: ParticipantKind.STANDARD, attributes: { assistantRole: "meeting-agent" } },
    ],
    // Another agent-kind participant (such as a transcription worker) is not the assistant.
    [TRANSCRIBER_IDENTITY, { identity: TRANSCRIBER_IDENTITY, kind: ParticipantKind.AGENT, attributes: {} }],
  ]);
  const room = {
    remoteParticipants,
    registerRpcMethod: (...args: [method: string, handler: RpcHandler]) => {
      const [method, handler] = args;
      handlers.set(method, handler);
    },
    unregisterRpcMethod: (method: string) => {
      handlers.delete(method);
    },
  };
  assert.ok(isRpcRoom(room));

  return { room, handlers };
}

async function invoke(input: {
  handlers: Map<string, RpcHandler>;
  method: string;
  callerIdentity: string;
  payload: object;
}): Promise<string> {
  const handler = input.handlers.get(input.method);
  assert.ok(handler, `${input.method} is registered`);

  return handler({
    requestId: "request-1",
    callerIdentity: input.callerIdentity,
    payload: JSON.stringify(input.payload),
    responseTimeout: RESPONSE_TIMEOUT_MS,
  });
}

["readymeet.web_search.show_results", "readymeet.tools.request_connection"].forEach((method) => {
  void test(`${method} only opens a panel for the meeting assistant`, async () => {
    const { room, handlers } = fakeRoom();
    const calls: { shown: string[] } = { shown: [] };
    runLiveMeetingRoomRpcMethodRegistrationEffect({
      room,
      connectionState: ConnectionState.Connected,
      rpcMethod: method,
      meetingId: MEETING_ID,
      handleRpcInvocation: async ({ payload }) => {
        calls.shown = [...calls.shown, payload];

        return { status: "shown" };
      },
    });
    const payload = { status: "completed", contentKind: "meeting-answer", meetingId: MEETING_ID, answer: "Wire $40k" };

    assert.equal(await invoke({ handlers, method, callerIdentity: MEMBER_IDENTITY, payload }), IGNORED);
    assert.equal(await invoke({ handlers, method, callerIdentity: TRANSCRIBER_IDENTITY, payload }), IGNORED);
    assert.equal(await invoke({ handlers, method, callerIdentity: "not-in-room", payload }), IGNORED);
    assert.equal(
      await invoke({
        handlers,
        method,
        callerIdentity: AGENT_IDENTITY,
        payload: { ...payload, meetingId: OTHER_MEETING_ID },
      }),
      IGNORED,
    );
    assert.deepEqual(calls.shown, []);

    assert.equal(await invoke({ handlers, method, callerIdentity: AGENT_IDENTITY, payload }), SHOWN);
    assert.deepEqual(calls.shown, [JSON.stringify(payload)]);
  });
});

void test("Linear action panels only open for the meeting assistant", async () => {
  const { room, handlers } = fakeRoom();
  const calls: { shown: string[] } = { shown: [] };
  runLiveMeetingLinearActionPanelRpcEffect({
    room,
    meetingId: MEETING_ID,
    showLinearActionPanelFromVoice: async (payloadText) => {
      calls.shown = [...calls.shown, payloadText];

      return { status: "shown" };
    },
  });
  const method = "readymeet.linear.show_action";
  const payload = { status: "pending", meetingId: MEETING_ID, actionName: "create_issue" };

  assert.equal(await invoke({ handlers, method, callerIdentity: MEMBER_IDENTITY, payload }), IGNORED);
  assert.deepEqual(calls.shown, []);
  assert.equal(await invoke({ handlers, method, callerIdentity: AGENT_IDENTITY, payload }), SHOWN);
  assert.equal(calls.shown.length, 1);
});

void test("meeting answers ignore a member who claims the assistant role attribute", async () => {
  const { room, handlers } = fakeRoom();
  const calls: { shown: string[] } = { shown: [] };
  runLiveMeetingMeetingAnswerResultsRpcEffect({
    room,
    meeting: { id: MEETING_ID },
    showWebSearchPanelFromVoice: async (payload) => {
      calls.shown = [...calls.shown, payload];

      return { status: "shown" };
    },
  });
  const method = "readymeet.meeting_answer.show_results";
  const payload = {
    status: "completed",
    contentKind: "meeting-answer",
    query: "What did we decide?",
    meetingId: MEETING_ID,
    answer: "We agreed to ship on Friday.",
  };

  assert.equal(await invoke({ handlers, method, callerIdentity: MEMBER_IDENTITY, payload }), IGNORED);
  assert.deepEqual(calls.shown, []);
  assert.equal(await invoke({ handlers, method, callerIdentity: AGENT_IDENTITY, payload }), SHOWN);
  assert.equal(calls.shown.length, 1);
});
