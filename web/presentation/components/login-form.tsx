"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import {
  type AvailableAuthProviders,
  getAvailableAuthProviders,
  getOAuthSignInHref,
} from "../../composition/auth-client";
import { signOut, useSession } from "../../composition/next-auth-react";
import { normalizeCallbackUrl } from "../../domain/login-callback";

import { useAuth } from "./auth-provider";
import { GoogleIcon, MicrosoftIcon } from "./auth-provider-icons";
import {
  type AuthEntryVariant,
  clearAuthEntryPoint,
  clearGoogleWorkspaceAddonAuthEntry,
  consumeAuthEntryReturnPath,
  getGoogleWorkspaceAddonSessionAction,
  getGoogleWorkspaceAddonSignInContext,
  getLoginCopy,
  getLoginErrorCopy,
  hasGoogleWorkspaceAddonAuthEntry,
  rememberAuthEntryPoint,
} from "./login-form-utils";
import { ReadyLogo } from "./ready-logo";

const LOGIN_FORM_COPY = {
  addonAccountMismatchChooseAccount: ". Choose that Google account to continue.",
  addonAccountMismatchPrefix: "This Google account does not match the account connected to the Ready add-on",
  addonInstructionDefaultHint: "the Google account connected to the add-on",
  addonInstructionPrefix: "Continue with ",
  addonInstructionSuffix: ".",
  addonSignInExpired: "This Ready add-on sign-in has expired. Continue with Google to verify the account again.",
  addonSignInIncomplete:
    "This Ready add-on sign-in link is incomplete. Open Ready again from the Google Workspace sidebar.",
  authErrorTryAgain: "Try again",
  commaSeparator: ",",
  errorClearSession: "Ready could not clear the previous account session. Refresh this page and try again.",
  errorLoadProviders: "Ready could not load sign-in providers. Refresh the page and try again.",
  legalAcknowledgeOur: " and acknowledge our ",
  legalAgreeToOur: " you agree to our ",
  legalPrivacyPolicy: "Privacy Policy",
  legalSentenceEnd: ".",
  legalTermsOfUse: "Terms of Use",
  logClearAddonSessionFailed: "[readymeet:auth] Failed to clear add-on session.",
  logClearMismatchedAddonSessionFailed: "[readymeet:auth] Failed to clear mismatched add-on session.",
  logLoadProvidersFailed: "[readymeet:auth] Failed to load sign-in providers.",
  pageTitleOpenReady: "Open Ready",
} as const;

const DEFAULT_ERROR_RETRY_HREF = "/login";

type LoginProviderId = "google" | "microsoft-entra-id";
type LoginProvider = {
  id: LoginProviderId;
  isAvailable: boolean;
  label: string;
  icon: ReactNode | null;
};

type AddonSignInContext = NonNullable<ReturnType<typeof getGoogleWorkspaceAddonSignInContext>>;
type AddonSessionAction = ReturnType<typeof getGoogleWorkspaceAddonSessionAction>;

function renderInterCommas(text: string) {
  return text.split(LOGIN_FORM_COPY.commaSeparator).flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <span key={`comma-${index}`} className="public-geist-comma">
            {LOGIN_FORM_COPY.commaSeparator}
          </span>,
          part,
        ],
  );
}

function formatAddonAccountMismatchMessage(loginHint: string | null): string {
  const hintSuffix = loginHint !== null ? ` (${loginHint})` : "";

  return `${LOGIN_FORM_COPY.addonAccountMismatchPrefix}${hintSuffix}${LOGIN_FORM_COPY.addonAccountMismatchChooseAccount}`;
}

