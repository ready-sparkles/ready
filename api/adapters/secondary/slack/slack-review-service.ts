import type { RepositoryPort } from "@readymeet/db/ports/repository";
import type { SlackMeetingReview } from "@readymeet/shared";
import { createHash, randomUUID } from "node:crypto";

import { resolveMeetingNotesAccess } from "../../../ports/gate-meeting-notes-access";
import { repositories } from "../../../ports/repository-runtime";

import {
  listSlackChannels,
  lookupSlackUserByEmail,
  openSlackDirectMessage,
  postSlackMessage,
  requireSlackUserToken,
  verifySlackSender,
  verifySlackSenderChannel,
} from "./slack-client";
import { ensureSalesChannel, getConnectedSlackForUser } from "./slack-connection";
import { classifySlackMeeting, interpretSlackCorrection, permitsSlackSalesChannel } from "./slack-meeting-classifier";
import { buildMessageBlocks, createDeterministicSlackClientMsgId, toSlackMrkdwn } from "./slack-message";

const MIN_SHARED_MEETING_PARTICIPANTS = 2;
const MIN_HUMAN_MEETING_SPEAKERS = 2;

const SLACK_REVIEW_MESSAGES = {
  reviewNotFound: "Slack meeting review not found",
  ownerReviewAfterEnd: "Only the meeting owner can review Slack sharing after the meeting ends.",
  meetingNotesLocked: "Meeting notes are locked.",
  meetingNotesNotReady: "Meeting notes are not ready yet.",
  dmOnlyPersonal: "This meeting will be shared only through personal DMs.",
  salesChannelReason: "This appears to be a sales call without sensitive topics.",
  salesCheckIncomplete: "The sales-call check could not be completed. Only personal DMs are available.",
  reviewChangedRefresh: "This Slack review has changed. Refresh it before continuing.",
  slackConnectionChanged: "Your Slack connection changed. Refresh the review.",
  slackSenderChanged: "Your Slack sender changed. Refresh the review.",
  meetingChangedRefresh: "The meeting changed. Refresh the review before sharing.",
  channelDmOnlyGate:
    "Only confirmed sales calls without sensitive topics can go to a channel. This meeting is DM-only.",
  channelInstructionFormat: "To change channels, enter “Use #channel-name”.",
  channelUnavailable: "That channel is not available in your connected Slack workspace.",
  revisionEligibleHelp: "Enter “Use #channel-name”, “Use DMs”, or “Exclude name or email”.",
  revisionDmOnlyHelp: "Enter “Exclude name or email”. This meeting can only be sent through personal DMs.",
  recipientMatchExact: (name: string) => `Use an exact name or email from the recipient list for “${name}”.`,
  meetingDmOnly: "This meeting is DM-only.",
  revisionNotUnderstood: "Please specify one channel or the participants to leave out. Nothing was sent.",
  channelOrDmChoice: "Choose an available channel, or use personal DMs to leave someone out.",
  recipientUnmatched: "A recipient could not be matched. Use their exact email.",
  reviewChangedPleaseRefresh: "The Slack review changed. Please refresh.",
  shareDmOnly: "This meeting can only be shared through personal DMs.",
  channelChangedRefresh: "The channel changed. Refresh the review before sending.",
  noRecipientsSelected: "No matched participants are selected.",
  excludeOwnSlack: "Refresh the review to exclude your own Slack account.",
  recipientChangedRefresh: "A Slack recipient changed. Refresh the review.",
  reviewAlreadyHandling: "This review is already being handled.",
  deliveryAlreadyAttempted: "Delivery was already attempted. Check Slack before sending again.",
  partialDeliveryFailure: (input: { confirmedCount: number; destinationCount: number }) =>
    `${input.confirmedCount} of ${input.destinationCount} deliveries confirmed. Another delivery may have reached Slack. Check Slack; this review will not resend automatically.`,
  meetingNotesPostPrefix: "Meeting notes: ",
  privateMeetingNotesCategory: "Private meeting notes",
} as const;

type SlackRecipientParticipant = { userId: string; displayName: string; email: string };

type SlackConnectedUser = NonNullable<Awaited<ReturnType<typeof getConnectedSlackForUser>>>;

