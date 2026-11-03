import { z } from "zod";

const apiErrorBodySchema = z.object({
  message: z.unknown().optional(),
  error: z.unknown().optional(),
  code: z.string().optional(),
});

const nestedSchemaIssueListSchema = z.array(z.unknown());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseApiErrorResponseText(responseText: string): string | null {
  if (responseText.trim() === "") {
    return null;
  }

  try {
    const parsed = apiErrorBodySchema.safeParse(JSON.parse(responseText));
    if (!parsed.success) {
      return responseText;
    }
    if (typeof parsed.data.message === "string" && parsed.data.message.trim() !== "") {
      return formatApiErrorMessage(parsed.data.message);
    }
    if (Array.isArray(parsed.data.message) && parsed.data.message.length !== 0) {
      return parsed.data.message.map(String).join("\n");
    }
    if (typeof parsed.data.error === "string" && parsed.data.error.trim() !== "") {
      return parsed.data.error;
    }
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  return responseText;
}

function formatApiErrorMessage(message: string): string {
  const trimmed = message.trim();
  try {
    const parsed = nestedSchemaIssueListSchema.safeParse(JSON.parse(trimmed));
    if (!parsed.success) {
      return trimmed;
    }
    const lines = parsed.data.flatMap((issue) => {
      if (!isRecord(issue) || typeof issue.message !== "string" || issue.message.trim() === "") {
        return [];
      }
      const path = Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";

      return [path !== "" ? `${path}: ${issue.message}` : issue.message];
    });

    if (lines.length !== 0) {
      return lines.join("\n");
    }
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  return trimmed;
}

export class ApiError extends Error {
  readonly displayMessage: string;
  readonly status: number;
  readonly responseText: string;

  constructor({ status, responseText }: { status: number; responseText: string }) {
    const displayMessage = parseApiErrorResponseText(responseText) ?? `Request failed (${status}).`;
    super(`API request failed (${status}): ${displayMessage}`);
    this.status = status;
    this.responseText = responseText;
    this.name = "ApiError";
    this.displayMessage = displayMessage;
  }
}

export function getApiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.responseText.trim() === "") {
    return null;
  }

  try {
    const parsed = apiErrorBodySchema.safeParse(JSON.parse(error.responseText));
    if (!parsed.success || parsed.data.code === undefined || parsed.data.code.trim() === "") {
      return null;
    }

    return parsed.data.code;
  } catch (caught: unknown) {
    if (!(caught instanceof SyntaxError)) {
      throw caught;
    }

    return null;
  }
}

export function getApiErrorMessage(input: { error: unknown; fallback: string }): string {
  if (input.error instanceof ApiError) {
    return input.error.displayMessage;
  }

  if (input.error instanceof Error && input.error.message.trim() !== "") {
    return input.error.message;
  }

  return input.fallback;
}
