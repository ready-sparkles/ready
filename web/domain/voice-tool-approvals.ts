import type { CalendarProvider } from "@readymeet/shared";
import { z } from "zod";

import { getCalendarProviderLabel } from "./calendar-events";

const DEFAULT_WORKFLOW_TOOL_LABEL = "workflow";
const CALENDAR_CONNECT_DESCRIPTION =
  "Connect this calendar so Ready can see upcoming meetings, help prep, and answer schedule questions.";
const WORKFLOW_REQUEST_DESCRIPTION = "This workflow is not available yet. Request it for your agent.";
const CONNECT_ACTION_LABEL = "Connect";
const REQUEST_WORKFLOW_ACTION_LABEL = "Request workflow";

const voiceToolApprovalRpcPayloadSchema = z.object({
  tool: z.string().optional(),
  provider: z.string().optional(),
  action: z.string().optional(),
  meetingId: z.string().optional(),
});

type VoiceToolApprovalPayload = {
  tool: string | null;
  provider: CalendarProvider | null;
  action: "enable" | "disable" | null;
  meetingId: string | null;
  rawTool: string | null;
  rawProvider: string | null;
};

export type VoiceToolApprovalCardDefinition = {
  id: string;
  kind: "connect" | "request_workflow";
  tool: string;
  provider: CalendarProvider | null;
  title: string;
  description: string;
  actionLabel: string;
};

function normalizeToken(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  }

  return "";
}

function humanizeToolName(value: string | null): string {
  const normalized = normalizeToken(value);
  if (normalized.length === 0) {
    return DEFAULT_WORKFLOW_TOOL_LABEL;
  }

  return normalized
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeVoiceToolName(value: unknown): string | null {
  const normalized = normalizeToken(value);
  if (normalized.length === 0) {
    return null;
  }
  if (
    normalized === "calendar" ||
    normalized === "google calendar" ||
    normalized === "outlook calendar" ||
    normalized === "microsoft calendar"
  ) {
    return "calendar";
  }
  if (
    normalized === "web search" ||
    normalized === "request web search" ||
    normalized === "web search skill" ||
    normalized === "internet search" ||
    normalized === "search the web"
  ) {
    return "web_search";
  }

  return normalized.replace(/\s+/g, "_");
}

function normalizeVoiceToolProvider(value: unknown): CalendarProvider | null {
  const normalized = normalizeToken(value);
  if (normalized === "google" || normalized === "google calendar" || normalized === "gmail" || normalized === "gcal") {
    return "google_calendar";
  }
  if (
    normalized === "outlook" ||
    normalized === "outlook calendar" ||
    normalized === "microsoft" ||
    normalized === "microsoft calendar" ||
    normalized === "office" ||
    normalized === "office 365"
  ) {
    return "outlook_calendar";
  }

  return null;
}

function normalizeVoiceToolAction(value: unknown): "enable" | "disable" | null {
  const normalized = normalizeToken(value);
  if (["enable", "connect", "turn on", "on", "add"].includes(normalized)) {
    return "enable";
  }
  if (["disable", "disconnect", "turn off", "off", "remove"].includes(normalized)) {
    return "disable";
  }

  return null;
}

export function parseVoiceToolApprovalRpcPayload(payload: string): VoiceToolApprovalPayload {
  try {
    const parsedPayload = voiceToolApprovalRpcPayloadSchema.safeParse(JSON.parse(payload));
    if (!parsedPayload.success) {
      return {
        tool: null,
        provider: null,
        action: null,
        meetingId: null,
        rawTool: null,
        rawProvider: null,
      };
    }
    const parsed = parsedPayload.data;
    const provider = normalizeVoiceToolProvider(parsed.provider) ?? normalizeVoiceToolProvider(parsed.tool);

    return {
      tool: normalizeVoiceToolName(parsed.tool) ?? (provider !== null ? "calendar" : null),
      provider,
      action: normalizeVoiceToolAction(parsed.action),
      meetingId: parsed.meetingId ?? null,
      rawTool: parsed.tool ?? null,
      rawProvider: parsed.provider ?? null,
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        tool: null,
        provider: null,
        action: null,
        meetingId: null,
        rawTool: null,
        rawProvider: null,
      };
    }

    return {
      tool: null,
      provider: null,
      action: null,
      meetingId: null,
      rawTool: null,
      rawProvider: null,
    };
  }
}

export function buildVoiceToolApprovalCard(request: VoiceToolApprovalPayload): VoiceToolApprovalCardDefinition {
  if (request.tool === "calendar" && request.provider !== null) {
    const providerLabel = getCalendarProviderLabel(request.provider);

    return {
      id: `calendar:${request.provider}`,
      kind: "connect",
      tool: "calendar",
      provider: request.provider,
      title: providerLabel,
      description: CALENDAR_CONNECT_DESCRIPTION,
      actionLabel: CONNECT_ACTION_LABEL,
    };
  }

  const tool = request.tool ?? normalizeVoiceToolName(request.rawTool) ?? DEFAULT_WORKFLOW_TOOL_LABEL;
  const label = humanizeToolName(request.rawTool ?? request.rawProvider ?? tool);

  return {
    id: `request:${tool}:${request.rawProvider ?? "default"}`,
    kind: "request_workflow",
    tool,
    provider: null,
    title: `Request ${label}`,
    description: WORKFLOW_REQUEST_DESCRIPTION,
    actionLabel: REQUEST_WORKFLOW_ACTION_LABEL,
  };
}

export function upsertVoiceToolApprovalCard<T extends { id: string }>(input: { cards: T[]; nextCard: T }): T[] {
  const index = input.cards.findIndex((card) => card.id === input.nextCard.id);
  if (index === -1) {
    return [input.nextCard, ...input.cards];
  }

  return input.cards.map((card, cardIndex) => (cardIndex === index ? { ...card, ...input.nextCard } : card));
}
