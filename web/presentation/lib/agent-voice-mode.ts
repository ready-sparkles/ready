import { ConnectionState, type Participant, ParticipantKind, type Room } from "livekit-client";

import { stopConversationAckSchema } from "../../domain/schemas/agent-voice-mode";

const LINT_NUM_N5_000 = 5_000;
const LINT_NUM_N2 = 2;
const LINT_NUM_N250 = 250;

export const START_CONVERSATION_MODE_RPC = "start_conversation_mode";
export const STOP_CONVERSATION_MODE_RPC = "stop_conversation_mode";
const VOICE_STOP_NOT_ACKNOWLEDGED = "Voice stop was not acknowledged";

function stopConversationAcknowledged(response: string): boolean {
  if (response === "ignored") {
    return true;
  }
  try {
    const validated = stopConversationAckSchema.safeParse(JSON.parse(response));
    if (!validated.success) {
      return false;
    }

    return !validated.data.conversationModeActive;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return false;
  }
}

export type VoiceModePendingAction = "starting" | "stopping" | null;

type VoiceModeControlState = {
  action: "none" | "start" | "stop";
  ariaLabel: string;
  /** @external voice mode control wire field */
  disabled: boolean;
  /** @external voice mode control wire field */
  pressed: boolean;
};

export function getVoiceModeControlState(input: {
  /** @external voice mode wire field */
  conversationModeActive: boolean;
  localParticipantIdentity: string | null;
  ownerParticipantIdentity: string | null;
  pendingAction: VoiceModePendingAction;
}): VoiceModeControlState {
  const { localParticipantIdentity, ownerParticipantIdentity, pendingAction } = input;
  if (pendingAction === "starting") {
    return {
      action: "none" as const,
      ariaLabel: "Starting voice chat with Ready",
      /** @external voice mode control wire field */
      disabled: false,
      /** @external voice mode control wire field */
      pressed: true,
    };
  }

  if (pendingAction === "stopping") {
    return {
      action: "none" as const,
      ariaLabel: "Ending voice chat with Ready",
      /** @external voice mode control wire field */
      disabled: false,
      /** @external voice mode control wire field */
      pressed: false,
    };
  }

  if (!input.conversationModeActive) {
    return {
      action: "start" as const,
      ariaLabel: "Voice chat with Ready",
      /** @external voice mode control wire field */
      disabled: false,
      /** @external voice mode control wire field */
      pressed: false,
    };
  }

  if (
    localParticipantIdentity !== null &&
    localParticipantIdentity !== "" &&
    ownerParticipantIdentity === localParticipantIdentity
  ) {
    return {
      action: "stop" as const,
      ariaLabel: "End voice chat with Ready",
      /** @external voice mode control wire field */
      disabled: false,
      /** @external voice mode control wire field */
      pressed: true,
    };
  }

  return {
    action: "none" as const,
    ariaLabel: "Voice chat with Ready is in use by another participant",
    /** @external voice mode control wire field */
    disabled: true,
    /** @external voice mode control wire field */
    pressed: true,
  };
}

// A visitor invalidates the request, even when join/leave renders are batched.
export function createVoiceModeIntent(): {
  begin(isActive: boolean): number;
  invalidate(): void;
  deactivate(): void;
  canActivate(): boolean;
  isCurrent(requestRevision: number): boolean;
} {
  const state = { revision: 0, isRequested: false };

  return {
    begin(isActive: boolean) {
      state.isRequested = isActive;
      state.revision += 1;

      return state.revision;
    },
    invalidate() {
      state.isRequested = false;
      state.revision += 1;
    },
    deactivate() {
      state.isRequested = false;
    },
    canActivate() {
      return state.isRequested;
    },
    isCurrent(requestRevision: number) {
      return requestRevision === state.revision;
    },
  };
}

// Participant kind is server-assigned. Attributes are not: signed-in callers
// can set their own, so they must never hide a caller from this gate.
export function isSoloVoiceAvailable(room: Pick<Room, "state" | "remoteParticipants"> | null): boolean {
  return Boolean(
    room &&
    (room.state === ConnectionState.Connected || room.state === ConnectionState.SignalReconnecting) &&
    !Array.from(room.remoteParticipants.values()).some((participant) => participant.kind !== ParticipantKind.AGENT),
  );
}

// Local invalidation never reaches the agent, and an offline blip can resume
// without the server seeing a disconnect. Once connected, ask the agent to stop
// so it cannot keep talking behind an "off" button; it ignores the request when
// voice mode has already ended.
export function createOwedVoiceStop(
  ...args: [
    room: Pick<Room, "state" | "remoteParticipants" | "localParticipant">,
    isAgent: (participant: Participant) => boolean,
  ]
): {
  owe(): void;
  hasPending(): boolean;
  settle(): Promise<boolean>;
} {
  const [room, isAgent] = args;
  const state = { isOwed: false };
  const flight: { current: Promise<boolean> | null } = { current: null };
  const attemptStop = async (attempt: number): Promise<boolean> => {
    if (room.state !== ConnectionState.Connected) {
      return false;
    }
    const agent = Array.from(room.remoteParticipants.values()).find(isAgent);
    if (!agent) {
      return false;
    }
    try {
      const response = await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: STOP_CONVERSATION_MODE_RPC,
        payload: "",
        responseTimeout: LINT_NUM_N5_000,
      });
      if (!stopConversationAcknowledged(response)) {
        throw new Error(VOICE_STOP_NOT_ACKNOWLEDGED);
      }
      state.isOwed = false;

      return true;
    } catch (error) {
      const shouldRetry = (attempt < LINT_NUM_N2 && error !== null) || (attempt < LINT_NUM_N2 && error === null);
      if (shouldRetry) {
        await new Promise((resolve) => {
          setTimeout(resolve, LINT_NUM_N250 * (attempt + 1));
        });

        return attemptStop(attempt + 1);
      }

      return false;
    }
  };
  const settle = (): Promise<boolean> => {
    if (!state.isOwed) {
      return Promise.resolve(true);
    }
    if (flight.current) {
      return flight.current;
    }
    const pending = attemptStop(0).finally(() => {
      flight.current = null;
    });
    flight.current = pending;

    return pending;
  };

  return {
    owe() {
      state.isOwed = true;
      void settle();
    },
    hasPending() {
      return state.isOwed;
    },
    settle,
  };
}
