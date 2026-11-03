import type { NextRequest, NextResponse } from "next/server";

import { proxyGuestRequest } from "../../../adapters/primary/next-http/guest-recognition-proxy";

export const GET = (request: NextRequest): Promise<NextResponse> =>
  proxyGuestRequest({
    request,
    path: "/guest-recognition",
  });
export const DELETE = (request: NextRequest): Promise<NextResponse> =>
  proxyGuestRequest({
    request,
    path: "/guest-recognition",
  });
