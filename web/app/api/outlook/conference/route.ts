import {
  createCalendarAddonConferenceResponseSchema,
  createOutlookAddonConferenceRequestSchema,
} from "@readymeet/shared";

import { serverEnv } from "../../../../application/server-env";
import { auth } from "../../../../auth";
import { isOutlookDialogRequest } from "../../../../domain/outlook-addon-request";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;
const UPSTREAM_TIMEOUT_MS = 30_000;

const INVALID_REQUEST_ORIGIN_MESSAGE = "Invalid request origin.";
const SIGN_IN_TO_CONTINUE_MESSAGE = "Sign in to Ready to continue.";
const INVALID_MEETING_DETAILS_MESSAGE = "Invalid meeting details.";
const ACCOUNT_CANNOT_CREATE_MEETING_MESSAGE = "Your account cannot create another meeting right now.";
const SESSION_EXPIRED_MESSAGE = "Your session expired. Sign in again.";
const COULD_NOT_CREATE_MEETING_MESSAGE = "Could not create the meeting. Please try again.";

async function readOutlookConferenceRequestBody(
  request: Request,
): Promise<ReturnType<typeof createOutlookAddonConferenceRequestSchema.safeParse>> {
  try {
    const parsed = createOutlookAddonConferenceRequestSchema.safeParse(await request.json());

    return parsed;
  } catch (error) {
    if (error instanceof Error) {
      return createOutlookAddonConferenceRequestSchema.safeParse(undefined);
    }

    throw error;
  }
}

function upstreamFailureMessage(status: number): string {
  if (status === HTTP_FORBIDDEN) {
    return ACCOUNT_CANNOT_CREATE_MEETING_MESSAGE;
  }
  if (status === HTTP_UNAUTHORIZED) {
    return SESSION_EXPIRED_MESSAGE;
  }

  return COULD_NOT_CREATE_MEETING_MESSAGE;
}

function upstreamFailureStatus(status: number): number {
  if (status === HTTP_FORBIDDEN || status === HTTP_UNAUTHORIZED) {
    return status;
  }

  return HTTP_BAD_GATEWAY;
}

export async function POST(request: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!isOutlookDialogRequest(request)) {
    return Response.json({ message: INVALID_REQUEST_ORIGIN_MESSAGE }, { status: HTTP_FORBIDDEN, headers });
  }
  const session = await auth();
  const apiToken = session?.apiToken;
  const appUser = session?.appUser;
  if (apiToken === undefined || apiToken.length === 0 || appUser === undefined) {
    return Response.json({ message: SIGN_IN_TO_CONTINUE_MESSAGE }, { status: HTTP_UNAUTHORIZED, headers });
  }
  const parsed = await readOutlookConferenceRequestBody(request);
  if (!parsed.success) {
    return Response.json({ message: INVALID_MEETING_DETAILS_MESSAGE }, { status: HTTP_BAD_REQUEST, headers });
  }
  try {
    const upstream = await fetch(`${serverEnv.INTERNAL_API_BASE_URL}/v1/meetings/outlook-addon`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      return Response.json(
        { message: upstreamFailureMessage(upstream.status) },
        { status: upstreamFailureStatus(upstream.status), headers },
      );
    }
    const upstreamBody: unknown = await upstream.json();
    const { meetingLink } = createCalendarAddonConferenceResponseSchema.parse(upstreamBody);

    // The dialog sends only conference details to Outlook, never Ready/OAuth tokens.
    return Response.json({ code: meetingLink.code, callIn: meetingLink.callIn }, { headers });
  } catch (error) {
    if (error instanceof Error) {
      return Response.json({ message: COULD_NOT_CREATE_MEETING_MESSAGE }, { status: HTTP_BAD_GATEWAY, headers });
    }

    throw error;
  }
}
