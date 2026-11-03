"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { startOAuthSignIn } from "../../composition/auth-client";
import { readRememberedAuthProvider } from "../../composition/remembered-auth-provider";

import { GoogleIcon, MicrosoftIcon } from "./auth-provider-icons";

type MeetingAuthProvider = {
  id: "google" | "microsoft-entra-id";
  label: string;
  logo: ReactNode;
};

const MEETING_AUTH_PROVIDERS: MeetingAuthProvider[] = [
  {
    id: "google",
    label: "Continue with Google",
    logo: <GoogleAuthLogo />,
  },
  {
    id: "microsoft-entra-id",
    label: "Continue with Microsoft",
    logo: <MicrosoftAuthLogo />,
  },
];

function GoogleAuthLogo() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-calendar-provider-logo meeting-join-auth-provider-logo"
    >
      <path
        fill="#4285f4"
        d="M21.6 12.23c0-.74-.07-1.45-.19-2.14H12v4.05h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.31 2.98-7.44Z"
      />
      <path
        fill="#34a853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.23-2.51c-.9.6-2.05.95-3.39.95-2.61 0-4.82-1.76-5.61-4.13H3.05v2.59A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#fbbc05"
        d="M6.39 13.88A6.02 6.02 0 0 1 6.07 12c0-.65.11-1.28.32-1.88V7.53H3.05A10 10 0 0 0 2 12c0 1.61.38 3.14 1.05 4.47l3.34-2.59Z"
      />
      <path
        fill="#ea4335"
        d="M12 5.99c1.47 0 2.78.5 3.82 1.49l2.87-2.87C16.95 2.99 14.69 2 12 2a10 10 0 0 0-8.95 5.53l3.34 2.59C7.18 7.75 9.39 5.99 12 5.99Z"
      />
    </svg>
  );
}

function MicrosoftAuthLogo() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="workspace-calendar-provider-logo meeting-join-auth-provider-logo"
    >
      <path fill="#f25022" d="M3 3h8.5v8.5H3V3Z" />
      <path fill="#7fba00" d="M12.5 3H21v8.5h-8.5V3Z" />
      <path fill="#00a4ef" d="M3 12.5h8.5V21H3v-8.5Z" />
      <path fill="#ffb900" d="M12.5 12.5H21V21h-8.5v-8.5Z" />
    </svg>
  );
}

export function MeetingAuthMenu({
  buttonLabel = "Sign in",
  callbackUrl,
  disabled: isDisabled = false,
  preferRememberedProvider: shouldPreferRememberedProvider = false,
  menuLabel = "Choose sign in provider",
}: {
  buttonLabel?: string;
  callbackUrl: string;
  /** @external disabled */
  disabled?: boolean;
  /** @external preferRememberedProvider */
  preferRememberedProvider?: boolean;
  menuLabel?: string;
}) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [rememberedProvider, setRememberedProvider] = useState<MeetingAuthProvider | undefined>();

  useEffect(() => {
    const providerId = shouldPreferRememberedProvider ? readRememberedAuthProvider() : null;
    setRememberedProvider(MEETING_AUTH_PROVIDERS.find((provider) => provider.id === providerId));
  }, [shouldPreferRememberedProvider]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      const isOutsideMenu =
        target instanceof Node ? !(rootRef.current?.contains(target) ?? false) : rootRef.current !== null;

      if (isOutsideMenu) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="meeting-join-auth workspace-calendar-connect" ref={rootRef}>
      <button
        className="public-home-nav-login meeting-join-signin"
        type="button"
        aria-controls={isOpen ? menuId : undefined}
        aria-expanded={rememberedProvider !== undefined ? undefined : isOpen}
        aria-haspopup={rememberedProvider !== undefined ? undefined : "menu"}
        disabled={isDisabled}
        onClick={() => {
          if (rememberedProvider !== undefined) {
            void startOAuthSignIn(rememberedProvider.id, callbackUrl);
          } else {
            setIsOpen((isMenuOpen) => !isMenuOpen);
          }
        }}
      >
        {rememberedProvider !== undefined ? (
          <span className="meeting-join-provider-button-content">
            {rememberedProvider.id === "google" ? <GoogleIcon /> : <MicrosoftIcon />}
            <span>{rememberedProvider.label}</span>
          </span>
        ) : (
          buttonLabel
        )}
      </button>
      {isOpen ? (
        <div
          className="workspace-calendar-provider-picker meeting-join-auth-provider-picker"
          id={menuId}
          role="menu"
          aria-label={menuLabel}
        >
          {MEETING_AUTH_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                void startOAuthSignIn(provider.id, callbackUrl);
              }}
            >
              {provider.logo}
              <span>{provider.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