function getAddonFlowErrorMessage(input: {
  addonSignIn: AddonSignInContext | null;
  hasAddonAccountMismatch: boolean;
  isAddonFlowStateInvalid: boolean;
}): string | null {
  if (input.addonSignIn === null) {
    return null;
  }
  if (input.addonSignIn.expectedAccountId === null) {
    return LOGIN_FORM_COPY.addonSignInIncomplete;
  }
  if (input.hasAddonAccountMismatch) {
    return formatAddonAccountMismatchMessage(input.addonSignIn.loginHint);
  }
  if (input.isAddonFlowStateInvalid) {
    return LOGIN_FORM_COPY.addonSignInExpired;
  }

  return null;
}

function buildLoginProviders(input: {
  addonSignIn: AddonSignInContext | null;
  googleLabel: string;
  microsoftLabel: string;
  providers: AvailableAuthProviders | null;
}): LoginProvider[] {
  const allLoginProviders: LoginProvider[] = [
    {
      id: "google",
      isAvailable: input.providers?.google ?? true,
      label: input.googleLabel,
      icon: <GoogleIcon />,
    },
    {
      id: "microsoft-entra-id",
      isAvailable: input.providers?.microsoft ?? true,
      label: input.microsoftLabel,
      icon: <MicrosoftIcon />,
    },
  ];
  if (input.addonSignIn !== null) {
    return allLoginProviders.filter(({ id }) => id === "google");
  }

  return allLoginProviders;
}

function hasAddonExpectedAccountId(addonSignIn: AddonSignInContext | null): boolean {
  return addonSignIn === null || addonSignIn.expectedAccountId !== null;
}

function isLoginProviderInteractive(input: {
  addonSessionAction: AddonSessionAction;
  addonSignIn: AddonSignInContext | null;
  isClearingAddonSession: boolean;
  provider: LoginProvider;
}): boolean {
  return (
    input.provider.isAvailable &&
    hasAddonExpectedAccountId(input.addonSignIn) &&
    input.addonSessionAction !== "clear" &&
    !input.isClearingAddonSession
  );
}

function getLoginProviderHref(input: {
  addonSessionAction: AddonSessionAction;
  addonSignIn: AddonSignInContext | null;
  callbackUrl: string;
  isClearingAddonSession: boolean;
  provider: LoginProvider;
}): string | undefined {
  if (
    !isLoginProviderInteractive({
      addonSessionAction: input.addonSessionAction,
      addonSignIn: input.addonSignIn,
      isClearingAddonSession: input.isClearingAddonSession,
      provider: input.provider,
    })
  ) {
    return undefined;
  }

  return getOAuthSignInHref(
    input.provider.id,
    input.addonSignIn?.oauthCallbackUrl ?? input.callbackUrl,
    input.addonSignIn !== null
      ? {
          forceAccountSelection: true,
          googleAddonHandoffToken: input.addonSignIn.handoffToken,
          loginHint: input.addonSignIn.loginHint,
        }
      : undefined,
  );
}

function isAddonAccountMismatch(input: {
  addonSessionAction: AddonSessionAction;
  addonSignIn: AddonSignInContext | null;
  hasAddonMismatchDetected: boolean;
}): boolean {
  const isCompletionClear = input.addonSignIn?.isCompletion === true && input.addonSessionAction === "clear";

  return input.hasAddonMismatchDetected || isCompletionClear;
}

function isAddonFlowStateInvalid(input: {
  addonSessionAction: AddonSessionAction;
  addonSignIn: AddonSignInContext | null;
}): boolean {
  return input.addonSignIn?.isCompletion === true && input.addonSessionAction === "invalid";
}

type LoginFormEffectsInput = {
  addonSessionAction: AddonSessionAction;
  addonSignIn: AddonSignInContext | null;
  callbackUrl: string;
  clearGuestSession: () => void;
  hasAuthError: boolean;
  router: ReturnType<typeof useRouter>;
  setError: (message: string | null) => void;
  setErrorRetryHref: (href: string) => void;
  setHasAddonMismatchDetected: (value: boolean) => void;
  setHasVerifiedAddonFlowState: (value: boolean) => void;
  setIsClearingAddonSession: (value: boolean) => void;
  setProviders: (providers: AvailableAuthProviders | null) => void;
  status: "authenticated" | "loading" | "unauthenticated";
  variant: AuthEntryVariant;
};

