import { z } from "zod";

/**
 * Ashby is a workspace-level connector: a workspace admin stores one Ashby API
 * key, then each member turns it on for themselves. Only members who turned it
 * on see Ashby data in Ready: the Ashby link on memory person pages and, later,
 * candidate details on meeting person cards. Nothing is imported from Ashby.
 */

/** Ashby API key permissions Ready needs, as named in Ashby's API key settings. */
export const ASHBY_REQUIRED_PERMISSIONS = ["candidatesRead"] as const;

const MIN_ASHBY_API_KEY_LENGTH = 8;
const MAX_ASHBY_API_KEY_LENGTH = 512;

export const ashbyErrorCodeSchema = z.enum(["ashby_not_configured", "ashby_invalid_key", "ashby_missing_permission"]);
export type AshbyErrorCode = z.infer<typeof ashbyErrorCodeSchema>;

export const ashbyIntegrationStatusResponseSchema = z.object({
  configured: z.boolean(),
  /** Whether the viewer may add, replace, or remove the workspace's Ashby key. */
  canManage: z.boolean(),
  configuredBy: z.object({ displayName: z.string() }).nullable(),
  configuredAt: z.string().nullable(),
  /** Shown to members when no key exists yet, so they know whom to ask. */
  admins: z.array(z.object({ displayName: z.string() })),
  /** Whether the viewer has turned Ashby on for themselves. */
  connected: z.boolean(),
});
export type AshbyIntegrationStatusResponse = z.infer<typeof ashbyIntegrationStatusResponseSchema>;

export const ashbySaveKeyRequestSchema = z.object({
  apiKey: z.string().trim().min(MIN_ASHBY_API_KEY_LENGTH).max(MAX_ASHBY_API_KEY_LENGTH),
});
