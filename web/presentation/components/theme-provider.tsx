"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  applyReadyTheme,
  isReadyTheme,
  readStoredTheme,
  READY_THEME_STORAGE_KEY,
  type ReadyTheme,
} from "../../domain/theme";

const THEME_TRANSITION_CLASS_REMOVE_DELAY_MS = 180;
const USE_THEME_OUTSIDE_PROVIDER_MESSAGE = "useTheme must be used inside ThemeProvider.";

type ThemeContextValue = {
  theme: ReadyTheme;
  setTheme: (theme: ReadyTheme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function currentDocumentTheme(isAppearanceEnabled: boolean): ReadyTheme {
  if (!isAppearanceEnabled || typeof document === "undefined") {
    return "light";
  }

  return readStoredTheme(typeof window === "undefined" ? null : window.localStorage);
}

export function ThemeProvider({
  appearanceEnabled: isAppearanceEnabled = true,
  fixedTheme,
  children,
}: {
  /** @external ThemeProvider consumer prop */
  appearanceEnabled?: boolean;
  fixedTheme?: ReadyTheme;
  children: React.ReactNode;
}) {
  const [theme, setThemeState] = useState<ReadyTheme>(fixedTheme ?? "light");
  const transitionTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const initialTheme = fixedTheme ?? currentDocumentTheme(isAppearanceEnabled);
    applyReadyTheme({ root: document.documentElement, theme: initialTheme });
    setThemeState(initialTheme);

    const handleStorage = (event: StorageEvent) => {
      if (fixedTheme !== undefined) {
        return;
      }
      if (event.key !== READY_THEME_STORAGE_KEY && event.key !== null) {
        return;
      }

      const storedTheme = isReadyTheme(event.newValue) ? event.newValue : "light";
      const nextTheme = isAppearanceEnabled ? storedTheme : "light";
      applyReadyTheme({ root: document.documentElement, theme: nextTheme });
      setThemeState(nextTheme);
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
    };
  }, [isAppearanceEnabled, fixedTheme]);

  const setTheme = useCallback(
    (nextTheme: ReadyTheme) => {
      if (fixedTheme !== undefined) {
        return;
      }
      const root = document.documentElement;
      const appliedTheme = isAppearanceEnabled ? nextTheme : "light";
      root.classList.add("theme-is-changing");
      applyReadyTheme({ root, theme: appliedTheme });
      setThemeState(appliedTheme);

      try {
        window.localStorage.setItem(READY_THEME_STORAGE_KEY, nextTheme);
      } catch (error) {
        void error;
        // The appearance still applies for this page when storage is unavailable.
      }

      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
      transitionTimerRef.current = window.setTimeout(() => {
        root.classList.remove("theme-is-changing");
        transitionTimerRef.current = null;
      }, THEME_TRANSITION_CLASS_REMOVE_DELAY_MS);
    },
    [isAppearanceEnabled, fixedTheme],
  );

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error(USE_THEME_OUTSIDE_PROVIDER_MESSAGE);
  }

  return value;
}