type MeetingInputData = Awaited<ReturnType<typeof loadMeetingInputNamed>>;

type SlackDeliveryProgress = { sent: string[]; hasFailed: boolean };

const hashNamed = (input: { value: unknown }) => createHash("sha256").update(JSON.stringify(input.value)).digest("hex");

async function loadMeetingInputNamed(input: { meetingId: string; userId: string }) {
  const meeting = await repositories().getMeetingById(input.meetingId);
  if (meeting === null || meeting.createdByUserId !== input.userId || meeting.status !== "ended") {
    throw new Error(SLACK_REVIEW_MESSAGES.ownerReviewAfterEnd);
  }
  const access = await resolveMeetingNotesAccess({
    meeting,
    viewerRole: "participant",
    userId: input.userId,
  });
  if (access.locked) {
    throw new Error(SLACK_REVIEW_MESSAGES.meetingNotesLocked);
  }
  const [summary, taskList, transcript, participants] = await Promise.all([
    repositories().getSummaryForMeeting(input.meetingId),
    repositories().getMeetingTaskListForMeeting(input.meetingId),
    repositories().getTranscriptForMeeting(input.meetingId),
    repositories().listHumanParticipantsForMeeting(input.meetingId),
  ]);
  const summaryContent = summary?.content ?? "";
  if (summaryContent.trim().length === 0) {
    throw new Error(SLACK_REVIEW_MESSAGES.meetingNotesNotReady);
  }
  const tasks = (taskList?.items ?? []).map((task) => ({
    title: task.title,
    assigneeName: task.assignee.name ?? null,
  }));
  const conversation = (transcript?.segments ?? [])
    .map((segment) => `${segment.speakerName}: ${segment.content}`)
    .join("\n");
  const humanSpeakers = new Set(
    (transcript?.segments ?? [])
      .filter((segment) => segment.speakerRole !== "assistant" && segment.content.trim().length > 0)
      .map((segment) => segment.speakerUserId ?? segment.speakerName),
  );

  return {
    humanSpeakerCount: humanSpeakers.size,
    meeting,
    summary: summaryContent,
    tasks,
    conversation,
    participants,
    sourceHash: hashNamed({
      value: {
        title: meeting.title,
        /** @external slack review source hash field */
        confidential: meeting.isConfidential,
        summary: summaryContent,
        tasks,
        conversation,
        participants,
      },
    }),
  };
}

function connectionKeyNamed(input: { connected: SlackConnectedUser }) {
  return hashNamed({
    value: {
      id: input.connected.connector.id,
      team: input.connected.tokens.teamId,
      token: input.connected.tokens.accessToken,
      sender: input.connected.tokens.authedUserId,
      userToken: input.connected.tokens.userAccessToken,
    },
  });
}

async function resolveSlackRecipientsNamed(input: {
  participants: SlackRecipientParticipant[];
  accessToken: string;
  senderSlackUserId: string;
  deps: {
    getUserAuthState: RepositoryPort["getUserAuthState"];
    lookupSlackUserByEmail: typeof lookupSlackUserByEmail;
  };
}) {
  return input.participants.reduce<Promise<{ recipients: SlackMeetingReview["recipients"]; unmatchedNames: string[] }>>(
    async (previous, participant) => {
      const state = await previous;
      const user = await input.deps.getUserAuthState(participant.userId);
      // Guest-entered names and generated guest email addresses are not identity evidence.
      const match =
        user?.source === "auth" && user.deletedAt === null
          ? await input.deps.lookupSlackUserByEmail(input.accessToken, user.email)
          : null;
      if (match?.id === input.senderSlackUserId) {
        return state;
      }
      if (
        match !== null &&
        user !== null &&
        !state.recipients.some((recipient) => recipient.slackUserId === match.id)
      ) {
        return {
          recipients: [
            ...state.recipients,
            {
              userId: participant.userId,
              slackUserId: match.id,
              name: participant.displayName,
              email: user.email,
              /** @external slack review recipient inclusion flag */
              included: true,
            },
          ],
          unmatchedNames: state.unmatchedNames,
        };
      }
      if (match === null) {
        return {
          recipients: state.recipients,
          unmatchedNames: [...state.unmatchedNames, participant.displayName],
        };
      }

      return state;
    },
    Promise.resolve({ recipients: [], unmatchedNames: [] }),
  );
}

