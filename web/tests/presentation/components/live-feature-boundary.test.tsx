import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, fireEvent, render } from "@testing-library/react";
import assert from "node:assert/strict";
import test from "node:test";
import { type ReactNode, useEffect, useState } from "react";

import { LiveFeatureBoundary } from "../../../presentation/components/live-feature-boundary";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const LIVE_FEATURE_RENDER_FAILURE_MESSAGE = "Live meeting feature failed.";

function ThrowingLiveFeature(): ReactNode {
  throw new Error(LIVE_FEATURE_RENDER_FAILURE_MESSAGE);
}

function LiveMeetingFeatureIsolationHarness(props: { disconnect: () => void }): ReactNode {
  return (
    <section data-readymeet-meeting-room="true">
      <audio data-readymeet-audio-sink="true" />
      <LiveFeatureBoundary feature="captions">
        <ThrowingLiveFeature />
      </LiveFeatureBoundary>
      <button type="button" onClick={props.disconnect}>
        Leave
      </button>
    </section>
  );
}

void test("a feature render failure leaves the meeting room mounted", () => {
  const disconnect = { calls: 0 };
  const consoleError = console.error;
  console.error = () => {};
  try {
    const view = render(
      <LiveMeetingFeatureIsolationHarness
        disconnect={() => {
          disconnect.calls += 1;
        }}
      />,
    );
    assert.equal(view.container.querySelector("[data-readymeet-meeting-room]") !== null, true);
    assert.equal(view.container.querySelector("[data-readymeet-audio-sink]") !== null, true);
    assert.equal(disconnect.calls, 0);
    view.unmount();
  } finally {
    console.error = consoleError;
  }
});

const FEATURE_FAILURE_MESSAGE = "Optional feature failed after connection.";

type RoomDouble = { connections: number; disconnects: number };

function FailingAfterConnectFeature(props: { shouldFail: boolean }): ReactNode {
  if (props.shouldFail) {
    throw new Error(FEATURE_FAILURE_MESSAGE);
  }

  return <span data-readymeet-optional-feature="true" />;
}

// Mirrors the meeting page: the room owner connects on mount and disconnects only when it unmounts.
function RoomOwner(props: { room: RoomDouble; onCatch: () => void }): ReactNode {
  const [isConnected, setIsConnected] = useState(false);
  const [shouldFail, setShouldFail] = useState(false);
  const { room } = props;
  useEffect(() => {
    room.connections += 1;
    setIsConnected(true);

    return () => {
      room.disconnects += 1;
    };
  }, [room]);

  return (
    <section data-readymeet-meeting-room={isConnected ? "connected" : "connecting"}>
      <LiveFeatureBoundary feature="captions" onCatch={props.onCatch}>
        <FailingAfterConnectFeature shouldFail={shouldFail} />
      </LiveFeatureBoundary>
      <button type="button" onClick={() => setShouldFail(true)}>
        Fail feature
      </button>
      <button
        type="button"
        onClick={() => {
          room.disconnects += 1;
        }}
      >
        Leave
      </button>
    </section>
  );
}

void test("a feature failing after connection does not tear down the connected room", () => {
  const room: RoomDouble = { connections: 0, disconnects: 0 };
  const caught = { count: 0 };
  const consoleError = console.error;
  console.error = () => {};
  try {
    const view = render(
      <RoomOwner
        room={room}
        onCatch={() => {
          caught.count += 1;
        }}
      />,
    );
    assert.equal(view.container.querySelector('[data-readymeet-meeting-room="connected"]') !== null, true);
    act(() => {
      fireEvent.click(view.getByText("Fail feature"));
    });
    assert.equal(caught.count, 1);
    assert.equal(view.container.querySelector("[data-readymeet-optional-feature]"), null);
    assert.equal(view.container.querySelector('[data-readymeet-meeting-room="connected"]') !== null, true);
    assert.equal(room.connections, 1);
    assert.equal(room.disconnects, 0);
    fireEvent.click(view.getByText("Leave"));
    assert.equal(room.disconnects, 1);
    view.unmount();
  } finally {
    console.error = consoleError;
  }
});
