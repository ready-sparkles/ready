import { bindPortFunction } from "./bind-port";
import type { AshbyCandidate } from "./gate-ashby-client";

const ASHBY_PROFILE_LINKS_PORT_IS_NOT_CONFIGURED_MESSAGE = "AshbyProfileLinks port is not configured.";

type AshbyProfileLinksPort = {
  safeAshbyProfileUrl: (candidate: AshbyCandidate) => string;
};

const ashbyProfileLinksState: { port?: AshbyProfileLinksPort } = {};

export function configureAshbyProfileLinks(port: AshbyProfileLinksPort): void {
  ashbyProfileLinksState.port = port;
}

function ashbyProfileLinks(): AshbyProfileLinksPort {
  if (ashbyProfileLinksState.port === undefined) {
    throw new Error(ASHBY_PROFILE_LINKS_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return ashbyProfileLinksState.port;
}

export const safeAshbyProfileUrl: AshbyProfileLinksPort["safeAshbyProfileUrl"] = bindPortFunction(
  () => ashbyProfileLinks().safeAshbyProfileUrl,
);
