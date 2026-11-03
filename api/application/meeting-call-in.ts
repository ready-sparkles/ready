import type { CallInDbConnection, RepositoryPort } from "@readymeet/db/ports/repository";
import { randomInt } from "node:crypto";

import { CALL_IN_MEETING_LINK_ATTRIBUTE, callInHoldingRoomPrefix } from "../domain/call-in-holding-room";
import { apiEnv } from "../ports/api-env";
import { createCallInHoldingSipDispatchRule, deleteSipDispatchRule, getSipDispatchRuleId } from "../ports/gate-livekit";
import { repositories } from "../ports/repository-runtime";

import { isPostgresUniqueConstraintError } from "./postgres-constraint";

type LoggerLike = {
  warn(...args: [bindings: Record<string, unknown>, message: string]): void;
};

type MeetingRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingById"]>>>;
type MeetingLinkRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingLinkById"]>>>;
type MeetingLinkCallInRecord = NonNullable<Awaited<ReturnType<RepositoryPort["getMeetingLinkCallIn"]>>>;

const MEETING_LINK_CALL_IN_MEETING_LINK_CONSTRAINT = "meeting_link_call_ins_meeting_link_uidx";
const MEETING_LINK_CALL_IN_PHONE_PIN_CONSTRAINT = "meeting_link_call_ins_phone_pin_uidx";
const PIN_GENERATION_ATTEMPTS = 8;
const MIN_SIX_DIGIT_PIN = 100_000;
const MAX_SIX_DIGIT_PIN_EXCLUSIVE = 1_000_000;
const CALL_IN_RULE_NAME_PREFIX = "Ready call-in ";
const LIVEKIT_SIP_DISPATCH_RULE_ID_MISSING_MESSAGE = "LiveKit did not return a SIP dispatch rule ID";
const FAILED_TO_CREATE_UNIQUE_CALL_IN_PIN_PREFIX = "Failed to create a unique call-in PIN: ";
const MESSAGE_FAILED_TO_SYNC_MEETING_CALL_IN_RULE = "Failed to sync meeting call-in rule";
const MESSAGE_FAILED_TO_EXPIRE_WAITING_CALL_IN_JOIN_REQUESTS =
  "Failed to expire waiting call-in join requests for ended meeting";
const MESSAGE_FAILED_TO_DELETE_MEETING_CALL_IN_SIP_DISPATCH_RULE = "Failed to delete meeting call-in SIP dispatch rule";

function getConfiguredDialInNumber() {
  const phoneNumber = apiEnv().LIVEKIT_DIAL_IN_NUMBER.trim();

  return phoneNumber !== "" ? phoneNumber : null;
}

function generateCallInPin() {
  return randomInt(MIN_SIX_DIGIT_PIN, MAX_SIX_DIGIT_PIN_EXCLUSIVE).toString();
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function swallowCallInFailure(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof Error)) {
      return;
    }
  }
}

function callInRuleName(meetingLink: MeetingLinkRecord) {
  return `${CALL_IN_RULE_NAME_PREFIX}${meetingLink.code}`;
}

function callInRuleMetadata(input: { meeting: MeetingRecord; meetingLink: MeetingLinkRecord }) {
  return {
    source: "ready",
    kind: "meeting-link-call-in",
    meetingId: input.meeting.id,
    meetingLinkId: input.meetingLink.id,
    code: input.meetingLink.code,
  };
}

async function deleteExistingRuleIfNeeded(callIn: MeetingLinkCallInRecord) {
  if (callIn.sipDispatchRuleId === null || callIn.sipDispatchRuleId === "") {
    return;
  }

  await deleteSipDispatchRule(callIn.sipDispatchRuleId);
}

async function createSyncedCallInRule(input: {
  phoneNumber: string;
  pin: string;
  meeting: MeetingRecord;
  meetingLink: MeetingLinkRecord;
}) {
  const rule = await createCallInHoldingSipDispatchRule({
    phoneNumber: input.phoneNumber,
    holdingRoomPrefix: callInHoldingRoomPrefix(input.meetingLink.id),
    pin: input.pin,
    name: callInRuleName(input.meetingLink),
    metadata: callInRuleMetadata(input),
    // Inherited by SIP participants, so the webhook can map a holding-room
    // caller back to the meeting link without parsing the room name.
    attributes: {
      [CALL_IN_MEETING_LINK_ATTRIBUTE]: input.meetingLink.id,
    },
  });
  const sipDispatchRuleId = getSipDispatchRuleId(rule);
  if (sipDispatchRuleId === null || sipDispatchRuleId === "") {
    throw new Error(LIVEKIT_SIP_DISPATCH_RULE_ID_MISSING_MESSAGE);
  }

  return sipDispatchRuleId;
}

