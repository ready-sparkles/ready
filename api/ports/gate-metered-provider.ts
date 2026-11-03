import { bindPortFunction } from "./bind-port";
import type { LlmResponsesRequest, LlmResponsesResult } from "./llm-responses";

type MeetingProviderScope = { meetingId: string; userId?: string; source: string; actionType: string };
type MeteredProviderPort = {
  executeMeetingResponse: (
    input: MeetingProviderScope & { request: LlmResponsesRequest },
  ) => Promise<LlmResponsesResult>;
  meetingDecisionFetcher: (scope: MeetingProviderScope) => typeof fetch;
  isProviderAccountingError: (error: unknown) => boolean;
};
const NOT_CONFIGURED_MESSAGE = "Metered provider port is not configured.";
const state: { port?: MeteredProviderPort } = {};
export function configureMeteredProvider(port: MeteredProviderPort): void {
  state.port = port;
}
function meteredProvider(): MeteredProviderPort {
  if (state.port === undefined) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }

  return state.port;
}
export const executeMeetingResponse = bindPortFunction(() => meteredProvider().executeMeetingResponse);
export const meetingDecisionFetcher = bindPortFunction(() => meteredProvider().meetingDecisionFetcher);
export const isProviderAccountingError = bindPortFunction(() => meteredProvider().isProviderAccountingError);
