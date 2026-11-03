import { bindPortFunction } from "./bind-port";

const SLACK_DELIVERY_PORT_IS_NOT_CONFIGURED_MESSAGE = "SlackDelivery port is not configured.";

type SlackDeliveryPort = {
  runSlackMeetingDelivery: (input: {
    meetingId: string;
    logger: {
      info(...args: [bindings: Record<string, unknown>, message: string]): void;
      warn(...args: [bindings: Record<string, unknown>, message: string]): void;
    };
    shouldFinalizeFailure?: boolean;
  }) => Promise<{
    status: "awaiting_user" | "skipped";
    category: "sales" | null;
    channelId: string | null;
    skipReason: "not_configured" | null;
  } | null>;
};

const slackDeliveryState: { port?: SlackDeliveryPort } = {};

export function configureSlackDelivery(port: SlackDeliveryPort): void {
  slackDeliveryState.port = port;
}

function slackDelivery(): SlackDeliveryPort {
  if (slackDeliveryState.port === undefined) {
    throw new Error(SLACK_DELIVERY_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return slackDeliveryState.port;
}

export const runSlackMeetingDelivery: SlackDeliveryPort["runSlackMeetingDelivery"] = bindPortFunction(
  () => slackDelivery().runSlackMeetingDelivery,
);
