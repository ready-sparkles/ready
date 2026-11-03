import { bindPortFunction } from "./bind-port";

const AMBIENT_CONTEXT_DETECTION_PORT_IS_NOT_CONFIGURED_MESSAGE = "AmbientContextDetection port is not configured.";

export type AmbientDetection = {
  kind: "person" | "company";
  displayName: string;
  qualifier: string | null;
  facets: string[];
  segmentIds: string[];
  // Evidence cardinality for the shared persistence path, not model confidence.
  mentionCount: number;
  canonicalKey?: string;
  /** @external ambient detection reference-only wire field */
  referenceOnly?: boolean;
  legacyPolicy?: { confidence: "high" | "medium" | "low"; intent: "explicit" | "contextual" | "incidental" };
};

type AmbientContextDetectionPort = {
  ambientContextCanonicalKey: (input: {
    kind: "person" | "company";
    displayName: string;
    qualifier: string | null;
  }) => string;
  passesAmbientDetectionGuards: (
    ...args: [input: AmbientDetection, matchingContent: string[], surroundingContent: string[]]
  ) => boolean;
};

const ambientContextDetectionState: { port?: AmbientContextDetectionPort } = {};

export function configureAmbientContextDetection(port: AmbientContextDetectionPort): void {
  ambientContextDetectionState.port = port;
}

function ambientContextDetection(): AmbientContextDetectionPort {
  if (ambientContextDetectionState.port === undefined) {
    throw new Error(AMBIENT_CONTEXT_DETECTION_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return ambientContextDetectionState.port;
}

export const ambientContextCanonicalKey: AmbientContextDetectionPort["ambientContextCanonicalKey"] = bindPortFunction(
  () => ambientContextDetection().ambientContextCanonicalKey,
);

export const passesAmbientDetectionGuards: AmbientContextDetectionPort["passesAmbientDetectionGuards"] =
  bindPortFunction(() => ambientContextDetection().passesAmbientDetectionGuards);
