"use client";

import { type ReactNode, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

const MOBILE_MENU_MAX_WIDTH_PX = 760;
const CORRECTION_MAX_LENGTH = 2000;

const visibleMenus = new Map<symbol, string>();
const menuListeners = new Set<() => void>();
const hasBothMenus = () => {
  const providers = new Set(visibleMenus.values());

  return providers.size > 1;
};
const subscribeMenus = (listener: () => void) => {
  menuListeners.add(listener);

  return () => {
    menuListeners.delete(listener);
  };
};

type Choice = {
  label: string;
  onSend: () => void;
  /** @external Integration action choice disabled state */
  disabled?: boolean;
};

type IntegrationActionMenuProps = {
  provider: string;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  choices: Choice[];
  correction: string;
  onCorrection: (value: string) => void;
  onRevise: () => void;
  /** @external IntegrationActionMenu consumer prop */
  busy?: boolean;
  /** @external IntegrationActionMenu consumer prop */
  correctionDisabled?: boolean;
  children?: ReactNode;
};

function useIntegrationMenuMobileLayout() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(`(max-width: ${MOBILE_MENU_MAX_WIDTH_PX}px)`);
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  return isMobile;
}

function useIntegrationMenuVisibility(provider: string) {
  useLayoutEffect(() => {
    const id = Symbol(provider);
    visibleMenus.set(id, provider);
    menuListeners.forEach((listener) => {
      listener();
    });

    return () => {
      visibleMenus.delete(id);
      menuListeners.forEach((listener) => {
        listener();
      });
    };
  }, [provider]);
}

function useLinearIntegrationShortcuts(input: { provider: string; isBusy: boolean; choices: Choice[] }) {
  const { provider, isBusy, choices } = input;
  useEffect(() => {
    if (provider !== "Linear" || isBusy) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (document.activeElement !== document.body && document.activeElement !== document.documentElement)
      ) {
        return;
      }
      if (event.key.toLowerCase() === "y" && hasBothMenus()) {
        return;
      }
      const index =
        choices.length === 1 && event.key.toLowerCase() === "y"
          ? 0
          : /^[1-9]$/.test(event.key)
            ? Number(event.key) - 1
            : -1;
      const choice = choices[index];
      if (choice !== undefined && !(choice.disabled ?? false)) {
        event.preventDefault();
        choice.onSend();
      }
    };
    window.addEventListener("keydown", handleKey);

    return () => window.removeEventListener("keydown", handleKey);
  }, [provider, isBusy, choices]);
}

function IntegrationActionMenuOptions(input: {
  provider: string;
  choices: Choice[];
  isBusy: boolean;
  isCorrectionDisabled: boolean;
  correction: string;
  isMobile: boolean;
  isBothMenusVisible: boolean;
  onCorrection: (value: string) => void;
  onRevise: () => void;
}) {
  const {
    provider,
    choices,
    isBusy,
    isCorrectionDisabled,
    correction,
    isMobile,
    isBothMenusVisible,
    onCorrection,
    onRevise,
  } = input;
  const trimmedCorrection = correction.trim();
  const canSubmitCorrection = !isBusy && !isCorrectionDisabled && trimmedCorrection !== "";

  return (
    <div className="debug-workspace-linear-options" aria-label={`${provider} options`}>
      {choices.map((choice, index) => (
        <button type="button" key={choice.label} disabled={isBusy || choice.disabled} onClick={choice.onSend}>
          <span>{choice.label}</span>
          {provider === "Linear" && (choices.length > 1 || !isBothMenusVisible) ? (
            <kbd className="debug-workspace-linear-shortcut-key" aria-hidden="true">
              {choices.length === 1 ? "Y" : index + 1}
            </kbd>
          ) : null}
        </button>
      ))}
      <form
        className="debug-workspace-linear-correction-field"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmitCorrection) {
            onRevise();
          }
        }}
      >
        <input
          aria-label={`Tell differently for ${provider}`}
          placeholder={isMobile ? "Suggest a change…" : "No, and tell Ready what to do differently"}
          value={correction}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore="true"
          maxLength={CORRECTION_MAX_LENGTH}
          disabled={isBusy || isCorrectionDisabled}
          onChange={(event) => onCorrection(event.target.value)}
        />
        <button
          type="submit"
          className="debug-workspace-linear-correction-submit"
          aria-label="Submit correction"
          disabled={isBusy || isCorrectionDisabled || trimmedCorrection === ""}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="debug-workspace-linear-correction-submit-icon"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18" />
          </svg>
        </button>
      </form>
    </div>
  );
}

export function IntegrationActionMenu({
  provider,
  icon,
  title,
  description,
  choices,
  correction,
  onCorrection,
  onRevise,
  busy: isBusy = false,
  correctionDisabled: isCorrectionDisabled = false,
  children,
}: IntegrationActionMenuProps) {
  const isBothMenusVisible = useSyncExternalStore(subscribeMenus, hasBothMenus, () => false);
  const isMobile = useIntegrationMenuMobileLayout();
  useIntegrationMenuVisibility(provider);
  useLinearIntegrationShortcuts({ provider, isBusy, choices });

  return (
    <section
      className="debug-workspace-linear-confirmation is-revealed integration-menu-enter"
      aria-label={`${provider} review`}
    >
      <div className="debug-workspace-linear-menu-copy">
        <div className="debug-workspace-linear-confirmation-title">
          <span className="integration-menu-icon">{icon}</span>
          <h5 className="debug-workspace-linear-confirmation-heading">{title}</h5>
        </div>
        <p className="debug-workspace-linear-confirmation-description">{description}</p>
      </div>
      {children}
      <IntegrationActionMenuOptions
        provider={provider}
        choices={choices}
        isBusy={isBusy}
        isCorrectionDisabled={isCorrectionDisabled}
        correction={correction}
        isMobile={isMobile}
        isBothMenusVisible={isBothMenusVisible}
        onCorrection={onCorrection}
        onRevise={onRevise}
      />
    </section>
  );
}
