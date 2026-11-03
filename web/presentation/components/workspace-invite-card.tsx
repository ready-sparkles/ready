"use client";

import type { WorkspaceInvitationPublicInfo } from "@readymeet/shared";
import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import {
  type AvailableAuthProviders,
  getAvailableAuthProviders,
  getOAuthSignInHref,
  type OAuthSignInProvider,
} from "../../composition/auth-client";

import { GoogleIcon, MicrosoftIcon } from "./auth-provider-icons";
import { ReadyLogo } from "./ready-logo";

const WORKSPACE_INVITE_CARD_COPY = {
  ariaLabel: "Workspace invitation",
  invitationNotFound: "Invitation not found",
  goToReady: "Go to Ready",
  joinWorkspacePrefix: "Join ",
  invitationExpired: "This invitation has expired. Ask a workspace admin to send a new one.",
  invitationRevoked: "This invitation has been revoked.",
  invitationAlreadyAccepted: "This invitation has already been accepted.",
  openReady: "Open Ready",
  signInPromptPrefix: "Sign in with ",
  signInPromptSuffix: " to accept this invitation.",
  signedInAsPrefix: "You are signed in as ",
  signedInAsMiddle: ". Sign in with ",
  signedInAsSuffix: " to accept this invitation.",
  acceptInvitation: "Accept invitation",
  joining: "Joining...",
  continueWithGoogle: "Continue with Google",
  continueWithMicrosoft: "Continue with Microsoft",
  continuing: "Continuing...",
} as const;

function formatJoinWorkspaceTitle(workspaceName: string) {
  return `${WORKSPACE_INVITE_CARD_COPY.joinWorkspacePrefix}${workspaceName}`;
}