function isMeetingDmOnlyByPolicy(data: MeetingInputData) {
  return (
    data.meeting.isConfidential ||
    new Set(data.participants.map((participant) => participant.userId)).size < MIN_SHARED_MEETING_PARTICIPANTS ||
    data.humanSpeakerCount < MIN_HUMAN_MEETING_SPEAKERS
  );
}

async function evaluateSlackChannelEligibilityNamed(input: {
  userId: string;
  meetingId: string;
  data: MeetingInputData;
}): Promise<{ isChannelEligible: boolean; reason: string }> {
  if (isMeetingDmOnlyByPolicy(input.data)) {
    return { isChannelEligible: false, reason: SLACK_REVIEW_MESSAGES.dmOnlyPersonal };
  }
  try {
    const classification = await classifySlackMeeting({
      userId: input.userId,
      meetingId: input.meetingId,
      title: input.data.meeting.title,
      participantNames: input.data.participants.map((participant) => participant.displayName),
      guestCount: input.data.participants.filter((participant) => participant.role === "guest").length,
      summaryContent: `${input.data.summary}\n${JSON.stringify(input.data.tasks)}`,
      transcript: input.data.conversation,
    });
    const isChannelEligible = permitsSlackSalesChannel(classification, input.data.conversation);

    return {
      isChannelEligible,
      reason: isChannelEligible ? SLACK_REVIEW_MESSAGES.salesChannelReason : SLACK_REVIEW_MESSAGES.dmOnlyPersonal,
    };
  } catch (error) {
    void (error instanceof Error ? error.message : "Slack channel eligibility check failed");

    return {
      isChannelEligible: false,
      reason: SLACK_REVIEW_MESSAGES.salesCheckIncomplete,
    };
  }
}

async function resolvePrepareExistingReviewNamed(input: {
  meetingId: string;
  userId: string;
  loaded: SlackMeetingReview | null;
  isReopenDismissed: boolean;
}) {
  if (input.loaded?.status === "dismissed" && !input.isReopenDismissed) {
    return input.loaded;
  }
  const existing =
    input.loaded?.status === "dismissed"
      ? ((await repositories().reopenDismissedSlackMeetingReview({
          meetingId: input.meetingId,
          userId: input.userId,
          expectedVersion: input.loaded.version,
        })) ?? (await repositories().getSlackMeetingReview(input.meetingId)))
      : input.loaded;
  if (input.loaded?.status === "dismissed" && existing?.status !== "awaiting_user") {
    return existing;
  }

  return existing;
}

async function buildAwaitingSlackReviewNamed(input: {
  meetingId: string;
  userId: string;
  connected: SlackConnectedUser;
  data: MeetingInputData;
  existing: SlackMeetingReview | null | undefined;
  isChannelEligible: boolean;
  reason: string;
  recipients: SlackMeetingReview["recipients"];
  unmatchedNames: string[];
  channel: SlackMeetingReview["channel"];
}): Promise<SlackMeetingReview> {
  const review: SlackMeetingReview = {
    id: input.existing?.id ?? randomUUID(),
    meetingId: input.meetingId,
    userId: input.userId,
    version: (input.existing?.version ?? 0) + 1,
    status: "awaiting_user",
    teamId: input.connected.tokens.teamId,
    teamName: input.connected.tokens.teamName,
    connectionKey: connectionKeyNamed({ connected: input.connected }),
    sender: {
      slackUserId: input.connected.tokens.authedUserId,
      name: input.connected.tokens.authedUserName ?? input.connected.tokens.authedUserId,
    },
    sourceHash: input.data.sourceHash,
    /** @external slack meeting review channel eligibility flag */
    channelEligible: input.isChannelEligible,
    reason: input.reason,
    mode: input.isChannelEligible ? "channel" : "dm",
    channel: input.channel,
    recipients: input.recipients,
    unmatchedNames: input.unmatchedNames,
    title: input.data.meeting.title,
    summary: input.data.summary,
    tasks: input.data.tasks,
    error: null,
  };

  const saved =
    (await repositories().saveSlackMeetingReview({ review, expectedVersion: input.existing?.version })) ??
    (await repositories().getSlackMeetingReview(input.meetingId));
  if (saved === null) {
    throw new Error(SLACK_REVIEW_MESSAGES.reviewNotFound);
  }

  return saved;
}

