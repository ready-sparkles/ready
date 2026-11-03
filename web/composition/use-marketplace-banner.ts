"use client";

import { useCallback, useEffect, useState } from "react";

const DISMISSED_KEY = "ready:marketplace-banner-dismissed";
const DISMISSED_STORAGE_VALUE = "1";

export function useMarketplaceBanner(input: { userId: string | null; isAuthLoading: boolean }): {
  /** @external existing wire contract */
  visible: boolean;
  /** @external existing wire contract */
  showTrial: boolean;
  dismiss: () => void;
} {
  const { userId, isAuthLoading } = input;
  const [preference, setPreference] = useState<{
    userId: string;
    /** @external existing wire contract */
    visible: boolean;
    /** @external existing wire contract */
    showTrial: boolean;
  } | null>(null);

  useEffect(() => {
    if (isAuthLoading) {
      return;
    }
    if (userId === null || userId === "") {
      setPreference(null);

      return;
    }
    // Preserve a dismissal during this session, including background auth refreshes.
    setPreference((current) => {
      if (current?.userId === userId) {
        return current;
      }
      const isDismissed = (() => {
        try {
          return window.localStorage.getItem(`${DISMISSED_KEY}:${userId}`) === DISMISSED_STORAGE_VALUE;
        } catch (error: unknown) {
          if (error instanceof Error) {
            // The banner can still be dismissed for this session without storage.
          }

          return false;
        }
      })();

      return { userId, visible: !isDismissed, showTrial: isDismissed };
    });
  }, [userId, isAuthLoading]);

  const dismiss = useCallback(() => {
    if (userId === null || userId === "") {
      return;
    }
    setPreference({ userId, visible: false, showTrial: false });
    try {
      window.localStorage.setItem(`${DISMISSED_KEY}:${userId}`, DISMISSED_STORAGE_VALUE);
    } catch (error: unknown) {
      if (error instanceof Error) {
        // Keep the in-memory dismissal when browser storage is unavailable.
      }
    }
  }, [userId]);

  const isReady = !isAuthLoading && preference?.userId === userId;
  const hasUserId = userId !== null && userId !== "";
  const activePreference = isReady ? preference : null;

  return {
    visible: hasUserId && activePreference !== null && activePreference.visible,
    showTrial: !isAuthLoading && (!hasUserId || (activePreference !== null && activePreference.showTrial)),
    dismiss,
  };
}
