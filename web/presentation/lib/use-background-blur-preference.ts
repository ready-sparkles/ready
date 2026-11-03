import { useEffect, useState } from "react";

import { getMediaPreferences } from "../../composition/api";

/** An explicit waiting-room choice wins even while the saved preference loads. */
export function useBackgroundBlurPreference(token: string | undefined): {
  isBackgroundBlurEnabled: boolean;
  isBackgroundBlurPreferenceReady: boolean;
  setBackgroundBlurEnabled: (isEnabled: boolean) => void;
} {
  const [isChosenEnabled, setBackgroundBlurEnabled] = useState<boolean>();
  const [saved, setSaved] = useState<{ token: string; isEnabled: boolean }>();

  useEffect(() => {
    if (token === undefined) {
      return;
    }
    const request = { isCancelled: false };
    void (async () => {
      try {
        const preferences = await getMediaPreferences(token);
        if (!request.isCancelled) {
          setSaved({ token, isEnabled: preferences.backgroundBlurEnabled });
        }
      } catch (error) {
        void error;
        if (!request.isCancelled) {
          setSaved({ token, isEnabled: false });
        }
      }
    })();

    return () => {
      request.isCancelled = true;
    };
  }, [token]);

  return {
    isBackgroundBlurEnabled: isChosenEnabled ?? (saved?.token === token ? (saved?.isEnabled ?? false) : false),
    isBackgroundBlurPreferenceReady: isChosenEnabled !== undefined || token === undefined || saved?.token === token,
    setBackgroundBlurEnabled,
  };
}
