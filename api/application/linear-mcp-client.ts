import { z } from "zod";

import type { LinearTokenSet } from "./linear-client";

const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

const MESSAGE_LINEAR_MCP_RETURNED_NO_DATA = "Linear MCP returned no data";
const MESSAGE_LINEAR_MCP_TOOL_CALL_FAILED = "Linear MCP tool call failed";

const jsonRpcErrorSchema = z.object({
  message: z.string().optional(),
  code: z.number().optional(),
});

const jsonRpcResponseSchema = z.object({
  result: z.unknown().optional(),
  error: jsonRpcErrorSchema.optional(),
});

type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

const mcpContentItemSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const mcpResultWithContentSchema = z.object({
  content: z.array(z.unknown()).optional(),
});

const jsonToolPayloadSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

class LinearMcpError extends Error {
  public readonly statusCode?: number;

  constructor(...args: [message: string, statusCode?: number]) {
    const [message, statusCode] = args;
    super(message);
    this.statusCode = statusCode;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTextContentItem(item: unknown): item is { type: string; text: string } {
  const parsed = mcpContentItemSchema.safeParse(item);

  return parsed.success && parsed.data.type === "text" && typeof parsed.data.text === "string";
}

function parseJsonRpcTextBody(text: string): JsonRpcResponse {
  const jsonPayload: unknown = JSON.parse(text);
  const parsed = jsonRpcResponseSchema.safeParse(jsonPayload);

  return parsed.success ? parsed.data : {};
}

function formatLinearMcpRequestFailedMessage(status: number): string {
  return `Linear MCP request failed (${status})`;
}

function resolveJsonRpcErrorMessage(error: z.infer<typeof jsonRpcErrorSchema>): string {
  const message = error.message;
  if (typeof message === "string" && message !== "") {
    return message;
  }

  return MESSAGE_LINEAR_MCP_TOOL_CALL_FAILED;
}

function parseServerSentJson(input: { text: string }): JsonRpcResponse {
  const dataLines = input.text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
  if (dataLines.length === 0) {
    throw new LinearMcpError(MESSAGE_LINEAR_MCP_RETURNED_NO_DATA);
  }

  return parseJsonRpcTextBody(dataLines.join("\n"));
}

async function parseMcpResponse(input: { response: Response }): Promise<unknown> {
  const text = await input.response.text();
  if (!input.response.ok) {
    throw new LinearMcpError(
      text.length > 0 ? text : formatLinearMcpRequestFailedMessage(input.response.status),
      input.response.status,
    );
  }

  const contentType = input.response.headers.get("content-type") ?? "";
  const payload = contentType.includes("text/event-stream")
    ? parseServerSentJson({ text })
    : parseJsonRpcTextBody(text);

  if (payload.error !== undefined) {
    throw new LinearMcpError(resolveJsonRpcErrorMessage(payload.error));
  }

  return payload.result;
}

function parseToolContent(input: { result: unknown }): unknown {
  const withContent = mcpResultWithContentSchema.safeParse(input.result);
  if (!withContent.success) {
    return input.result;
  }

  const content = withContent.data.content;
  if (content === undefined || !Array.isArray(content)) {
    return input.result;
  }

  const firstText = content.find(isTextContentItem);
  if (firstText === undefined) {
    return input.result;
  }

  try {
    const jsonPayload: unknown = JSON.parse(firstText.text);
    const parsed = jsonToolPayloadSchema.safeParse(jsonPayload);

    return parsed.success ? parsed.data : { text: firstText.text };
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    return { text: firstText.text };
  }
}

function extractLinearMcpTools(result: unknown): unknown[] {
  if (!isPlainRecord(result)) {
    return [];
  }

  const tools = result.tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools;
}

function mapLinearMcpToolDescriptor(tool: unknown): LinearMcpToolDescriptor[] {
  if (!isPlainRecord(tool)) {
    return [];
  }

  const name = typeof tool.name === "string" ? tool.name.trim() : "";
  if (name === "") {
    return [];
  }

  return [
    {
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: isPlainRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
    },
  ];
}

export type LinearMcpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export async function listLinearMcpTools(tokens: LinearTokenSet): Promise<LinearMcpToolDescriptor[]> {
  const response = await fetch(LINEAR_MCP_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/list",
      params: {},
    }),
  });
  const result = await parseMcpResponse({ response });
  const tools = extractLinearMcpTools(result);

  return tools.flatMap(mapLinearMcpToolDescriptor);
}

export async function callLinearMcpTool(
  ...args: [tokens: LinearTokenSet, name: string, args: Record<string, unknown>]
): Promise<unknown> {
  const [tokens, name, toolArgs] = args;
  const response = await fetch(LINEAR_MCP_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name,
        arguments: toolArgs,
      },
    }),
  });

  return parseToolContent({ result: await parseMcpResponse({ response }) });
}
