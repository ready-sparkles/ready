import { assistantEnv } from "../../../ports/assistant-env";
import { repositories } from "../../../ports/repository-runtime";

import { ParticipantInfo_Kind as ParticipantInfoKind } from "./protocol";
import { AgentDispatchClient, type ParticipantInfo, RoomServiceClient } from "./server-sdk";

const LIVEKIT_ROOM_ASSISTANT_IDENTITY_PREFIX = "readymeet-assistant";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 250;

const LIVEKIT_DISPATCH_MESSAGES = {
  missingConfig: "Assistant missing LiveKit config. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.",
  meetingNotFound: "Meeting not found",
} as const;

type DispatchMetadata = {
  meetingId: string;
};

function requireLiveKitConfig(): void {
  const livekitUrl = assistantEnv().LIVEKIT_URL;
  const apiKey = assistantEnv().LIVEKIT_API_KEY;
  const apiSecret = assistantEnv().LIVEKIT_API_SECRET;
  if (
    livekitUrl === undefined ||
    livekitUrl === "" ||
    apiKey === undefined ||
    apiKey === "" ||
    apiSecret === undefined ||
    apiSecret === ""
  ) {
    throw new Error(LIVEKIT_DISPATCH_MESSAGES.missingConfig);
  }
}

function toServiceHost(livekitUrl: string): string {
  return livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeoutId = setTimeout(resolve, ms);
    timeoutId.unref();
  });
}

function isManagedAgentParticipant(input: { identityPrefix: string; participant: ParticipantInfo }): boolean {
  return (
    input.participant.kind === ParticipantInfoKind.AGENT &&
    input.participant.identity.startsWith(`${input.identityPrefix}-`)
  );
}

const PENDING_DISPATCH_GRACE_MS = 30_000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/** LiveKit reports dispatch createdAt as Unix nanoseconds. */
function isRecentDispatch(createdAt: bigint | undefined): boolean {
  if (createdAt === undefined || createdAt === BigInt(0)) {
    return false;
  }

  return Date.now() - Number(createdAt / NANOSECONDS_PER_MILLISECOND) < PENDING_DISPATCH_GRACE_MS;
}

class LiveKitDispatchManager {
  /** Per-room in-flight create, so concurrent joins (e.g. two tabs) cannot both create a dispatch. */
  private readonly pendingCreates = new Map<string, Promise<boolean>>();

  constructor(
    private readonly config: {
      agentName: string;
      identityPrefix: string;
    },
  ) {}

  async createIfMissing(input: { roomName: string; metadata: DispatchMetadata }): Promise<boolean> {
    const pending = this.pendingCreates.get(input.roomName);
    if (pending !== undefined) {
      await pending;

      return false;
    }
    const created = this.createIfMissingNow(input);
    this.pendingCreates.set(input.roomName, created);
    try {
      return await created;
    } finally {
      if (this.pendingCreates.get(input.roomName) === created) {
        this.pendingCreates.delete(input.roomName);
      }
    }
  }

  async deleteForRoom(input: { roomName: string }): Promise<boolean> {
    const dispatchClient = this.createDispatchClient();
    const dispatches = await this.listRoomDispatches({ roomName: input.roomName });
    const relevantDispatches = dispatches.filter((dispatch) => dispatch.agentName === this.config.agentName);

    await Promise.all(relevantDispatches.map((dispatch) => dispatchClient.deleteDispatch(dispatch.id, dispatch.room)));

    return relevantDispatches.length !== 0;
  }

  async waitForDrain(input: { roomName: string; timeoutMs?: number }): Promise<boolean> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