async function prepareSlackMeetingReviewNamed(input: {
  meetingId: string;
  userId: string;
  isRefresh: boolean;
  isReopenDismissed: boolean;
}): Promise<SlackMeetingReview | null> {
  const connected = await getConnectedSlackForUser(input.userId);
  if (connected === null) {
    return null;
  }
  const data = await loadMeetingInputNamed({ meetingId: input.meetingId, userId: input.userId });
  const loaded = await repositories().getSlackMeetingReview(input.meetingId);
  // Historical sends keep their original identity and can never be resent.
  if (loaded !== null && ["sending", "completed", "failed"].includes(loaded.status)) {
    return loaded;
  }
  requireSlackUserToken(connected.tokens);
  const existing = await resolvePrepareExistingReviewNamed({
    meetingId: input.meetingId,
    userId: input.userId,
    loaded,
    isReopenDismissed: input.isReopenDismissed,
  });
  if (
    existing !== null &&
    !input.isRefresh &&
    existing.sender !== undefined &&
    existing.connectionKey === connectionKeyNamed({ connected })
  ) {
    return existing;
  }
  await verifySlackSender(connected.tokens);
  const sharing = await evaluateSlackChannelEligibilityNamed({
    userId: input.userId,
    meetingId: input.meetingId,
    data,
  });
  const { recipients, unmatchedNames } = await resolveSlackRecipientsNamed({
    participants: data.participants,
    accessToken: connected.tokens.accessToken,
    senderSlackUserId: connected.tokens.authedUserId,
    deps: { getUserAuthState: repositories().getUserAuthState, lookupSlackUserByEmail },
  });
  const channel = sharing.isChannelEligible ? await ensureSalesChannel(input.userId) : null;

  return buildAwaitingSlackReviewNamed({
    meetingId: input.meetingId,
    userId: input.userId,
    connected,
    data,
    existing,
    isChannelEligible: sharing.isChannelEligible,
    reason: sharing.reason,
    recipients,
    unmatchedNames,
    channel,
  });
}

export async function prepareSlackMeetingReview(
  ...args: [meetingId: string, userId: string, refresh?: boolean, reopenDismissed?: boolean]
): Promise<SlackMeetingReview | null> {
  return prepareSlackMeetingReviewNamed({
    meetingId: args[0],
    userId: args[1],
    isRefresh: args[2] ?? false,
    isReopenDismissed: args[3] ?? false,
  });
}

async function currentReviewNamed(input: { meetingId: string; userId: string; version: number }) {
  const review = await repositories().getSlackMeetingReview(input.meetingId);
  if (
    review === null ||
    review.userId !== input.userId ||
    review.version !== input.version ||
    review.status !== "awaiting_user"
  ) {
    throw new Error(SLACK_REVIEW_MESSAGES.reviewChangedRefresh);
  }
  const data = await loadMeetingInputNamed({ meetingId: input.meetingId, userId: input.userId });
  const connected = await getConnectedSlackForUser(input.userId);
  if (connected === null || review.connectionKey !== connectionKeyNamed({ connected })) {
    throw new Error(SLACK_REVIEW_MESSAGES.slackConnectionChanged);
  }
  requireSlackUserToken(connected.tokens);
  if (review.sender === undefined || review.sender.slackUserId !== connected.tokens.authedUserId) {
    throw new Error(SLACK_REVIEW_MESSAGES.slackSenderChanged);
  }
  if (data.sourceHash !== review.sourceHash) {
    throw new Error(SLACK_REVIEW_MESSAGES.meetingChangedRefresh);
  }

  return { review, connected, data };
}

