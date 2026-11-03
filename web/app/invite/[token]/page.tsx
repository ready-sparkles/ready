"use client";

import type { WorkspaceInvitationPublicInfo } from "@readymeet/shared";
import { useRouter } from "next/navigation";
import { use, useEffect, useRef, useState } from "react";

import {
  acceptWorkspaceInvitation,
  getApiErrorCode,
  getApiErrorMessage,
  getWorkspaceInvitationInfo,
} from "../../../composition/api";
import { type OAuthSignInProvider, startOAuthSignIn } from "../../../composition/auth-client";
import { signOut } from "../../../composition/next-auth-react";
import { syncActiveWorkspaceSession } from "../../../composition/workspace-session-sync";
import { useAuth } from "../../../presentation/components/auth-provider";
import { WorkspaceInviteCard } from "../../../presentation/components/workspace-invite-card";

const INVALID_INVITATION_MESSAGE = "This invitation link is not valid.";
const SESSION_SWITCH_FAILED_MESSAGE =
  "You joined the workspace, but your session could not switch to it. Refresh Ready before continuing.";
const INVITATION_ACCEPT_FAILED_MESSAGE = "The invitation could not be accepted.";
const SIGN_IN_START_FAILED_MESSAGE = "Could not start sign-in.";

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: inviteToken } = use(params);
  const router = useRouter();
  const { clearGuestSession, session, isLoading, refreshSession, updateCachedUser } = useAuth();
  const [invitation, setInvitation] = useState<WorkspaceInvitationPublicInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [switchingAuthProvider, setSwitchingAuthProvider] = useState<OAuthSignInProvider | null>(null);
  const isInvitationLoadCancelledRef = useRef(false);

  useEffect(() => {
    isInvitationLoadCancelledRef.current = false;

    void (async () => {
      try {
        const info = await getWorkspaceInvitationInfo(inviteToken);
        if (!isInvitationLoadCancelledRef.current) {
          setInvitation(info);
        }
      } catch (error) {
        if (!isInvitationLoadCancelledRef.current) {
          setLoadError(getApiErrorMessage({ error, fallback: INVALID_INVITATION_MESSAGE }));
        }
      }
    })();

    return () => {
      isInvitationLoadCancelledRef.current = true;
    };
  }, [inviteToken]);

  const handleAccept = async () => {
    if (!session) {
      return;
    }
    setIsAccepting(true);
    setAcceptError(null);
    try {
      const accepted = await acceptWorkspaceInvitation({ token: session.token, inviteToken });
      const nextSession = await syncActiveWorkspaceSession({
        token: session.token,
        workspaceId: accepted.workspaceId,
        refreshSession,
        updateCachedUser,
      });
      if (!nextSession) {
        setAcceptError(SESSION_SWITCH_FAILED_MESSAGE);
        setIsAccepting(false);

        return;
      }
      router.push("/workspace");
    } catch (error) {
      const code = getApiErrorCode(error);
      setAcceptError(
        code === "invitation_email_mismatch" && invitation !== null
          ? `This invitation was sent to ${invitation.email}. Sign in with that email to accept it.`
          : getApiErrorMessage({ error, fallback: INVITATION_ACCEPT_FAILED_MESSAGE }),
      );
      setIsAccepting(false);
    }
  };

  const authCallbackUrl = `/invite/${inviteToken}`;

  const handleSwitchAccount = async (provider: OAuthSignInProvider) => {
    setAcceptError(null);
    setSwitchingAuthProvider(provider);
    try {
      clearGuestSession();
      await signOut({ redirect: false });
      await startOAuthSignIn(provider, authCallbackUrl);
    } catch (error) {
      setSwitchingAuthProvider(null);
      setAcceptError(error instanceof Error ? error.message : SIGN_IN_START_FAILED_MESSAGE);
    }
  };

  return (
    <main className="invite-page">
      <WorkspaceInviteCard
        invitation={invitation}
        loadError={loadError}
        acceptError={acceptError}
        accepting={isAccepting}
        isSessionLoading={isLoading}
        isSignedIn={session !== null}
        signedInEmail={session?.user.email ?? null}
        authCallbackUrl={authCallbackUrl}
        switchingAuthProvider={switchingAuthProvider}
        onSwitchAccount={(provider) => void handleSwitchAccount(provider)}
        onAccept={() => void handleAccept()}
      />
    </main>
  );
}
