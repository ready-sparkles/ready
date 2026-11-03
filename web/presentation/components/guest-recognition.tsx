"use client";

import { GUEST_RECOGNITION_NOTICE_VERSION, type GuestRecognitionStatus } from "@readymeet/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { guestRecognitionStatusResponseSchema } from "../../domain/schemas/guest-recognition";

import { TaskCheckboxIcon } from "./task-checkbox-icon";

const GUEST_RECOGNITION_STATUS_FAILED_MESSAGE = "Guest recognition status failed";
const GUEST_RECOGNITION_TURN_OFF_FAILED_MESSAGE = "Could not turn off recognition. Please try again.";
const MEETING_MEMORY_NOTICE_COPY = "This meeting is transcribed and summarized with AI.";
const GUEST_RECOGNITION_REMEMBER_LABEL = "Remember me next time";

async function readGuestRecognitionStatus(input: { response: Response }): Promise<GuestRecognitionStatus> {
  const body: unknown = await input.response.json();

  return guestRecognitionStatusResponseSchema.parse(body);
}

function applyFetchedGuestRecognitionStatus(input: {
  isLifecycleActive: boolean;
  value: GuestRecognitionStatus;
  setIsLoaded: (isLoaded: boolean) => void;
  setIsStatusFailed: (isStatusFailed: boolean) => void;
  setStatus: (status: GuestRecognitionStatus) => void;
  setIsChecked: (isChecked: boolean) => void;
  setIsExplicitOptIn: (isExplicitOptIn: boolean) => void;
}): void {
  if (!input.isLifecycleActive) {
    return;
  }
  input.setIsLoaded(true);
  input.setIsStatusFailed(false);
  input.setStatus(input.value);
  input.setIsChecked(input.value.recognized);
  input.setIsExplicitOptIn(false);
}

function markGuestRecognitionStatusFetchFailed(input: {
  isLifecycleActive: boolean;
  setIsLoaded: (isLoaded: boolean) => void;
  setIsStatusFailed: (isStatusFailed: boolean) => void;
}): void {
  if (!input.isLifecycleActive) {
    return;
  }
  input.setIsLoaded(true);
  input.setIsStatusFailed(true);
}

function useGuestRecognitionStatusSubscription(input: {
  isHookEnabled: boolean;
  setIsLoaded: (isLoaded: boolean) => void;
  setIsStatusFailed: (isStatusFailed: boolean) => void;
  setStatus: (status: GuestRecognitionStatus) => void;
  setIsChecked: (isChecked: boolean) => void;
  setIsExplicitOptIn: (isExplicitOptIn: boolean) => void;
}): void {
  useEffect(() => {
    if (!input.isHookEnabled) {
      return;
    }
    const lifecycle = { isActive: true };
    const refresh = () => {
      void (async () => {
        try {
          const response = await fetch("/api/guest-recognition", { cache: "no-store" });
          if (!response.ok) {
            throw new Error(GUEST_RECOGNITION_STATUS_FAILED_MESSAGE);
          }
          const value = await readGuestRecognitionStatus({ response });
          applyFetchedGuestRecognitionStatus({
            isLifecycleActive: lifecycle.isActive,
            value,
            setIsLoaded: input.setIsLoaded,
            setIsStatusFailed: input.setIsStatusFailed,
            setStatus: input.setStatus,
            setIsChecked: input.setIsChecked,
            setIsExplicitOptIn: input.setIsExplicitOptIn,
          });
        } catch (error) {
          // Joining remains available, but do not claim recognition is off without a result.
          markGuestRecognitionStatusFetchFailed({
            isLifecycleActive: lifecycle.isActive,
            setIsLoaded: input.setIsLoaded,
            setIsStatusFailed: input.setIsStatusFailed,
          });
          if (error instanceof Error) {
            return;
          }
        }
      })();
    };
    refresh();
    window.addEventListener("guest-recognition-changed", refresh);

    return () => {
      lifecycle.isActive = false;
      window.removeEventListener("guest-recognition-changed", refresh);
    };
  }, [
    input.isHookEnabled,
    input.setIsChecked,
    input.setIsExplicitOptIn,
    input.setIsLoaded,
    input.setIsStatusFailed,
    input.setStatus,
  ]);
}

