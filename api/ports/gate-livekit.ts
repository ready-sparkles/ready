import { bindPortFunction } from "./bind-port";

const LIVEKIT_PORT_IS_NOT_CONFIGURED_MESSAGE = "Livekit port is not configured.";

type SipDispatchRuleResponse = {
  sip_dispatch_rule_id?: string;
  sipDispatchRuleId?: string;
};

type LivekitPort = {
  createCallInHoldingSipDispatchRule: (input: {
    phoneNumber: string;
    holdingRoomPrefix: string;
    pin: string;
    name: string;
    metadata?: Record<string, unknown>;
    attributes?: Record<string, string>;
  }) => Promise<SipDispatchRuleResponse>;
  deleteSipDispatchRule: (sipDispatchRuleId: string) => Promise<SipDispatchRuleResponse | null>;
  getSipDispatchRuleId: (rule: SipDispatchRuleResponse) => string | null;
  deleteLiveKitRoom: (roomName: string) => Promise<boolean>;
};

const livekitState: { port?: LivekitPort } = {};

export function configureLivekit(port: LivekitPort): void {
  livekitState.port = port;
}

function livekit(): LivekitPort {
  if (livekitState.port === undefined) {
    throw new Error(LIVEKIT_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return livekitState.port;
}

export const createCallInHoldingSipDispatchRule: LivekitPort["createCallInHoldingSipDispatchRule"] = bindPortFunction(
  () => livekit().createCallInHoldingSipDispatchRule,
);

export const deleteSipDispatchRule: LivekitPort["deleteSipDispatchRule"] = bindPortFunction(
  () => livekit().deleteSipDispatchRule,
);

export const getSipDispatchRuleId: LivekitPort["getSipDispatchRuleId"] = bindPortFunction(
  () => livekit().getSipDispatchRuleId,
);

export const deleteLiveKitRoom: LivekitPort["deleteLiveKitRoom"] = bindPortFunction(() => livekit().deleteLiveKitRoom);
