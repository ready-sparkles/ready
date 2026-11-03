import { liveKitRealtimeStartSessionResponseSchema, liveKitRealtimeStopSessionResponseSchema } from "@readymeet/shared";
import type { ZodType } from "zod";

import { assistantEnv } from "../../../ports/assistant-env";
import { repositories } from "../../../ports/repository-runtime";

import { AccessToken } from "./server-sdk";

const MEETING_ID_PREFIX_LENGTH = 8;

const LIVEKIT_TRANSCRIPTION_MESSAGES = {
  missingConfig: "Assistant missing LiveKit config. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.",
  meetingNotFound: "Meeting not found",
  requestTimedOut: (input: { timeoutMs: number }) => `LiveKit realtime request timed out after ${input.timeoutMs}ms`,
  fetchFailedLog: "LiveKit realtime service fetch failed.",
  serviceError: (input: { status: number; message: string }) =>
    `LiveKit realtime service error (${input.status}): ${input.message}`,
  transcriberDisplayName: "ReadyMeet Transcriber",
} as const;

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(LIVEKIT_TRANSCRIPTION_MESSAGES.requestTimedOut({ timeoutMs })));
  }, timeoutMs);
  timeoutId.unref();

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

interface LiveKitTranscriptionStartResult {
  /** @external started */
  started: boolean;
}

interface LiveKitTranscriptionStopResult {
  /** @external stopped */
  stopped: boolean;
  /** @external finalized */
  finalized: boolean;
}

interface LiveKitTranscriptionStopOptions {
  /** @external finalize */
  finalize?: boolean;
  /** @external drain */
  drain?: boolean;
}

export class LiveKitTranscriptionManager {
  async startMeeting(meetingId: string): Promise<LiveKitTranscriptionStartResult> {
    const [meeting, participants] = await Promise.all([
      repositories().getMeetingById(meetingId),
      repositories().listParticipantsForMeeting(meetingId),
    ]);
    if (meeting === null) {
      throw new Error(LIVEKIT_TRANSCRIPTION_MESSAGES.meetingNotFound);
    }

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
      throw new Error(LIVEKIT_TRANSCRIPTION_MESSAGES.missingConfig);
    }

    const participantNames = participants
      .map((participant) => participant.displayName)
      .filter((name) => name.length > 0);
    const participantIdentity = `transcriber-${meetingId.slice(0, MEETING_ID_PREFIX_LENGTH)}`;
    const participantName = LIVEKIT_TRANSCRIPTION_MESSAGES.transcriberDisplayName;
    const token = await this.createTranscriberToken({
      roomName: meeting.roomName,
      participantIdentity,
      participantName,
    });

    return this.request({
      path: `/internal/meetings/${meetingId}/start`,
      init: {
        method: "POST",
        body: JSON.stringify({
          meetingId,
          roomName: meeting.roomName,
          livekitUrl,
          token,
          participantIdentity,
          participantName,
          participantNames,
        }),
      },
      schema: liveKitRealtimeStartSessionResponseSchema,
    });
  }

  async stopMeeting(input: {
    meetingId: string;
    options?: LiveKitTranscriptionStopOptions;
  }): Promise<LiveKitTranscriptionStopResult> {
    const isFinalize = input.options?.finalize;
    const isDrain = input.options?.drain;

    return this.request({
      path: `/internal/meetings/${input.meetingId}/stop`,
      init: {
        method: "POST",
        body: JSON.stringify({
          /** @external finalize */
          finalize: isFinalize,
          /** @external drain */
          drain: isDrain,
        }),
      },
      schema: liveKitRealtimeStopSessionResponseSchema,
      timeoutMs: assistantEnv().LIVEKIT_REALTIME_STOP_REQUEST_TIMEOUT_MS,
    });
  }

  private async request<T>(input: {
    path: string;
    init: RequestInit;
    schema: ZodType<T>;
    timeoutMs?: number;
  }): Promise<T> {
    const timeoutMs = input.timeoutMs ?? assistantEnv().LIVEKIT_REALTIME_REQUEST_TIMEOUT_MS;
    const url = `${assistantEnv().LIVEKIT_REALTIME_SERVICE_URL}${input.path}`;
    const timeout = createTimeoutSignal(timeoutMs);
    const headers = new Headers({
      "content-type": "application/json",
      "x-livekit-realtime-service-secret": assistantEnv().LIVEKIT_REALTIME_SERVICE_SECRET,
    });
    new Headers(input.init.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const response = await (async (): Promise<Response> => {
      try {
        return await fetch(url, { ...input.init, signal: timeout.signal, headers });
      } catch (error) {
        console.error(LIVEKIT_TRANSCRIPTION_MESSAGES.fetchFailedLog, {
          url,
          method: input.init.method ?? "GET",
          errorType: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      } finally {
        timeout.clear();
      }
    })();

    if (!response.ok) {
      const message = await response.text();
      throw new Error(LIVEKIT_TRANSCRIPTION_MESSAGES.serviceError({ status: response.status, message }));
    }

    const responseBody: unknown = await response.json();

    return input.schema.parse(responseBody);
  }

  private async createTranscriberToken(input: {
    roomName: string;
    participantIdentity: string;
    participantName: string;
  }): Promise<string> {
    const apiKey = assistantEnv().LIVEKIT_API_KEY;
    const apiSecret = assistantEnv().LIVEKIT_API_SECRET;
    const token = new AccessToken(
      apiKey !== undefined && apiKey !== "" ? apiKey : "",
      apiSecret !== undefined && apiSecret !== "" ? apiSecret : "",
      {
        identity: input.participantIdentity,
        name: input.participantName,
      },
    );

    token.addGrant({
      roomJoin: true,
      room: input.roomName,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
      hidden: true,
    });

    return token.toJwt();
  }
}
