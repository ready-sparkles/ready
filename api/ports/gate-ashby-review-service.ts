import { type AiWorkflowJobView } from "@readymeet/shared";

import type { AppLogger } from "./app-logger";
import { bindPortFunction } from "./bind-port";

const ASHBY_REVIEW_SERVICE_PORT_IS_NOT_CONFIGURED_MESSAGE = "AshbyReviewService port is not configured.";

type AshbyReviewJobLogger = Pick<AppLogger, "info">;

type AshbyReviewServicePort = {
  enqueueAshbyReview: (...args: [meetingId: string]) => Promise<void>;
  processAshbyReviewJob: (...args: [job: AiWorkflowJobView, logger?: AshbyReviewJobLogger]) => Promise<void>;
};

const ashbyReviewServiceState: { port?: AshbyReviewServicePort } = {};

export function configureAshbyReviewService(port: AshbyReviewServicePort): void {
  ashbyReviewServiceState.port = port;
}

function ashbyReviewService(): AshbyReviewServicePort {
  if (ashbyReviewServiceState.port === undefined) {
    throw new Error(ASHBY_REVIEW_SERVICE_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return ashbyReviewServiceState.port;
}

export const enqueueAshbyReview: AshbyReviewServicePort["enqueueAshbyReview"] = bindPortFunction(
  () => ashbyReviewService().enqueueAshbyReview,
);

export const processAshbyReviewJob: AshbyReviewServicePort["processAshbyReviewJob"] = bindPortFunction(
  () => ashbyReviewService().processAshbyReviewJob,
);