function useLoginFormEffects(input: LoginFormEffectsInput) {
  const {
    addonSessionAction,
    addonSignIn,
    callbackUrl,
    clearGuestSession,
    hasAuthError,
    router,
    setError,
    setErrorRetryHref,
    setHasAddonMismatchDetected,
    setHasVerifiedAddonFlowState,
    setIsClearingAddonSession,
    setProviders,
    status,
    variant,
  } = input;

  useEffect(() => {
    const hasVerifiedFlowState =
      addonSignIn?.isCompletion === true && hasGoogleWorkspaceAddonAuthEntry(addonSignIn.oauthCallbackUrl);
    setHasVerifiedAddonFlowState(hasVerifiedFlowState);
  }, [addonSignIn, setHasVerifiedAddonFlowState]);

  useEffect(() => {
    if (status === "authenticated" && !hasAuthError && addonSignIn === null) {
      clearAuthEntryPoint();
      router.replace(callbackUrl);
    }
  }, [addonSignIn, callbackUrl, hasAuthError, router, status]);

  useEffect(() => {
    if (!hasAuthError && addonSignIn !== null && addonSessionAction === "complete") {
      clearGoogleWorkspaceAddonAuthEntry(addonSignIn.oauthCallbackUrl);
      clearAuthEntryPoint();
      clearGuestSession();
      router.replace(callbackUrl);
    }
  }, [addonSessionAction, addonSignIn, callbackUrl, clearGuestSession, hasAuthError, router]);

  useEffect(() => {
    if (hasAuthError || addonSignIn === null || addonSessionAction !== "clear") {
      return;
    }
    if (addonSignIn.isCompletion) {
      setHasAddonMismatchDetected(true);
    }
    setIsClearingAddonSession(true);
    clearGoogleWorkspaceAddonAuthEntry(addonSignIn.oauthCallbackUrl);
    clearAuthEntryPoint();
    clearGuestSession();
    void (async () => {
      try {
        await signOut({ redirect: false });
      } catch (signOutError) {
        console.error(LOGIN_FORM_COPY.logClearMismatchedAddonSessionFailed, signOutError);
        setError(LOGIN_FORM_COPY.errorClearSession);
      } finally {
        setIsClearingAddonSession(false);
      }
    })();
  }, [
    addonSessionAction,
    addonSignIn,
    clearGuestSession,
    hasAuthError,
    setError,
    setHasAddonMismatchDetected,
    setIsClearingAddonSession,
  ]);

  useEffect(() => {
    if (!hasAuthError && variant === "login" && addonSignIn === null) {
      clearAuthEntryPoint();
    }
  }, [addonSignIn, hasAuthError, variant]);

  useEffect(() => {
    if (hasAuthError) {
      setErrorRetryHref(consumeAuthEntryReturnPath());
    }
  }, [hasAuthError, setErrorRetryHref]);

  useEffect(() => {
    if (hasAuthError) {
      return;
    }

    void (async () => {
      try {
        const available = await getAvailableAuthProviders();
        setProviders(available);
      } catch (nextError) {
        console.error(LOGIN_FORM_COPY.logLoadProvidersFailed, nextError);
        setError(LOGIN_FORM_COPY.errorLoadProviders);
        setProviders(null);
      }
    })();
  }, [hasAuthError, setError, setProviders]);
}

type LoginProviderLinkProps = {
  addonSessionAction: AddonSessionAction;
  addonSignIn: AddonSignInContext | null;
  callbackUrl: string;
  clearGuestSession: () => void;
  isClearingAddonSession: boolean;
  provider: LoginProvider;
  setError: (message: string | null) => void;
  setIsClearingAddonSession: (value: boolean) => void;
  status: "authenticated" | "loading" | "unauthenticated";
  variant: AuthEntryVariant;
};

