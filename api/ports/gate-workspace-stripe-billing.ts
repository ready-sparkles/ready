import type { AppLogger } from "./app-logger";
import { bindPortFunction } from "./bind-port";

const WORKSPACE_STRIPE_BILLING_PORT_IS_NOT_CONFIGURED_MESSAGE = "WorkspaceStripeBilling port is not configured.";

type WorkspaceStripeBillingPort = {
  syncWorkspaceSeatQuantity: (input: {
    workspaceId: string;
    log: Pick<AppLogger, "info">;
  }) => Promise<
    | { outcome: "no_subscription" }
    | { outcome: "in_sync"; seatQuantity: number }
    | { outcome: "updated"; seatQuantity: number; previousQuantity: number }
  >;
};

const workspaceStripeBillingState: { port?: WorkspaceStripeBillingPort } = {};

export function configureWorkspaceStripeBilling(port: WorkspaceStripeBillingPort): void {
  workspaceStripeBillingState.port = port;
}

function workspaceStripeBilling(): WorkspaceStripeBillingPort {
  if (workspaceStripeBillingState.port === undefined) {
    throw new Error(WORKSPACE_STRIPE_BILLING_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return workspaceStripeBillingState.port;
}

export const syncWorkspaceSeatQuantity: WorkspaceStripeBillingPort["syncWorkspaceSeatQuantity"] = bindPortFunction(
  () => workspaceStripeBilling().syncWorkspaceSeatQuantity,
);