async function applyGuestRecognitionChange(input: {
  isEnabled: boolean;
  isBusy: boolean;
  isStatusFailed: boolean;
  status: GuestRecognitionStatus;
  setError: (error: string) => void;
  setIsChecked: (isChecked: boolean) => void;
  setIsExplicitOptIn: (isExplicitOptIn: boolean) => void;
  setIsBusy: (isBusy: boolean) => void;
  setIsStatusFailed: (isStatusFailed: boolean) => void;
  setStatus: (status: GuestRecognitionStatus | ((previous: GuestRecognitionStatus) => GuestRecognitionStatus)) => void;
}): Promise<void> {
  if (input.isBusy) {
    return;
  }
  input.setError("");
  if (input.isEnabled) {
    input.setIsChecked(true);
    input.setIsExplicitOptIn(true);

    return;
  }
  if (!input.status.recognized && !input.isStatusFailed) {
    input.setIsChecked(false);
    input.setIsExplicitOptIn(false);

    return;
  }
  input.setIsBusy(true);
  try {
    const response = await fetch("/api/guest-recognition", { method: "DELETE" });
    if (!response.ok) {
      throw new Error();
    }
    input.setIsChecked(false);
    input.setIsExplicitOptIn(false);
    input.setIsStatusFailed(false);
    input.setStatus((previous) => ({ ...previous, recognized: false, lastDisplayName: null }));
    window.dispatchEvent(new Event("guest-recognition-changed"));
  } catch (error) {
    if (error instanceof Error) {
      input.setError(GUEST_RECOGNITION_TURN_OFF_FAILED_MESSAGE);
    }
  } finally {
    input.setIsBusy(false);
  }
}

export function useGuestRecognition(
  ...[isHookEnabled = true]: [/** @external guest recognition hook enablement */ enabled?: boolean]
) {
  const [status, setStatus] = useState<GuestRecognitionStatus>({
    available: false,
    recognized: false,
  });
  const [isLoaded, setIsLoaded] = useState(false);
  const [isStatusFailed, setIsStatusFailed] = useState(false);
  const [isChecked, setIsChecked] = useState(false);
  const [isExplicitOptIn, setIsExplicitOptIn] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  useGuestRecognitionStatusSubscription({
    isHookEnabled,
    setIsLoaded,
    setIsStatusFailed,
    setStatus,
    setIsChecked,
    setIsExplicitOptIn,
  });
  async function change(isEnabled: boolean) {
    await applyGuestRecognitionChange({
      isEnabled,
      isBusy,
      isStatusFailed,
      status,
      setError,
      setIsChecked,
      setIsExplicitOptIn,
      setIsBusy,
      setIsStatusFailed,
      setStatus,
    });
  }

  return {
    ...status,
    /** @external guest recognition control wire field */
    checked: isChecked,
    /** @external guest recognition control wire field */
    loaded: isLoaded,
    /** @external guest recognition control wire field */
    statusFailed: isStatusFailed,
    /** @external guest recognition control wire field */
    busy: isBusy,
    error,
    change,
    choice: {
      /** @external guest recognition choice wire field */
      enabled: isChecked,
      noticeVersion: GUEST_RECOGNITION_NOTICE_VERSION,
      /** @external guest recognition choice wire field */
      explicitOptIn: isExplicitOptIn,
    },
  };
}
export type GuestRecognitionControl = ReturnType<typeof useGuestRecognition>;

/** Only autofill untouched fields; a delayed preference response must never replace typing. */
const MAX_GUEST_DISPLAY_NAME_LENGTH = 60;

export function useRememberedGuestName(
  ...[control, isAutofillEnabled = true]: [
    control: GuestRecognitionControl,
    /** @external guest recognition autofill hook enablement */ enabled?: boolean,
  ]
) {
  const [name, setName] = useState("");
  const edited = useRef(false);
  useEffect(() => {
    if (edited.current) {
      return;
    }
    setName(
      isAutofillEnabled && control.recognized
        ? (control.lastDisplayName ?? "").slice(0, MAX_GUEST_DISPLAY_NAME_LENGTH)
        : "",
    );
  }, [isAutofillEnabled, control.recognized, control.lastDisplayName]);
  const editName = useCallback((value: string) => {
    edited.current = true;
    setName(value);
  }, []);

  return [name, editName] as const;
}

export function MeetingMemoryNotice() {
  return <p className="guest-memory-notice">{MEETING_MEMORY_NOTICE_COPY}</p>;
}
export function GuestRecognitionChoice({
  control,
  disabled: isDisabled = false,
}: {
  control: GuestRecognitionControl;
  /** @external guest recognition choice disabled */
  disabled?: boolean;
}) {
  if (!control.available && !control.recognized) {
    return null;
  }

  return (
    <div className="guest-recognition-choice">
      <label>
        <span className="guest-recognition-checkbox">
          <input
            type="checkbox"
            checked={control.checked}
            disabled={isDisabled || control.busy}
            onChange={(event) => void control.change(event.target.checked)}
          />
          <TaskCheckboxIcon checked={control.checked} />
        </span>
        <span>{GUEST_RECOGNITION_REMEMBER_LABEL}</span>
      </label>
      {control.error.length > 0 ? <p role="alert">{control.error}</p> : null}
    </div>
  );
}