function LoginProviderLink({
  addonSessionAction,
  addonSignIn,
  callbackUrl,
  clearGuestSession,
  isClearingAddonSession,
  provider,
  setError,
  setIsClearingAddonSession,
  status,
  variant,
}: LoginProviderLinkProps) {
  const isInteractive = isLoginProviderInteractive({
    addonSessionAction,
    addonSignIn,
    isClearingAddonSession,
    provider,
  });
  const href = getLoginProviderHref({
    addonSessionAction,
    addonSignIn,
    callbackUrl,
    isClearingAddonSession,
    provider,
  });
  const isMissingExpectedAccountId = addonSignIn !== null && addonSignIn.expectedAccountId === null;

  return (
    <a
      className="login-provider-button"
      href={href}
      aria-disabled={
        !provider.isAvailable || isMissingExpectedAccountId || addonSessionAction === "clear" || isClearingAddonSession
      }
      tabIndex={isInteractive ? undefined : -1}
      onClick={(event) => {
        setError(null);
        rememberAuthEntryPoint(variant, addonSignIn?.retryUrl);
        if (addonSignIn === null || status !== "authenticated") {
          return;
        }
        const nextHref = event.currentTarget.getAttribute("href");
        if (nextHref === null || nextHref === "") {
          return;
        }
        event.preventDefault();
        setIsClearingAddonSession(true);
        clearGuestSession();
        void (async () => {
          try {
            await signOut({ redirect: false });
            window.location.assign(nextHref);
          } catch (signOutError) {
            console.error(LOGIN_FORM_COPY.logClearAddonSessionFailed, signOutError);
            setError(LOGIN_FORM_COPY.errorClearSession);
            setIsClearingAddonSession(false);
          }
        })();
      }}
    >
      {provider.icon !== null ? (
        <span className="login-provider-icon" aria-hidden="true">
          {provider.icon}
        </span>
      ) : null}
      <span>{provider.label}</span>
    </a>
  );
}

type LoginFormCardProps = {
  addonFlowError: string | null;
  addonSignIn: AddonSignInContext | null;
  addonSessionAction: AddonSessionAction;
  callbackUrl: string;
  clearGuestSession: () => void;
  error: string | null;
  isClearingAddonSession: boolean;
  legalPrefix: string;
  loginProviders: LoginProvider[];
  pageTitle: string;
  setError: (message: string | null) => void;
  setIsClearingAddonSession: (value: boolean) => void;
  status: "authenticated" | "loading" | "unauthenticated";
  variant: AuthEntryVariant;
};

function LoginFormCard({
  addonFlowError,
  addonSignIn,
  addonSessionAction,
  callbackUrl,
  clearGuestSession,
  error,
  isClearingAddonSession,
  legalPrefix,
  loginProviders,
  pageTitle,
  setError,
  setIsClearingAddonSession,
  status,
  variant,
}: LoginFormCardProps) {
  const displayError = error ?? addonFlowError;
  const addonInstructionHint = addonSignIn?.loginHint ?? LOGIN_FORM_COPY.addonInstructionDefaultHint;

  return (
    <section className="login-card login-reveal">
      <div className="login-logo">
        <ReadyLogo />
      </div>

      <div className="login-copy">
        <h1>{pageTitle}</h1>
        {addonSignIn !== null ? (
          <p className="login-addon-instruction">
            {LOGIN_FORM_COPY.addonInstructionPrefix}
            {addonInstructionHint}
            {LOGIN_FORM_COPY.addonInstructionSuffix}
          </p>
        ) : null}
      </div>

      <div className="login-provider-list">
        {loginProviders.map((provider) => (
          <LoginProviderLink
            key={provider.id}
            addonSessionAction={addonSessionAction}
            addonSignIn={addonSignIn}
            callbackUrl={callbackUrl}
            clearGuestSession={clearGuestSession}
            isClearingAddonSession={isClearingAddonSession}
            provider={provider}
            setError={setError}
            setIsClearingAddonSession={setIsClearingAddonSession}
            status={status}
            variant={variant}
          />
        ))}
      </div>

      {displayError !== null ? <p className="error-text">{displayError}</p> : null}

      <p className="login-legal-copy">
        {legalPrefix}
        <span className="public-geist-comma">{LOGIN_FORM_COPY.commaSeparator}</span>
        {LOGIN_FORM_COPY.legalAgreeToOur}
        <a href="/terms">{LOGIN_FORM_COPY.legalTermsOfUse}</a>
        {LOGIN_FORM_COPY.legalAcknowledgeOur}
        <a href="/privacy">{LOGIN_FORM_COPY.legalPrivacyPolicy}</a>
        {LOGIN_FORM_COPY.legalSentenceEnd}
      </p>
    </section>
  );
}