function formatInvitationExpiryMessage(expiresAt: string) {
  return `This invitation expires on ${new Date(expiresAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  })}.`;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function isPresentString(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== "";
}

function hasInviteEmailMismatch(input: {
  isSignedIn: boolean;
  signedInEmail: string | null;
  invitation: WorkspaceInvitationPublicInfo | null;
}) {
  const { isSignedIn, signedInEmail, invitation } = input;
  if (!isSignedIn || !isPresentString(signedInEmail) || invitation === null) {
    return false;
  }

  return signedInEmail.toLowerCase() !== invitation.email.toLowerCase();
}

function shouldHideWorkspaceInviteCard(input: {
  loadError: string | null;
  invitation: WorkspaceInvitationPublicInfo | null;
  isSessionLoading: boolean;
}) {
  const { loadError, invitation, isSessionLoading } = input;
  if (isPresentString(loadError)) {
    return false;
  }
  if (invitation === null) {
    return true;
  }

  return invitation.state === "pending" && isSessionLoading;
}

function useWorkspaceInviteAuthProviders(input: {
  invitation: WorkspaceInvitationPublicInfo | null;
  loadError: string | null;
  isSessionLoading: boolean;
  isSignedIn: boolean;
  hasEmailMismatch: boolean;
}) {
  const { invitation, loadError, isSessionLoading, isSignedIn, hasEmailMismatch } = input;
  const [providers, setProviders] = useState<AvailableAuthProviders | null>(null);

  useEffect(() => {
    if (
      invitation === null ||
      isPresentString(loadError) ||
      isSessionLoading ||
      invitation.state !== "pending" ||
      (isSignedIn && !hasEmailMismatch)
    ) {
      return;
    }

    const request = { isCancelled: false };
    const loadProviders = async () => {
      try {
        const available = await getAvailableAuthProviders();
        if (!request.isCancelled) {
          setProviders(available);
        }
      } catch (error) {
        if (!request.isCancelled) {
          setProviders(null);
        }
        if (!(error instanceof Error)) {
          return;
        }
      }
    };
    void loadProviders();

    return () => {
      request.isCancelled = true;
    };
  }, [hasEmailMismatch, invitation, isSessionLoading, isSignedIn, loadError]);

  return providers;
}

type WorkspaceInviteCardProps = {
  invitation: WorkspaceInvitationPublicInfo | null;
  loadError?: string | null;
  acceptError?: string | null;
  /** @external wire boolean */
  accepting?: boolean;
  isSessionLoading?: boolean;
  isSignedIn?: boolean;
  signedInEmail?: string | null;
  authCallbackUrl?: string;
  workspaceHref?: string;
  homeHref?: string;
  switchingAuthProvider?: OAuthSignInProvider | null;
  onSwitchAccount?: (provider: OAuthSignInProvider) => void;
  onAccept?: () => void;
};

export function WorkspaceInviteCard({
  invitation,
  loadError = null,
  acceptError = null,
  /** @external wire boolean */
  accepting: isAcceptingInvitation = false,
  isSessionLoading = false,
  isSignedIn = false,
  signedInEmail = null,
  authCallbackUrl = "/workspace",
  workspaceHref = "/workspace",
  homeHref = "/",
  switchingAuthProvider = null,
  onSwitchAccount,
  onAccept,
}: WorkspaceInviteCardProps) {
  const hasEmailMismatch = hasInviteEmailMismatch({ isSignedIn, signedInEmail, invitation });
  const providers = useWorkspaceInviteAuthProviders({
    invitation,
    loadError,
    isSessionLoading,
    isSignedIn,
    hasEmailMismatch,
  });

  if (shouldHideWorkspaceInviteCard({ loadError, invitation, isSessionLoading })) {
    return null;
  }

  const hasLoadFailure = isPresentString(loadError) || invitation === null;

  return (
    <section className="invite-card" aria-label={WORKSPACE_INVITE_CARD_COPY.ariaLabel}>
      {hasLoadFailure ? (
        <WorkspaceInviteCardLoadFailure homeHref={homeHref} loadError={loadError} />
      ) : (
        <WorkspaceInviteCardInvitationBody
          acceptError={acceptError}
          authCallbackUrl={authCallbackUrl}
          hasEmailMismatch={hasEmailMismatch}
          invitation={invitation}
          isAcceptingInvitation={isAcceptingInvitation}
          isSignedIn={isSignedIn}
          onAccept={onAccept}
          onSwitchAccount={onSwitchAccount}
          providers={providers}
          signedInEmail={signedInEmail}
          switchingAuthProvider={switchingAuthProvider}
          workspaceHref={workspaceHref}
        />
      )}
    </section>
  );
}

function WorkspaceInviteCardLoadFailure({ homeHref, loadError }: { homeHref: string; loadError: string | null }) {
  return (
    <>
      <ReadyLogo className="invite-logo" />
      <h1>{WORKSPACE_INVITE_CARD_COPY.invitationNotFound}</h1>
      <p className="invite-muted">{loadError}</p>
      <Link className="invite-primary-link" href={homeHref}>
        {WORKSPACE_INVITE_CARD_COPY.goToReady}
      </Link>
    </>
  );
}

function WorkspaceInviteCardInvitationBody({
  acceptError,
  authCallbackUrl,
  hasEmailMismatch,
  invitation,
  isAcceptingInvitation,
  isSignedIn,
  onAccept,
  onSwitchAccount,
  providers,
  signedInEmail,
  switchingAuthProvider,
  workspaceHref,
}: {
  acceptError: string | null;
  authCallbackUrl: string;
  hasEmailMismatch: boolean;
  invitation: WorkspaceInvitationPublicInfo;
  isAcceptingInvitation: boolean;
  isSignedIn: boolean;
  onAccept?: () => void;
  onSwitchAccount?: (provider: OAuthSignInProvider) => void;
  providers: AvailableAuthProviders | null;
  signedInEmail: string | null;
  switchingAuthProvider: OAuthSignInProvider | null;
  workspaceHref: string;
}) {
  const workspaceLogoUrl = invitation.workspaceLogoUrl;

  return (
    <>
      {isPresentString(workspaceLogoUrl) ? (
        <img className="invite-logo" src={workspaceLogoUrl} alt="" />
      ) : (
        <ReadyLogo className="invite-logo" />
      )}
      <h1>{formatJoinWorkspaceTitle(invitation.workspaceName)}</h1>

      <WorkspaceInviteCardStateContent
        acceptError={acceptError}
        authCallbackUrl={authCallbackUrl}
        hasEmailMismatch={hasEmailMismatch}
        invitation={invitation}
        isAcceptingInvitation={isAcceptingInvitation}
        isSignedIn={isSignedIn}
        onAccept={onAccept}
        onSwitchAccount={onSwitchAccount}
        providers={providers}
        signedInEmail={signedInEmail}
        switchingAuthProvider={switchingAuthProvider}
        workspaceHref={workspaceHref}
      />

      <p className="invite-expiry">
        {invitation.state === "pending" ? formatInvitationExpiryMessage(invitation.expiresAt) : null}
      </p>
    </>
  );
}

function WorkspaceInviteCardStateContent({
  acceptError,
  authCallbackUrl,
  hasEmailMismatch,
  invitation,
  isAcceptingInvitation,
  isSignedIn,
  onAccept,
  onSwitchAccount,
  providers,
  signedInEmail,
  switchingAuthProvider,
  workspaceHref,
}: {
  acceptError: string | null;
  authCallbackUrl: string;
  hasEmailMismatch: boolean;
  invitation: WorkspaceInvitationPublicInfo;
  isAcceptingInvitation: boolean;
  isSignedIn: boolean;
  onAccept?: () => void;
  onSwitchAccount?: (provider: OAuthSignInProvider) => void;
  providers: AvailableAuthProviders | null;
  signedInEmail: string | null;
  switchingAuthProvider: OAuthSignInProvider | null;
  workspaceHref: string;
}) {
  if (invitation.state === "expired") {
    return <p className="invite-error">{WORKSPACE_INVITE_CARD_COPY.invitationExpired}</p>;
  }
  if (invitation.state === "revoked") {
    return <p className="invite-error">{WORKSPACE_INVITE_CARD_COPY.invitationRevoked}</p>;
  }
  if (invitation.state === "accepted") {
    return (
      <>
        <p className="invite-muted">{WORKSPACE_INVITE_CARD_COPY.invitationAlreadyAccepted}</p>
        <Link className="invite-primary-link" href={workspaceHref}>
          {WORKSPACE_INVITE_CARD_COPY.openReady}
        </Link>
      </>
    );
  }
  if (!isSignedIn) {
    return (
      <>
        <p className="invite-muted">
          {WORKSPACE_INVITE_CARD_COPY.signInPromptPrefix}
          <strong>{invitation.email}</strong>
          {WORKSPACE_INVITE_CARD_COPY.signInPromptSuffix}
        </p>
        <InviteAuthProviderButtons callbackUrl={authCallbackUrl} providers={providers} />
      </>
    );
  }

  if (hasEmailMismatch) {
    return (
      <>
        <p className="invite-error">
          {WORKSPACE_INVITE_CARD_COPY.signedInAsPrefix}
          {signedInEmail}
          {WORKSPACE_INVITE_CARD_COPY.signedInAsMiddle}
          {invitation.email}
          {WORKSPACE_INVITE_CARD_COPY.signedInAsSuffix}
        </p>
        <InviteAuthProviderButtons
          callbackUrl={authCallbackUrl}
          onProviderSelect={onSwitchAccount}
          providers={providers}
          switchingProvider={switchingAuthProvider}
        />
        {isPresentString(acceptError) ? <p className="invite-error">{acceptError}</p> : null}
      </>
    );
  }

  return (
    <>
      {isPresentString(acceptError) ? <p className="invite-error">{acceptError}</p> : null}
      <button
        type="button"
        className="invite-primary-link"
        onClick={onAccept}
        disabled={isAcceptingInvitation || !isDefined(onAccept)}
      >
        {isAcceptingInvitation ? WORKSPACE_INVITE_CARD_COPY.joining : WORKSPACE_INVITE_CARD_COPY.acceptInvitation}
      </button>
    </>
  );
}

function InviteAuthProviderButtons({
  callbackUrl,
  onProviderSelect,
  providers,
  switchingProvider = null,
}: {
  callbackUrl: string;
  onProviderSelect?: (provider: OAuthSignInProvider) => void;
  providers: AvailableAuthProviders | null;
  switchingProvider?: OAuthSignInProvider | null;
}) {
  const authProviders: {
    id: OAuthSignInProvider;
    label: string;
    isAvailable: boolean;
    icon: ReactNode;
  }[] = [
    {
      id: "google",
      label: WORKSPACE_INVITE_CARD_COPY.continueWithGoogle,
      isAvailable: providers?.google ?? true,
      icon: <GoogleIcon />,
    },
    {
      id: "microsoft-entra-id",
      label: WORKSPACE_INVITE_CARD_COPY.continueWithMicrosoft,
      isAvailable: providers?.microsoft ?? true,
      icon: <MicrosoftIcon />,
    },
  ];

  return (
    <div className="login-provider-list invite-provider-list">
      {authProviders.map((provider) => {
        const isSwitching = switchingProvider === provider.id;
        const isDisabled = !provider.isAvailable || isDefined(switchingProvider);
        const content = (
          <>
            <span className="login-provider-icon" aria-hidden="true">
              {provider.icon}
            </span>
            <span>{isSwitching ? WORKSPACE_INVITE_CARD_COPY.continuing : provider.label}</span>
          </>
        );

        return isDefined(onProviderSelect) ? (
          <button
            key={provider.id}
            type="button"
            className="login-provider-button"
            disabled={isDisabled}
            onClick={() => onProviderSelect(provider.id)}
          >
            {content}
          </button>
        ) : (
          <a
            key={provider.id}
            className="login-provider-button"
            href={provider.isAvailable ? getOAuthSignInHref(provider.id, callbackUrl) : undefined}
            aria-disabled={!provider.isAvailable}
            tabIndex={provider.isAvailable ? undefined : -1}
          >
            {content}
          </a>
        );
      })}
    </div>
  );
}
