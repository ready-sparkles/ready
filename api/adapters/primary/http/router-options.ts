// Provider event IDs can exceed Fastify's 100-character default. Keep a bounded
// limit while allowing long Google/Outlook IDs to reach their route handlers.
const MAX_API_ROUTE_PARAM_LENGTH = 2_048;

export const API_ROUTER_OPTIONS = { maxParamLength: MAX_API_ROUTE_PARAM_LENGTH };