export function LoginForm({ variant = "login" }: { variant?: AuthEntryVariant }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, status } = useSession();
  const { clearGuestSession } = useAuth();
  const [providers, setProviders] = useState<AvailableAuthProviders | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasAddonMismatchDetected, setHasAddonMismatchDetected] = useState(false);
  const [hasVerifiedAddonFlowState, setHasVerifiedAddonFlowState] = useState(false);
  const [isClearingAddonSession, setIsClearingAddonSession] = useState(false);
  const [errorRetryHref, setErrorRetryHref] = useState(DEFAULT_ERROR_RETRY_HREF);
  const authError = getLoginErrorCopy(searchParams.get("error"));
  const hasAuthError = authError !== null;
  const callbackUrl = normalizeCallbackUrl(searchParams.get("callbackUrl"));
  const addonSignIn = useMemo(
    () =>
      getGoogleWorkspaceAddonSignInContext({
        accountId: searchParams.get("accountId"),
        callbackUrl,
        complete: searchParams.get("complete"),
        handoffId: searchParams.get("handoffId"),
        handoffToken: searchParams.get("handoffToken"),
        loginHint: searchParams.get("loginHint"),
        source: searchParams.get("source"),
      }),
    [callbackUrl, searchParams],
  );
  const { title, googleLabel, microsoftLabel, legalPrefix } = getLoginCopy(callbackUrl, variant);
  const pageTitle = addonSignIn !== null ? LOGIN_FORM_COPY.pageTitleOpenReady : title;
  const loginProviders = useMemo(
    () => buildLoginProviders({ addonSignIn, googleLabel, microsoftLabel, providers }),
    [addonSignIn, googleLabel, microsoftLabel, providers],
  );
  const addonSessionAction =
    addonSignIn !== null
      ? getGoogleWorkspaceAddonSessionAction({
          authenticatedAccountId: data?.appUser?.id,
          expectedAccountId: addonSignIn.expectedAccountId,
          hasVerifiedFlowState: hasVerifiedAddonFlowState,
          isCompletion: addonSignIn.isCompletion,
          sessionStatus: status,
        })
      : "none";
  const hasAddonAccountMismatch = isAddonAccountMismatch({
    addonSessionAction,
    addonSignIn,
    hasAddonMismatchDetected,
  });
  const isAddonFlowStateInvalidFlag = isAddonFlowStateInvalid({ addonSessionAction, addonSignIn });
  const addonFlowError = getAddonFlowErrorMessage({
    addonSignIn,
    hasAddonAccountMismatch,
    isAddonFlowStateInvalid: isAddonFlowStateInvalidFlag,
  });

  useLoginFormEffects({
    addonSessionAction,
    addonSignIn,
    callbackUrl,
    clearGuestSession,
    hasAuthError,
    router,
    setError,
    setErrorRetryHref,
    setHasAddonMismatchDetected,
    setHasVerifiedAddonFlowState,
    setIsClearingAddonSession,
    setProviders,
    status,
    variant,
  });

  if (authError !== null) {
    return <LoginErrorCard description={authError.description} retryHref={errorRetryHref} title={authError.title} />;
  }

  return (
    <LoginFormCard
      addonFlowError={addonFlowError}
      addonSignIn={addonSignIn}
      addonSessionAction={addonSessionAction}
      callbackUrl={callbackUrl}
      clearGuestSession={clearGuestSession}
      error={error}
      isClearingAddonSession={isClearingAddonSession}
      legalPrefix={legalPrefix}
      loginProviders={loginProviders}
      pageTitle={pageTitle}
      setError={setError}
      setIsClearingAddonSession={setIsClearingAddonSession}
      status={status}
      variant={variant}
    />
  );
}

