"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { createWorkspace, getApiErrorCode, getApiErrorMessage } from "../../composition/api";
import { syncActiveWorkspaceSession } from "../../composition/workspace-session-sync";
import {
  WORKSPACE_CREATION_EXIT_FADE_MS,
  WORKSPACE_CREATION_TRANSITION_KEY,
} from "../../composition/workspace-transition";

import { useAuth } from "./auth-provider";

const CREATE_WORKSPACE_COPY = {
  backToApp: "Back to app",
  signedInAs: "Signed in as",
  guestTitle: "Create a workspace",
  guestSubtitle: "Workspaces need a full Ready account. Sign in to create one.",
  signIn: "Sign in",
  memberTitle: "Create a workspace",
  memberSubtitle: "A shared home for your team\u2019s meetings, notes, and tasks.",
  nameLabel: "Name",
  emptyNameError: "Enter a workspace name.",
  workspaceLimitError: "You have reached the limit of workspaces you can create.",
  createFailedError: "The workspace could not be created. Try again.",
  sessionSwitchFailedError:
    "Workspace created, but your session could not switch to it. Refresh Ready before continuing.",
  creatingLabel: "Creating workspace\u2026",
  createLabel: "Create workspace",
  workspaceLimitCode: "workspace_limit_reached",
} as const;

function BackChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="workspace-nav-icon settings-back-icon" fill="none">
      <path
        d="M15.75 19.5 8.25 12l7.5-7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type CreateWorkspaceFormProps = {
  name: string;
  error: string | null;
  isSubmitting: boolean;
  onNameChange: (value: string) => void;
  onSubmit: (event: React.SubmitEvent<HTMLFormElement>) => void;
};

