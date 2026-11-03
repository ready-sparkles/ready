import { z } from "zod";

export const memoryFilterScopeSchema = z.record(z.string(), z.string());
