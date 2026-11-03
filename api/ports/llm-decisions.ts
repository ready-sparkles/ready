import { bindPortFunction } from "./bind-port";

export type MeetingDecisionRequest = {
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  billing?: { userId: string; workspaceId: string; feature: string };
};
type DecisionResult = {
  isOk: boolean;
  status: number;
  payload: unknown;
  rawBody: string;
  headers: Record<string, string>;
  totalUsage?: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cachedInputTokens: number | undefined;
    cacheWriteInputTokens: number | undefined;
  };
};
export type LlmDecisionsPort = {
  executeTypeSafeDecision: (input: MeetingDecisionRequest) => Promise<DecisionResult>;
};
const NOT_CONFIGURED_MESSAGE = "LLM decisions port is not configured.";
const state: { port?: LlmDecisionsPort } = {};
export function configureLlmDecisions(port: LlmDecisionsPort): void {
  state.port = port;
}
export const executeTypeSafeDecision: LlmDecisionsPort["executeTypeSafeDecision"] = bindPortFunction(() => {
  if (state.port === undefined) {
    throw new Error(NOT_CONFIGURED_MESSAGE);
  }

  return state.port.executeTypeSafeDecision;
});