function LoginErrorCard({ title, description, retryHref }: { title: string; description: string; retryHref: string }) {
  return (
    <section
      className="workspace-meeting-brief-content mail-empty-brief-content login-auth-error-content"
      aria-labelledby="login-auth-error-title"
    >
      <div className="workspace-meeting-brief-cards">
        <div className="workspace-meeting-brief-card mail-empty-brief-card login-auth-error-card">
          <div className="workspace-meeting-brief-card-inner mail-empty-brief-card-inner">
            <div className="workspace-meeting-brief-card-head">
              <span className="workspace-brief-card-icon-tile">
                <LoginErrorIcon />
              </span>
            </div>
            <div className="workspace-meeting-brief-card-copy">
              <h1 id="login-auth-error-title">{title}</h1>
              <p>{renderInterCommas(description)}</p>
              <a className="login-auth-error-action" href={retryHref}>
                {LOGIN_FORM_COPY.authErrorTryAgain}
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LoginErrorIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 51.5137 46.6553" className="login-auth-error-icon">
      <path
        d="M6.66504 46.3867L44.5068 46.3867C48.6572 46.3867 51.1719 43.5059 51.1719 39.7705C51.1719 38.623 50.8301 37.4268 50.2197 36.3525L31.2744 3.34473C30.0049 1.12305 27.832 0 25.5859 0C23.3398 0 21.1426 1.12305 19.8975 3.34473L0.952148 36.3525C0.292969 37.4512 0 38.623 0 39.7705C0 43.5059 2.51465 46.3867 6.66504 46.3867ZM6.68945 42.5537C4.98047 42.5537 3.95508 41.2354 3.95508 39.7461C3.95508 39.2822 4.05273 38.6963 4.32129 38.1836L23.2422 5.2002C23.7549 4.29688 24.6826 3.90625 25.5859 3.90625C26.4893 3.90625 27.3926 4.29688 27.9053 5.2002L46.8262 38.208C47.0947 38.7207 47.2168 39.2822 47.2168 39.7461C47.2168 41.2354 46.1426 42.5537 44.458 42.5537Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
      <path
        d="M21.7773 37.8418L30.7129 37.8418C31.6162 37.8418 32.3242 37.1826 32.3242 36.2793C32.3242 35.4248 31.6162 34.7412 30.7129 34.7412L27.9785 34.7412L27.9785 23.5596C27.9785 22.3633 27.3926 21.582 26.2695 21.582L22.1436 21.582C21.2402 21.582 20.5322 22.2656 20.5322 23.1201C20.5322 24.0234 21.2402 24.6582 22.1436 24.6582L24.4873 24.6582L24.4873 34.7412L21.7773 34.7412C20.874 34.7412 20.166 35.4248 20.166 36.2793C20.166 37.1826 20.874 37.8418 21.7773 37.8418ZM25.415 17.9199C27.0264 17.9199 28.2715 16.6504 28.2715 15.0635C28.2715 13.4521 27.0264 12.1826 25.415 12.1826C23.8281 12.1826 22.5586 13.4521 22.5586 15.0635C22.5586 16.6504 23.8281 17.9199 25.415 17.9199Z"
        fill="currentColor"
        fillOpacity="0.85"
      />
    </svg>
  );
}