    return this.waitUntilManagedAgentsDrain({
      roomName: input.roomName,
      deadlineMs: Date.now() + timeoutMs,
    });
  }

  private async createIfMissingNow(input: { roomName: string; metadata: DispatchMetadata }): Promise<boolean> {
    const dispatchClient = this.createDispatchClient();
    const dispatches = await this.listRoomDispatches({ roomName: input.roomName });
    const relevantDispatches = dispatches.filter((dispatch) => dispatch.agentName === this.config.agentName);
    const existingDispatch = relevantDispatches[0];

    if (existingDispatch !== undefined) {
      // A fresh dispatch whose agent hasn't joined yet is still pending. Recreating
      // it here (e.g. a second tab joining) spawns a duplicate assistant.
      if (isRecentDispatch(existingDispatch.state?.createdAt)) {
        return false;
      }
      const participants = await this.listRoomParticipants({ roomName: input.roomName });
      const hasManagedParticipant = participants.some((participant) =>
        isManagedAgentParticipant({ identityPrefix: this.config.identityPrefix, participant }),
      );

      if (hasManagedParticipant) {
        return false;
      }

      await this.deleteDispatchesIgnoringErrors({ dispatches: relevantDispatches });
    }

    await dispatchClient.createDispatch(input.roomName, this.config.agentName, {
      metadata: JSON.stringify(input.metadata),
    });

    return true;
  }

  private async listRoomParticipants(input: { roomName: string }): Promise<ParticipantInfo[]> {
    const roomServiceClient = this.createRoomServiceClient();
    try {
      return await roomServiceClient.listParticipants(input.roomName);
    } catch (error) {
      void error;

      return [];
    }
  }

  private async listRoomDispatches(input: { roomName: string }) {
    const dispatchClient = this.createDispatchClient();
    try {
      return await dispatchClient.listDispatch(input.roomName);
    } catch (error) {
      void error;

      return [];
    }
  }

  private async deleteDispatchesIgnoringErrors(input: { dispatches: { id: string; room: string }[] }): Promise<void> {
    const dispatchClient = this.createDispatchClient();
    await Promise.all(
      input.dispatches.map(async (dispatch) => {
        try {
          await dispatchClient.deleteDispatch(dispatch.id, dispatch.room);
        } catch (error) {
          void error;

          return undefined;
        }
      }),
    );
  }

  private async waitUntilManagedAgentsDrain(input: { roomName: string; deadlineMs: number }): Promise<boolean> {
    const participants = await this.listRoomParticipants({ roomName: input.roomName });
    const hasManagedParticipant = participants.some((participant) =>
      isManagedAgentParticipant({ identityPrefix: this.config.identityPrefix, participant }),
    );
    if (!hasManagedParticipant) {
      return true;
    }
    if (Date.now() >= input.deadlineMs) {
      return false;
    }

    await delay(DRAIN_POLL_INTERVAL_MS);

    return this.waitUntilManagedAgentsDrain(input);
  }

  private createDispatchClient(): AgentDispatchClient {
    const livekitUrl = assistantEnv().LIVEKIT_URL;
    const apiKey = assistantEnv().LIVEKIT_API_KEY;
    const apiSecret = assistantEnv().LIVEKIT_API_SECRET;

    return new AgentDispatchClient(
      toServiceHost(livekitUrl !== undefined && livekitUrl !== "" ? livekitUrl : ""),
      apiKey !== undefined && apiKey !== "" ? apiKey : "",
      apiSecret !== undefined && apiSecret !== "" ? apiSecret : "",
    );
  }

  private createRoomServiceClient(): RoomServiceClient {
    const livekitUrl = assistantEnv().LIVEKIT_URL;
    const apiKey = assistantEnv().LIVEKIT_API_KEY;
    const apiSecret = assistantEnv().LIVEKIT_API_SECRET;

    return new RoomServiceClient(
      toServiceHost(livekitUrl !== undefined && livekitUrl !== "" ? livekitUrl : ""),
      apiKey !== undefined && apiKey !== "" ? apiKey : "",
      apiSecret !== undefined && apiSecret !== "" ? apiSecret : "",
    );
  }
}

interface LiveKitMeetingDispatchStartResult {
  /** @external started */
  started: boolean;
}

interface LiveKitMeetingDispatchStopResult {
  /** @external stopped */
  stopped: boolean;
  /** @external drained */
  drained: boolean;
}

export class LiveKitRoomAssistantDispatchManager {
  readonly agentName: string;
  private readonly dispatchManager: LiveKitDispatchManager;

  constructor(agentName = assistantEnv().LIVEKIT_ROOM_ASSISTANT_NAME) {
    this.agentName = agentName;
    this.dispatchManager = new LiveKitDispatchManager({
      agentName,
      identityPrefix: LIVEKIT_ROOM_ASSISTANT_IDENTITY_PREFIX,
    });
  }

  async startMeeting(meetingId: string): Promise<LiveKitMeetingDispatchStartResult> {
    requireLiveKitConfig();

    const meeting = await repositories().getMeetingById(meetingId);
    if (meeting === null) {
      throw new Error(LIVEKIT_DISPATCH_MESSAGES.meetingNotFound);
    }

    const isStarted = await this.dispatchManager.createIfMissing({
      roomName: meeting.roomName,
      metadata: { meetingId },
    });

    return { started: isStarted };
  }

  async stopMeeting(meetingId: string): Promise<LiveKitMeetingDispatchStopResult> {
    requireLiveKitConfig();

    const meeting = await repositories().getMeetingById(meetingId);
    if (meeting === null) {
      throw new Error(LIVEKIT_DISPATCH_MESSAGES.meetingNotFound);
    }

    const isStopped = await this.dispatchManager.deleteForRoom({ roomName: meeting.roomName });
    const isDrained = await this.dispatchManager.waitForDrain({ roomName: meeting.roomName });

    return {
      stopped: isStopped,
      drained: isDrained,
    };
  }
}
