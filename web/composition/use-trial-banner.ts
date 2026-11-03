"use client";

import { useCallback, useEffect, useState } from "react";

const DISMISSED_KEY = "ready:beta-credit-card-dismissed";

type TrialBannerPreference = {
  userId: string;
  /** @external Trial banner visibility persisted in local storage */
  visible: boolean;
};

type TrialBannerState = {
  /** @external useTrialBanner hook return field */
  visible: boolean;
  dismiss: () => void;
};

export function useTrialBanner(input: { userId: string | null; isAuthLoading: boolean }): TrialBannerState {
  const { userId, isAuthLoading } = input;
  const [preference, setPreference] = useState<TrialBannerPreference | null>(null);

  useEffect(() => {
    if (isAuthLoading || userId === null || userId === "") {
      return;
    }
    try {
      const isVisible = window.localStorage.getItem(`${DISMISSED_KEY}:${userId}`) !== "1";
      setPreference({ userId, visible: isVisible });
    } catch (error) {
      void error;
      // Keep an in-memory dismissal through background auth refreshes when
      // browser storage is blocked. Never borrow another account's preference.
      setPreference((current) => (current?.userId === userId ? current : { userId, visible: true }));
    }
  }, [isAuthLoading, userId]);

  const dismiss = useCallback(() => {
    if (userId === null || userId === "") {
      return;
    }
    setPreference({ userId, visible: false });
    try {
      window.localStorage.setItem(`${DISMISSED_KEY}:${userId}`, "1");
    } catch (error) {
      void error;
      // The in-memory preference still hides the banner.
    }
  }, [userId]);

  const isPreferenceVisible = preference !== null && preference.userId === userId && preference.visible;

  return {
    visible: !isAuthLoading && userId !== null && userId !== "" && isPreferenceVisible,
    dismiss,
  };
}
