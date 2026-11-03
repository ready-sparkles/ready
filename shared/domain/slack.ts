import { z } from "zod";

const MAX_SLACK_CHANNEL_NAME_LENGTH = 80;
const MAX_SLACK_REVIEW_INSTRUCTION_LENGTH = 2_000;

/**
 * Pre-built meeting detector categories for the Slack connector. Each
 * description serves two purposes: it is shown in the routing settings modal
 * and it is the classification criterion the post-meeting classifier uses to
 * decide which category a meeting belongs to, so keep the wording concrete
 * and observable from a transcript.
 */
export const SLACK_MEETING_CATEGORIES = [
  {
    key: "sales",
    label: "Sales",
    description: "Discovery, demos, pricing, proposals, renewals, and pipeline reviews.",
  },
  {
    key: "customer_support",
    label: "Customer support",
    description: "Troubleshooting, onboarding, escalations, account health, and feedback.",
  },
  {
    key: "product_engineering",
    label: "Product & engineering",
    description: "Roadmaps, feature planning, design, architecture, sprints, bugs, and incidents.",
  },
  {
    key: "hiring_interviews",
    label: "Hiring & interviews",
    description: "Screens, interviews, debriefs, offers, and hiring planning.",
  },
] as const;

export const slackMeetingCategoryKeys = [
  "sales",
  "customer_support",
  "product_engineering",
  "hiring_interviews",
] as const;

export const slackMeetingCategoryKeySchema = z.enum(slackMeetingCategoryKeys);

export const slackChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  isPrivate: z.boolean(),
});

export const slackCategoryRouteSchema = z.object({
  channelId: z.string().min(1),
  channelName: z.string().min(1),
});

export const slackDeliveryConfigSchema = z.object({
  /** Categories without a route (or with null) are not posted anywhere. */
  routes: z.record(slackMeetingCategoryKeySchema, slackCategoryRouteSchema.nullable()),
});

export const slackConnectRequestSchema = z.object({
  returnTo: z.string().trim().min(1).optional(),
});

export const slackConnectResponseSchema = z.object({
  authorizationUrl: z.string().url(),
});

export const slackDisconnectResponseSchema = z.object({
  ok: z.boolean(),
});

export const slackChannelsResponseSchema = z.object({
  channels: slackChannelSchema.array(),
});

export const slackCreateChannelRequestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SLACK_CHANNEL_NAME_LENGTH)
    .transform((value) =>
      value
        .toLowerCase()
        .replace(/[\s._]+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .pipe(z.string().min(1).max(MAX_SLACK_CHANNEL_NAME_LENGTH)),
});

export const slackCreateChannelResponseSchema = z.object({
  channel: slackChannelSchema,
});

export const slackDeliverySettingsSchema = z.object({
  connected: z.boolean(),
  teamName: z.string().nullable(),
  requiresReconnect: z.boolean().default(false),
  config: slackDeliveryConfigSchema,
});

export const slackDeliverySettingsResponseSchema = z.object({
  slack: slackDeliverySettingsSchema,
});

export const slackDeliverySettingsUpdateRequestSchema = z.object({
  config: slackDeliveryConfigSchema,
});

export const DEFAULT_SLACK_DELIVERY_CONFIG: SlackDeliveryConfig = {
  routes: {},
};

export type SlackMeetingCategoryKey = z.infer<typeof slackMeetingCategoryKeySchema>;
export type SlackChannel = z.infer<typeof slackChannelSchema>;
export type SlackCategoryRoute = z.infer<typeof slackCategoryRouteSchema>;
export type SlackDeliveryConfig = z.infer<typeof slackDeliveryConfigSchema>;
export type SlackDeliverySettings = z.infer<typeof slackDeliverySettingsSchema>;

export const slackReviewRecipientSchema = z.object({
  userId: z.string(),
  slackUserId: z.string(),
  name: z.string(),
  email: z.string(),
  included: z.boolean(),
});
export const slackMeetingReviewSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  userId: z.string().uuid(),
  version: z.number().int(),
  status: z.enum(["awaiting_user", "sending", "completed", "failed", "dismissed"]),
  teamId: z.string(),
  teamName: z.string(),
  connectionKey: z.string(),
  sourceHash: z.string(),
  sender: z.object({ slackUserId: z.string(), name: z.string() }).optional(),
  channelEligible: z.boolean(),
  reason: z.string(),
  mode: z.enum(["channel", "dm"]),
  channel: slackChannelSchema.nullable(),
  recipients: slackReviewRecipientSchema.array(),
  unmatchedNames: z.string().array(),
  title: z.string(),
  summary: z.string(),
  tasks: z.array(z.object({ title: z.string(), assigneeName: z.string().nullable() })),
  error: z.string().nullable(),
});
export type SlackMeetingReview = z.infer<typeof slackMeetingReviewSchema>;
export const slackMeetingReviewResponseSchema = z.object({ review: slackMeetingReviewSchema.nullable() });
export const slackReviewActionSchema = z.object({ version: z.number().int().positive() });
export const slackReviewRevisionSchema = slackReviewActionSchema.extend({
  instruction: z.string().trim().min(1).max(MAX_SLACK_REVIEW_INSTRUCTION_LENGTH),
});
