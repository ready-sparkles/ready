import { INSUFFICIENT_CREDITS_CODE, INSUFFICIENT_CREDITS_USER_MESSAGE } from "@readymeet/shared";

const MESSAGE_INTERNAL_ONE_TO_ONE_CONFIDENTIALITY_REQUIRED = "Internal one-to-one meetings must remain confidential.";

export const WORKSPACE_ADMIN_ERROR_CODES = {
  membership_not_found: "membership_not_found",
  workspace_manager_required: "workspace_manager_required",
  workspace_owner_required: "workspace_owner_required",
  owner_protected: "owner_protected",
  self_action_not_allowed: "self_action_not_allowed",
  ownership_target_invalid: "ownership_target_invalid",
  already_member: "already_member",
  already_invited: "already_invited",
  invitation_not_found: "invitation_not_found",
  invitation_expired: "invitation_expired",
  invitation_revoked: "invitation_revoked",
  invitation_accepted: "invitation_accepted",
  invitation_email_mismatch: "invitation_email_mismatch",
  invalid_workspace_name: "invalid_workspace_name",
  workspace_limit_reached: "workspace_limit_reached",
  guest_cannot_create_workspace: "guest_cannot_create_workspace",
  workspace_subscription_active: "workspace_subscription_active",
} as const;

export type WorkspaceAdminErrorCode = (typeof WORKSPACE_ADMIN_ERROR_CODES)[keyof typeof WORKSPACE_ADMIN_ERROR_CODES];

export class WorkspaceAdminError extends Error {
  public readonly code: WorkspaceAdminErrorCode;

  constructor(input: { code: WorkspaceAdminErrorCode; message: string }) {
    super(input.message);
    this.code = input.code;
    this.name = "WorkspaceAdminError";
  }
}

export class MeetingConfidentialityRequiredError extends Error {
  readonly code = "internal_one_to_one_confidentiality_required" as const;

  constructor() {
    super(MESSAGE_INTERNAL_ONE_TO_ONE_CONFIDENTIALITY_REQUIRED);
    this.name = "MeetingConfidentialityRequiredError";
  }
}

export class AccountDeletionBillingError extends Error {
  public readonly code:
    | "account_subscription_active"
    | "account_checkout_pending"
    | "workspace_owner_transfer_required";

  constructor(input: {
    code: "account_subscription_active" | "account_checkout_pending" | "workspace_owner_transfer_required";
    message: string;
  }) {
    super(input.message);
    this.name = "AccountDeletionBillingError";
    this.code = input.code;
  }
}

const AUTHENTICATION_IDENTITY_CONFLICT_MESSAGE =
  "This email already belongs to another sign-in identity. Sign in with the original provider account.";

export class AuthenticationIdentityConflictError extends Error {
  constructor() {
    super(AUTHENTICATION_IDENTITY_CONFLICT_MESSAGE);
    this.name = "AuthenticationIdentityConflictError";
  }
}

export class BillingReservationError extends Error {
  readonly statusCode = 409;
}

export class GuestRecognitionConsentRequired extends Error {}

export class GuestSessionLinkConflictError extends Error {}

/** The account or workspace cannot cover an AI charge. Callers map it to HTTP 402. */
export class InsufficientAiCreditsError extends Error {
  readonly code = INSUFFICIENT_CREDITS_CODE;
  readonly statusCode = 402;

  constructor(options?: { cause?: unknown }) {
    super(INSUFFICIENT_CREDITS_USER_MESSAGE, options);
    this.name = "InsufficientAiCreditsError";
  }
}

/** A paid AI reservation was requested for a workspace without a Pro or Max plan (HTTP 402). */
export class PaidPlanRequiredForCreditsError extends Error {
  readonly code = INSUFFICIENT_CREDITS_CODE;
  readonly statusCode = 402;

  constructor() {
    super(INSUFFICIENT_CREDITS_USER_MESSAGE);
    this.name = "PaidPlanRequiredForCreditsError";
  }
}

export const WORKSPACE_TASK_SECTION_TITLE_CONFLICT_MESSAGE = "A section with this title already exists.";

export class WorkspaceTaskSectionTitleConflictError extends Error {
  readonly code = "workspace_task_section_title_conflict" as const;
  readonly statusCode = 409;

  constructor() {
    super(WORKSPACE_TASK_SECTION_TITLE_CONFLICT_MESSAGE);
    this.name = "WorkspaceTaskSectionTitleConflictError";
  }
}

const MEMORY_NOT_FOUND_MESSAGE = "Memory not found";

/** Some requested memories do not exist or are not visible to the caller. */
export class MemoryNotFoundError extends Error {
  constructor() {
    super(MEMORY_NOT_FOUND_MESSAGE);
    this.name = "MemoryNotFoundError";
  }
}

const MEMORY_BUSY_MESSAGE = "Memory is being updated. Try again in a moment.";

/** The memory rows are locked by another writer for longer than the request may wait. */
export class MemoryBusyError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(MEMORY_BUSY_MESSAGE, options);
    this.name = "MemoryBusyError";
  }
}
