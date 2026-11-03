import type { NextRequest, NextResponse } from "next/server";

import { proxyGuestRequest } from "../../../../adapters/primary/next-http/guest-recognition-proxy";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await context.params;

  return proxyGuestRequest({ request, path: `/meeting-links/${encodeURIComponent(code)}/join-requests` });
}