function reviseSlackDestinationsNamed(input: {
  review: SlackMeetingReview;
  instruction: string;
  channels: Awaited<ReturnType<typeof listSlackChannels>>;
}): SlackMeetingReview {
  const text = input.instruction.trim();
  const channelName = text.match(/#([a-z0-9_-]+)/i)?.[1]?.toLowerCase();
  if (channelName !== undefined && channelName.length > 0) {
    if (!input.review.channelEligible) {
      throw new Error(SLACK_REVIEW_MESSAGES.channelDmOnlyGate);
    }
    if (
      !/^(?:use|send (?:it |these notes )?to|post (?:it |these notes )?to|publish (?:it |these notes )?to)?\s*#[a-z0-9_-]+[.!]?$/i.test(
        text,
      )
    ) {
      throw new Error(SLACK_REVIEW_MESSAGES.channelInstructionFormat);
    }
    const channel = input.channels.find((entry) => entry.name.toLowerCase() === channelName);
    if (channel === undefined) {
      throw new Error(SLACK_REVIEW_MESSAGES.channelUnavailable);
    }

    return { ...input.review, mode: "channel", channel };
  }
  if (/^(?:use |send (?:as |via )?)?(?:personal )?dms[.!]?$/i.test(text)) {
    return { ...input.review, mode: "dm", channel: null };
  }
  const excluded = text.match(/^(?:exclude|leave out|do not send to|don't send to|skip|remove)\s+(.+?)[.!]?$/i)?.[1];
  if (excluded === undefined || excluded.length === 0) {
    throw new Error(
      input.review.channelEligible
        ? SLACK_REVIEW_MESSAGES.revisionEligibleHelp
        : SLACK_REVIEW_MESSAGES.revisionDmOnlyHelp,
    );
  }
  const names = excluded.split(/,|\s+and\s+/i).map((name) => name.trim().toLowerCase());
  const ids = new Set(
    names.map((name) => {
      const matches = input.review.recipients.filter(
        (recipient) => recipient.email.toLowerCase() === name || recipient.name.toLowerCase() === name,
      );
      const match = matches[0];
      if (matches.length !== 1 || match === undefined) {
        throw new Error(SLACK_REVIEW_MESSAGES.recipientMatchExact(name));
      }

      return match.slackUserId;
    }),
  );

  return {
    ...input.review,
    mode: "dm",
    channel: null,
    recipients: input.review.recipients.map((recipient) => ({
      ...recipient,
      /** @external slack review recipient inclusion flag */
      included: recipient.included && !ids.has(recipient.slackUserId),
    })),
  };
}

async function applyInterpretedSlackCorrectionNamed(input: {
  review: SlackMeetingReview;
  userId: string;
  meetingId: string;
  instruction: string;
  channels: Awaited<ReturnType<typeof listSlackChannels>>;
}): Promise<SlackMeetingReview> {
  const change = await interpretSlackCorrection({
    userId: input.userId,
    meetingId: input.meetingId,
    instruction: input.instruction,
    mode: input.review.mode,
    /** @external slack classifier channel eligibility input */
    channelEligible: input.review.channelEligible,
    channels: input.channels,
    recipients: input.review.recipients.filter((recipient) => recipient.included),
  });
  if (!change.understood) {
    throw new Error(SLACK_REVIEW_MESSAGES.revisionNotUnderstood);
  }
  if (change.mode === "channel") {
    if (!input.review.channelEligible) {
      throw new Error(SLACK_REVIEW_MESSAGES.meetingDmOnly);
    }
    const channel = input.channels.find((entry) => entry.id === change.channel_id);
    if (channel === undefined || change.exclude_user_ids.length !== 0) {
      throw new Error(SLACK_REVIEW_MESSAGES.channelOrDmChoice);
    }

    return { ...input.review, mode: "channel", channel };
  }
  if (
    change.exclude_user_ids.some(
      (id) => !input.review.recipients.some((recipient) => recipient.included && recipient.slackUserId === id),
    )
  ) {
    throw new Error(SLACK_REVIEW_MESSAGES.recipientUnmatched);
  }

  return {
    ...input.review,
    mode: "dm",
    channel: null,
    recipients: input.review.recipients.map((recipient) => ({
      ...recipient,
      /** @external slack review recipient inclusion flag */
      included: recipient.included && !change.exclude_user_ids.includes(recipient.slackUserId),
    })),
  };
}

async function reviseSlackMeetingReviewNamed(input: {
  meetingId: string;
  userId: string;
  version: number;
  instruction: string;
}): Promise<SlackMeetingReview> {
  const { review, connected } = await currentReviewNamed({
    meetingId: input.meetingId,
    userId: input.userId,
    version: input.version,
  });
  if (!review.channelEligible && input.instruction.includes("#")) {
    throw new Error(SLACK_REVIEW_MESSAGES.meetingDmOnly);
  }
  const channels = review.channelEligible ? await listSlackChannels(connected.tokens.accessToken) : [];
  const revised = await (async (): Promise<SlackMeetingReview> => {
    try {
      return reviseSlackDestinationsNamed({ review, instruction: input.instruction, channels });
    } catch (error) {
      void (error instanceof Error ? error.message : "Slack destination revision failed");

      return applyInterpretedSlackCorrectionNamed({
        review,
        userId: input.userId,
        meetingId: input.meetingId,
        instruction: input.instruction,
        channels,
      });
    }
  })();
  const saved = await repositories().saveSlackMeetingReview({
    review: { ...revised, version: input.version + 1 },
    expectedVersion: input.version,
  });
  if (saved === null) {
    throw new Error(SLACK_REVIEW_MESSAGES.reviewChangedPleaseRefresh);
  }

  return saved;
}

export async function reviseSlackMeetingReview(
  ...args: [meetingId: string, userId: string, version: number, instruction: string]
): Promise<SlackMeetingReview> {
  return reviseSlackMeetingReviewNamed({
    meetingId: args[0],
    userId: args[1],
    version: args[2],
    instruction: args[3],
  });
}

async function validateConfirmSlackReviewNamed(input: {
  review: SlackMeetingReview;
  connected: SlackConnectedUser;
  data: MeetingInputData;
}) {
  if (input.review.mode === "channel") {
    const reviewChannel = input.review.channel;
    if (!input.review.channelEligible || input.data.meeting.isConfidential || reviewChannel === null) {
      throw new Error(SLACK_REVIEW_MESSAGES.shareDmOnly);
    }
    const channel = (await listSlackChannels(input.connected.tokens.accessToken)).find(
      (entry) => entry.id === reviewChannel.id,
    );
    if (channel === undefined || channel.name !== reviewChannel.name) {
      throw new Error(SLACK_REVIEW_MESSAGES.channelChangedRefresh);
    }
    await verifySlackSenderChannel(input.connected.tokens, channel.id);

    return;
  }
  if (!input.review.recipients.some((recipient) => recipient.included)) {
    throw new Error(SLACK_REVIEW_MESSAGES.noRecipientsSelected);
  }
  // Revalidate identities before any messages are sent.
  await input.review.recipients
    .filter((recipient) => recipient.included)
    .reduce<Promise<void>>(async (previous, recipient) => {
      await previous;
      if (recipient.slackUserId === input.connected.tokens.authedUserId) {
        throw new Error(SLACK_REVIEW_MESSAGES.excludeOwnSlack);
      }
      const match = await lookupSlackUserByEmail(input.connected.tokens.accessToken, recipient.email);
      if (match?.id !== recipient.slackUserId) {
        throw new Error(SLACK_REVIEW_MESSAGES.recipientChangedRefresh);
      }
    }, Promise.resolve());
}

function resolveSlackDeliveryDestinations(input: { review: SlackMeetingReview }): string[] {
  const reviewChannel = input.review.channel;
  if (input.review.mode === "channel") {
    if (reviewChannel === null) {
      throw new Error(SLACK_REVIEW_MESSAGES.shareDmOnly);
    }

    return [reviewChannel.id];
  }

  return input.review.recipients.filter((recipient) => recipient.included).map((recipient) => recipient.slackUserId);
}

async function deliverSlackMeetingReviewNamed(input: {
  meetingId: string;
  userId: string;
  version: number;
  review: SlackMeetingReview;
  connected: SlackConnectedUser;
  senderToken: string;
  blocks: ReturnType<typeof buildMessageBlocks>;
}): Promise<SlackMeetingReview> {
  const sending = await repositories().saveSlackMeetingReview({
    review: { ...input.review, status: "sending", version: input.version + 1 },
    expectedVersion: input.version,
  });
  if (sending === null) {
    throw new Error(SLACK_REVIEW_MESSAGES.reviewAlreadyHandling);
  }
  const destinations = resolveSlackDeliveryDestinations({ review: input.review });
  const delivery = await destinations.reduce<Promise<SlackDeliveryProgress>>(
    async (previous, destination) => {
      const state = await previous;
      if (state.hasFailed) {
        return state;
      }
      try {
        if (
          !(await repositories().claimSlackReviewDestination({
            reviewId: input.review.id,
            destination,
          }))
        ) {
          throw new Error(SLACK_REVIEW_MESSAGES.deliveryAlreadyAttempted);
        }
        const channelId =
          input.review.mode === "channel" ? destination : await openSlackDirectMessage(input.senderToken, destination);
        const posted = await postSlackMessage({
          token: input.senderToken,
          channelId,
          text: SLACK_REVIEW_MESSAGES.meetingNotesPostPrefix + toSlackMrkdwn(input.review.title),
          blocks: input.blocks,
          clientMsgId: createDeterministicSlackClientMsgId({
            meetingId: input.meetingId,
            channelId,
          }),
        });
        await repositories().finishSlackReviewDestination({
          reviewId: input.review.id,
          destination,
          messageTs: posted.messageTs,
        });

        return { sent: [...state.sent, destination], hasFailed: false };
      } catch (error) {
        void (error instanceof Error ? error.message : "Slack delivery failed");

        return { sent: state.sent, hasFailed: true };
      }
    },
    Promise.resolve({ sent: [], hasFailed: false }),
  );
  if (delivery.hasFailed) {
    const failed: SlackMeetingReview = {
      ...sending,
      status: "failed",
      error: SLACK_REVIEW_MESSAGES.partialDeliveryFailure({
        confirmedCount: delivery.sent.length,
        destinationCount: destinations.length,
      }),
    };
    await repositories().finishSlackMeetingReview({ review: failed });

    return failed;
  }
  const completed: SlackMeetingReview = { ...sending, status: "completed" };
  try {
    await repositories().finishSlackMeetingReview({ review: completed });

    return completed;
  } catch (error) {
    void (error instanceof Error ? error.message : "Slack delivery failed");
    const failed: SlackMeetingReview = {
      ...sending,
      status: "failed",
      error: SLACK_REVIEW_MESSAGES.partialDeliveryFailure({
        confirmedCount: delivery.sent.length,
        destinationCount: destinations.length,
      }),
    };
    await repositories().finishSlackMeetingReview({ review: failed });

    return failed;
  }
}

async function confirmSlackMeetingReviewNamed(input: {
  meetingId: string;
  userId: string;
  version: number;
}): Promise<SlackMeetingReview> {
  const { review, connected, data } = await currentReviewNamed({
    meetingId: input.meetingId,
    userId: input.userId,
    version: input.version,
  });
  await verifySlackSender(connected.tokens);
  const senderToken = requireSlackUserToken(connected.tokens);
  await validateConfirmSlackReviewNamed({ review, connected, data });
  const blocks = buildMessageBlocks({
    title: review.title,
    categoryKey: review.mode === "channel" ? "sales" : SLACK_REVIEW_MESSAGES.privateMeetingNotesCategory,
    summaryContent: review.summary,
    tasks: review.tasks,
  });
  // Refresh the review before the channel-sharing guard reads the meeting.
  // Each database operation is independent; this does not acquire a lock.
  await currentReviewNamed({
    meetingId: input.meetingId,
    userId: input.userId,
    version: input.version,
  });
  const deliver = () =>
    deliverSlackMeetingReviewNamed({
      meetingId: input.meetingId,
      userId: input.userId,
      version: input.version,
      review,
      connected,
      senderToken,
      blocks,
    });

  return review.mode === "channel"
    ? repositories().withSlackChannelSharingLock({ meetingId: input.meetingId, userId: input.userId, send: deliver })
    : deliver();
}

export async function confirmSlackMeetingReview(
  ...args: [meetingId: string, userId: string, version: number]
): Promise<SlackMeetingReview> {
  return confirmSlackMeetingReviewNamed({
    meetingId: args[0],
    userId: args[1],
    version: args[2],
  });
}