async function syncExistingCallIn(input: {
  connection: CallInDbConnection;
  callIn: MeetingLinkCallInRecord;
  phoneNumber: string;
  meeting: MeetingRecord;
  meetingLink: MeetingLinkRecord;
}) {
  if (
    input.callIn.status === "active" &&
    input.callIn.phoneNumber === input.phoneNumber &&
    Boolean(input.callIn.sipDispatchRuleId) &&
    // Legacy 'direct' rules bypass the waiting room; recreate them as
    // holding-room rules even when otherwise in sync.
    input.callIn.dispatchRuleKind === "holding" &&
    input.callIn.lastSyncedMeetingId === input.meeting.id
  ) {
    return input.callIn;
  }

  try {
    await deleteExistingRuleIfNeeded(input.callIn);
  } catch (error) {
    await swallowCallInFailure(
      repositories().markMeetingLinkCallInError(
        {
          id: input.callIn.id,
          lastSyncError: getErrorMessage(error),
        },
        input.connection,
      ),
    );
    throw error;
  }

  await repositories().markMeetingLinkCallInInactive({ id: input.callIn.id }, input.connection);

  const sipDispatchRuleId = await (async () => {
    try {
      return await createSyncedCallInRule({
        phoneNumber: input.phoneNumber,
        pin: input.callIn.pin,
        meeting: input.meeting,
        meetingLink: input.meetingLink,
      });
    } catch (error) {
      await swallowCallInFailure(
        repositories().markMeetingLinkCallInError(
          {
            id: input.callIn.id,
            lastSyncError: getErrorMessage(error),
          },
          input.connection,
        ),
      );
      throw error;
    }
  })();

  try {
    return await repositories().activateMeetingLinkCallIn(
      {
        id: input.callIn.id,
        phoneNumber: input.phoneNumber,
        sipDispatchRuleId,
        dispatchRuleKind: "holding",
        lastSyncedMeetingId: input.meeting.id,
      },
      input.connection,
    );
  } catch (error) {
    await swallowCallInFailure(deleteSipDispatchRule(sipDispatchRuleId));
    await swallowCallInFailure(
      repositories().markMeetingLinkCallInError(
        {
          id: input.callIn.id,
          lastSyncError: getErrorMessage(error),
        },
        input.connection,
      ),
    );
    throw error;
  }
}

type CreatedCallIn = Awaited<ReturnType<RepositoryPort["createMeetingLinkCallIn"]>>;
type CallInAttempt =
  | { status: "retry"; lastError: unknown }
  | { status: "created"; callIn: CreatedCallIn }
  | { status: "failed"; error: unknown };

async function attemptCreateCallIn(input: {
  connection: CallInDbConnection;
  phoneNumber: string;
  meeting: MeetingRecord;
  meetingLink: MeetingLinkRecord;
}): Promise<CallInAttempt> {
  const pin = generateCallInPin();
  const sipDispatchRuleId = await createSyncedCallInRule({
    phoneNumber: input.phoneNumber,
    pin,
    meeting: input.meeting,
    meetingLink: input.meetingLink,
  });

  try {
    const callIn = await repositories().createMeetingLinkCallIn(
      {
        meetingLinkId: input.meetingLink.id,
        phoneNumber: input.phoneNumber,
        pin,
        sipDispatchRuleId,
        dispatchRuleKind: "holding",
        lastSyncedMeetingId: input.meeting.id,
      },
      input.connection,
    );

    return { status: "created", callIn };
  } catch (error) {
    await swallowCallInFailure(deleteSipDispatchRule(sipDispatchRuleId));

    if (isPostgresUniqueConstraintError({ error, constraint: MEETING_LINK_CALL_IN_MEETING_LINK_CONSTRAINT })) {
      const existing = await repositories().getMeetingLinkCallIn(input.meetingLink.id, input.connection);
      if (existing) {
        const callIn = await syncExistingCallIn({
          connection: input.connection,
          callIn: existing,
          phoneNumber: input.phoneNumber,
          meeting: input.meeting,
          meetingLink: input.meetingLink,
        });

        return { status: "created", callIn };
      }
    }

    if (isPostgresUniqueConstraintError({ error, constraint: MEETING_LINK_CALL_IN_PHONE_PIN_CONSTRAINT })) {
      return { status: "retry", lastError: error };
    }

    return { status: "failed", error };
  }
}

async function createNewCallIn(input: {
  connection: CallInDbConnection;
  phoneNumber: string;
  meeting: MeetingRecord;
  meetingLink: MeetingLinkRecord;
}) {
  const attempts = Array.from({ length: PIN_GENERATION_ATTEMPTS }, (_value, index) => index);
  const outcome = await attempts.reduce<Promise<CallInAttempt>>(
    async (previous) => {
      const current = await previous;
      if (current.status !== "retry") {
        return current;
      }

      return attemptCreateCallIn(input);
    },
    Promise.resolve({ status: "retry", lastError: null }),
  );

  if (outcome.status === "created") {
    return outcome.callIn;
  }
  if (outcome.status === "failed") {
    throw outcome.error;
  }

  throw new Error(FAILED_TO_CREATE_UNIQUE_CALL_IN_PIN_PREFIX + getErrorMessage(outcome.lastError));
}

