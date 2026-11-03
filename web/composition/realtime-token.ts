import { z } from "zod";

import type Ably from "../adapters/secondary/ably/sdk";

export const ablyTokenPayloadSchema = z.custom<Ably.TokenDetails | Ably.TokenRequest>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);