function CreateWorkspaceForm({ name, error, isSubmitting, onNameChange, onSubmit }: CreateWorkspaceFormProps) {
  const handleFormSubmit = (event: React.SubmitEvent<HTMLFormElement>): void => {
    onSubmit(event);
  };

  return (
    <>
      <h1>{CREATE_WORKSPACE_COPY.memberTitle}</h1>
      <p className="create-workspace-subtitle">{CREATE_WORKSPACE_COPY.memberSubtitle}</p>

      <form className="create-workspace-form" onSubmit={handleFormSubmit} noValidate>
        <label className="create-workspace-label" htmlFor="create-workspace-name">
          {CREATE_WORKSPACE_COPY.nameLabel}
        </label>
        <input
          id="create-workspace-name"
          className="create-workspace-input"
          type="text"
          autoFocus
          autoComplete="organization"
          maxLength={255}
          value={name}
          disabled={isSubmitting}
          onChange={(event) => {
            onNameChange(event.target.value);
          }}
        />
        {error !== null ? (
          <p className="create-workspace-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="create-workspace-submit" disabled={isSubmitting}>
          {isSubmitting ? CREATE_WORKSPACE_COPY.creatingLabel : CREATE_WORKSPACE_COPY.createLabel}
        </button>
      </form>
    </>
  );
}

type CreateWorkspaceGuestPromptProps = {
  loginCallbackUrl: string;
};

function CreateWorkspaceGuestPrompt({ loginCallbackUrl }: CreateWorkspaceGuestPromptProps) {
  return (
    <>
      <h1>{CREATE_WORKSPACE_COPY.guestTitle}</h1>
      <p className="create-workspace-subtitle">{CREATE_WORKSPACE_COPY.guestSubtitle}</p>
      <Link className="create-workspace-submit create-workspace-signin-link" href={loginCallbackUrl}>
        {CREATE_WORKSPACE_COPY.signIn}
      </Link>
    </>
  );
}

async function submitNewWorkspace(input: {
  session: NonNullable<ReturnType<typeof useAuth>["session"]>;
  trimmedName: string;
  refreshSession: ReturnType<typeof useAuth>["refreshSession"];
  updateCachedUser: ReturnType<typeof useAuth>["updateCachedUser"];
  router: ReturnType<typeof useRouter>;
  setError: (value: string | null) => void;
  setIsSubmitting: (value: boolean) => void;
  setIsExiting: (value: boolean) => void;
  setExitTimerId: (value: number) => void;
}): Promise<void> {
  try {
    const workspace = await createWorkspace({ token: input.session.token, name: input.trimmedName });
    const nextSession = await syncActiveWorkspaceSession({
      token: input.session.token,
      workspaceId: workspace.id,
      refreshSession: input.refreshSession,
      updateCachedUser: input.updateCachedUser,
    });

    if (nextSession === null) {
      input.setError(CREATE_WORKSPACE_COPY.sessionSwitchFailedError);
      input.setIsSubmitting(false);

      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      input.router.push("/workspace");

      return;
    }

    try {
      window.sessionStorage.setItem(WORKSPACE_CREATION_TRANSITION_KEY, "1");
    } catch (storageError) {
      void storageError;
    }

    input.setIsExiting(true);
    input.setExitTimerId(
      window.setTimeout(() => {
        input.router.push("/workspace");
      }, WORKSPACE_CREATION_EXIT_FADE_MS),
    );
  } catch (creationError) {
    const code = getApiErrorCode(creationError);
    input.setError(
      code === CREATE_WORKSPACE_COPY.workspaceLimitCode
        ? getApiErrorMessage({ error: creationError, fallback: CREATE_WORKSPACE_COPY.workspaceLimitError })
        : getApiErrorMessage({ error: creationError, fallback: CREATE_WORKSPACE_COPY.createFailedError }),
    );
    input.setIsSubmitting(false);
  }
}

export function CreateWorkspacePage() {
  const router = useRouter();
  const { session, refreshSession, updateCachedUser } = useAuth();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const exitTimerRef = useRef<number | null>(null);

  const isGuest = session?.user.source === "guest";

  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
      }
    },
    [],
  );

  const handleSubmit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || isSubmitting) {
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError(CREATE_WORKSPACE_COPY.emptyNameError);

      return;
    }

    setIsSubmitting(true);
    setError(null);

    await submitNewWorkspace({
      session,
      trimmedName,
      refreshSession,
      updateCachedUser,
      router,
      setError,
      setIsSubmitting,
      setIsExiting,
      setExitTimerId: (value) => {
        exitTimerRef.current = value;
      },
    });
  };

  const handleCreateWorkspaceSubmit = (event: React.SubmitEvent<HTMLFormElement>): void => {
    void handleSubmit(event);
  };

  const handleNameChange = (value: string) => {
    setName(value);
    if (error !== null) {
      setError(null);
    }
  };

  const loginCallbackUrl = `/login?callbackUrl=${encodeURIComponent("/workspace/new")}`;

  return (
    <main className={`create-workspace-shell${isExiting ? " is-exiting" : ""}`}>
      <header className="create-workspace-topbar">
        <Link href="/workspace" className="workspace-category-item settings-back-link">
          <span className="workspace-category-item-main">
            <BackChevronIcon />
            <span>{CREATE_WORKSPACE_COPY.backToApp}</span>
          </span>
        </Link>
        {session !== null && !isGuest ? (
          <span className="create-workspace-session">
            {CREATE_WORKSPACE_COPY.signedInAs}
            <strong>{session.user.email}</strong>
          </span>
        ) : null}
      </header>

      <section className="create-workspace-main" aria-label="Create a workspace">
        {isGuest ? (
          <CreateWorkspaceGuestPrompt loginCallbackUrl={loginCallbackUrl} />
        ) : (
          <CreateWorkspaceForm
            name={name}
            error={error}
            isSubmitting={isSubmitting}
            onNameChange={handleNameChange}
            onSubmit={handleCreateWorkspaceSubmit}
          />
        )}
      </section>
    </main>
  );
}