export async function ensureMeetingCallInForMeeting(input: {
  meeting: MeetingRecord;
  meetingLink?: MeetingLinkRecord | null;
}): Promise<MeetingLinkCallInRecord | null> {
  const phoneNumber = getConfiguredDialInNumber();
  if (
    phoneNumber === null ||
    phoneNumber === "" ||
    input.meeting.meetingLinkId === null ||
    input.meeting.meetingLinkId === "" ||
    input.meeting.status === "ended"
  ) {
    return null;
  }

  const meetingLinkId = input.meeting.meetingLinkId;

  return repositories().withMeetingLinkCallInLock({
    meetingLinkId,
    operation: async (connection) => {
      // Inputs may have been read before another sync or meeting-end operation.
      const meeting = await repositories().getMeetingById(input.meeting.id, connection);
      if (!meeting || meeting.status === "ended" || meeting.meetingLinkId !== meetingLinkId) {
        return null;
      }
      const meetingLink = await repositories().getMeetingLinkById(meetingLinkId, connection);
      if (!meetingLink || meetingLink.status !== "active") {
        return null;
      }

      const existing = await repositories().getMeetingLinkCallIn(meetingLink.id, connection);
      if (existing) {
        return syncExistingCallIn({ connection, callIn: existing, phoneNumber, meeting, meetingLink });
      }

      return createNewCallIn({ connection, phoneNumber, meeting, meetingLink });
    },
    wait: true,
  });
}

export async function ensureMeetingCallInForMeetingSafely(input: {
  meeting: MeetingRecord;
  meetingLink?: MeetingLinkRecord | null;
  logger: LoggerLike;
}): Promise<MeetingLinkCallInRecord | null> {
  try {
    return await ensureMeetingCallInForMeeting(input);
  } catch (error) {
    input.logger.warn(
      { err: error, meetingId: input.meeting.id, meetingLinkId: input.meeting.meetingLinkId ?? null },
      MESSAGE_FAILED_TO_SYNC_MEETING_CALL_IN_RULE,
    );

    return null;
  }
}

export async function deactivateMeetingCallInForEndedMeeting(input: {
  meeting: MeetingRecord;
  logger: LoggerLike;
}): Promise<MeetingLinkCallInRecord | null> {
  if (input.meeting.meetingLinkId === null || input.meeting.meetingLinkId === "") {
    return null;
  }

  try {
    const expiredRequests = await repositories().expireWaitingCallInJoinRequestsForMeeting(input.meeting.id);
    await expiredRequests.reduce(async (previous, expiredRequest) => {
      await previous;
      await repositories().publishMeetingJoinRequestRealtime({
        request: expiredRequest,
        eventName: "join-request.updated",
      });
    }, Promise.resolve());
  } catch (error) {
    input.logger.warn(
      { err: error, meetingId: input.meeting.id },
      MESSAGE_FAILED_TO_EXPIRE_WAITING_CALL_IN_JOIN_REQUESTS,
    );
  }

  return cleanupCallInRule({
    meetingLinkId: input.meeting.meetingLinkId,
    expectedMeetingId: input.meeting.id,
    logger: input.logger,
  });
}

async function cleanupCallInRule(input: {
  meetingLinkId: string;
  expectedMeetingId: string | null;
  logger: LoggerLike;
}) {
  return repositories().withMeetingLinkCallInLock({
    meetingLinkId: input.meetingLinkId,
    operation: async (connection) => {
      const callIn = await repositories().getMeetingLinkCallIn(input.meetingLinkId, connection);
      if (!callIn || callIn.lastSyncedMeetingId !== input.expectedMeetingId) {
        return null;
      }
      if (callIn.lastSyncedMeetingId !== null && callIn.lastSyncedMeetingId !== "") {
        const meeting = await repositories().getMeetingById(callIn.lastSyncedMeetingId, connection);
        if (meeting && meeting.status !== "ended") {
          return null;
        }
      }
      try {
        if (callIn.sipDispatchRuleId !== null && callIn.sipDispatchRuleId !== "") {
          await deleteSipDispatchRule(callIn.sipDispatchRuleId);
        }

        return await repositories().markMeetingLinkCallInInactive({ id: callIn.id }, connection);
      } catch (error) {
        input.logger.warn(
          { err: error, meetingId: input.expectedMeetingId, meetingLinkId: input.meetingLinkId },
          MESSAGE_FAILED_TO_DELETE_MEETING_CALL_IN_SIP_DISPATCH_RULE,
        );
        await swallowCallInFailure(
          repositories().markMeetingLinkCallInError(
            {
              id: callIn.id,
              lastSyncError: getErrorMessage(error),
            },
            connection,
          ),
        );

        return null;
      }
    },
  });
}
