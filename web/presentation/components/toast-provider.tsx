"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

const TOAST_STORAGE_KEY = "readymeet-toast";
const TOAST_AUTO_DISMISS_MS = 5000;
const DEFAULT_TOAST_TITLE = "Notice";
const TOAST_DISMISS_LABEL = "Dismiss notification";
const TOAST_CLOSE_SYMBOL = "×";
const USE_TOAST_OUTSIDE_PROVIDER_MESSAGE = "useToast must be used within ToastProvider.";

type ToastTone = "info" | "success" | "warning";

export type ToastInput = {
  id: string;
  title?: string;
  message: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
};

type Toast = {
  id: string;
  title: string;
  message: string;
  tone: ToastTone;
  action?: ToastInput["action"];
};

type ToastContextValue = {
  showToast: (toast: ToastInput) => void;
  dismissToast: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function clearStoredToast(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(TOAST_STORAGE_KEY);
  } catch (error) {
    if (!(error instanceof DOMException)) {
      throw error;
    }
  }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    clearStoredToast();
  }, []);

  useEffect(() => {
    if (toast === null) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToast(null);
      clearStoredToast();
    }, TOAST_AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  const showToast = useCallback((input: ToastInput) => {
    const trimmedTitle = input.title?.trim();
    const nextToast: Toast = {
      id: input.id,
      title: trimmedTitle !== undefined && trimmedTitle.length > 0 ? trimmedTitle : DEFAULT_TOAST_TITLE,
      message: input.message,
      tone: input.tone ?? "info",
      action: input.action,
    };

    setToast(nextToast);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToast((current) => (current?.id === id ? null : current));
    clearStoredToast();
  }, []);

  const value = useMemo(
    () => ({
      showToast,
      dismissToast,
    }),
    [dismissToast, showToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast !== null ? (
        <section className={`workspace-toast is-${toast.tone}`} role="status" aria-live="polite">
          <InfoCircleIcon />
          <div className="workspace-toast-copy">
            <strong>{toast.title}</strong>
            <p>{toast.message}</p>
            {toast.action !== undefined ? (
              <button type="button" className="workspace-toast-action" onClick={toast.action.onClick}>
                {toast.action.label}
              </button>
            ) : null}
          </div>
          <button type="button" aria-label={TOAST_DISMISS_LABEL} onClick={() => dismissToast(toast.id)}>
            {TOAST_CLOSE_SYMBOL}
          </button>
        </section>
      ) : null}
    </ToastContext.Provider>
  );
}

function InfoCircleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 22.2578 21.9248" className="workspace-toast-icon">
      <path
        d="M10.957 21.9141C17.0049 21.9141 21.9141 17.0049 21.9141 10.957C21.9141 4.90918 17.0049 0 10.957 0C4.90918 0 0 4.90918 0 10.957C0 17.0049 4.90918 21.9141 10.957 21.9141ZM10.957 20.0879C5.9082 20.0879 1.82617 16.0059 1.82617 10.957C1.82617 5.9082 5.9082 1.82617 10.957 1.82617C16.0059 1.82617 20.0879 5.9082 20.0879 10.957C20.0879 16.0059 16.0059 20.0879 10.957 20.0879Z"
        fill="currentColor"
      />
      <path
        d="M9.07715 16.9727L13.4492 16.9727C13.8896 16.9727 14.2334 16.6504 14.2334 16.21C14.2334 15.791 13.8896 15.458 13.4492 15.458L12.1172 15.458L12.1172 9.99023C12.1172 9.41016 11.8271 9.02344 11.2793 9.02344L9.25977 9.02344C8.81934 9.02344 8.47559 9.35645 8.47559 9.77539C8.47559 10.2158 8.81934 10.5381 9.25977 10.5381L10.4092 10.5381L10.4092 15.458L9.07715 15.458C8.63672 15.458 8.29297 15.791 8.29297 16.21C8.29297 16.6504 8.63672 16.9727 9.07715 16.9727ZM10.8604 7.24023C11.6445 7.24023 12.2568 6.61719 12.2568 5.83301C12.2568 5.04883 11.6445 4.42578 10.8604 4.42578C10.0869 4.42578 9.46387 5.04883 9.46387 5.83301C9.46387 6.61719 10.0869 7.24023 10.8604 7.24023Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context === null) {
    throw new Error(USE_TOAST_OUTSIDE_PROVIDER_MESSAGE);
  }

  return context;
}
