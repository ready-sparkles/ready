import { z } from "zod";

import { apiEnv } from "../ports/api-env";

const RESEND_ERROR_BODY_SNIPPET_LENGTH = 300;

const RESEND_API_URL = "https://api.resend.com/emails";

const resendSendResponseSchema = z.object({
  id: z.string().optional(),
});

const MESSAGE_RESEND_SEND_FAILED_PREFIX = "Resend send failed (";
const MESSAGE_RESEND_SEND_FAILED_SUFFIX = "): ";

function formatResendSendFailedMessage(input: { status: number; bodySnippet: string }): string {
  return `${MESSAGE_RESEND_SEND_FAILED_PREFIX}${input.status}${MESSAGE_RESEND_SEND_FAILED_SUFFIX}${input.bodySnippet}`;
}

async function readResponseTextSafely(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (error instanceof Error) {
      return "";
    }
    throw error;
  }
}

async function parseResendSendResponse(response: Response): Promise<z.infer<typeof resendSendResponseSchema> | null> {
  try {
    const jsonPayload: unknown = await response.json();
    const parsed = resendSendResponseSchema.safeParse(jsonPayload);

    return parsed.success ? parsed.data : null;
  } catch (error) {
    if (error instanceof Error) {
      return null;
    }
    throw error;
  }
}

export function isResendConfigured(): boolean {
  return Boolean(apiEnv().RESEND_API_KEY);
}

export class ResendError extends Error {
  public readonly status: number;

  constructor(input: { status: number; message: string }) {
    super(input.message);
    this.status = input.status;
    this.name = "ResendError";
  }
}

/**
 * Sends a transactional email through Resend. Server-side only: the API key
 * never leaves this process. In environments without a key (local dev) the
 * send is skipped and reported as such so callers can still complete flows.
 */
export async function sendResendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ /** @external resend delivery status */ sent: boolean; id: string | null }> {
  if (!isResendConfigured()) {
    return { sent: false, id: null };
  }

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiEnv().RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: apiEnv().RESEND_FROM_EMAIL,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });

  if (!response.ok) {
    const body = await readResponseTextSafely(response);
    throw new ResendError({
      status: response.status,
      message: formatResendSendFailedMessage({
        status: response.status,
        bodySnippet: body.slice(0, RESEND_ERROR_BODY_SNIPPET_LENGTH),
      }),
    });
  }

  const parsedPayload = await parseResendSendResponse(response);

  return { sent: true, id: parsedPayload?.id ?? null };
}
