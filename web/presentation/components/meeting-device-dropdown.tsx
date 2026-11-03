"use client";

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";

function DeviceDropdownChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 8" className="settings-kind-dropdown-chevron">
      <path
        d="M1.2 1.4L6 6.2L10.8 1.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SpeakerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="control-button-icon speaker-control-button-icon" fill="none">
      <path
        d="M4.5 9.25C4.5 8.55964 5.05964 8 5.75 8H8.42L13.11 4.43C13.77 3.93 14.72 4.4 14.72 5.23V18.77C14.72 19.6 13.77 20.07 13.11 19.57L8.42 16H5.75C5.05964 16 4.5 15.4404 4.5 14.75V9.25Z"
        fill="currentColor"
      />
      <path
        d="M17.15 8.35C18.05 9.25 18.55 10.54 18.55 12C18.55 13.46 18.05 14.75 17.15 15.65"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M19.75 6.25C21.1 7.7 21.85 9.72 21.85 12C21.85 14.28 21.1 16.3 19.75 17.75"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatDeviceLabel(input: { device: MediaDeviceInfo; index: number; fallbackLabel: string }): string {
  const label = input.device.label.replace(/\s+\([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)$/u, "").trim();

  return label.length > 0 ? label : `${input.fallbackLabel} ${input.index + 1}`;
}

type MeetingDeviceDropdownProps = {
  ariaLabel: string;
  devices: MediaDeviceInfo[];
  /** @external standard disabled control state */
  disabled?: boolean;
  fallbackLabel: string;
  icon: ReactNode;
  onChange: (deviceId: string) => void;
  value: string;
};

function MeetingDeviceDropdownMenu(input: {
  ariaLabel: string;
  devices: MediaDeviceInfo[];
  fallbackLabel: string;
  listboxId: string;
  onChange: (deviceId: string) => void;
  onClose: () => void;
  value: string;
}) {
  return (
    <div
      className="settings-kind-dropdown-menu meeting-join-device-menu"
      id={input.listboxId}
      role="listbox"
      aria-label={input.ariaLabel}
    >
      {input.devices.map((device, index) => {
        const isSelected = device.deviceId === input.value;

        return (
          <button
            key={device.deviceId}
            type="button"
            className={`settings-kind-dropdown-option meeting-join-device-menu-option${isSelected ? " is-selected" : ""}`}
            role="option"
            aria-selected={isSelected}
            onClick={() => {
              input.onChange(device.deviceId);
              input.onClose();
            }}
          >
            <strong>{formatDeviceLabel({ device, index, fallbackLabel: input.fallbackLabel })}</strong>
          </button>
        );
      })}
    </div>
  );
}

export function MeetingDeviceDropdown(props: Readonly<MeetingDeviceDropdownProps>) {
  const { ariaLabel, devices, fallbackLabel, icon, onChange, value } = props;
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const selectedIndex = devices.findIndex((device) => device.deviceId === value);
  const labelIndex = Math.max(selectedIndex, 0);
  const selectedDevice = devices[labelIndex];
  const selectedLabel = selectedDevice
    ? formatDeviceLabel({ device: selectedDevice, index: labelIndex, fallbackLabel })
    : fallbackLabel;
  const isDisabled = (props.disabled ?? false) || devices.length === 0;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      const isInsideRoot = target instanceof Node && rootRef.current !== null && rootRef.current.contains(target);
      if (!isInsideRoot) {
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

  useEffect(() => {
    if (isDisabled) {
      setIsOpen(false);
    }
  }, [isDisabled]);

  const handleButtonKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  return (
    <div className="settings-kind-dropdown meeting-join-device-dropdown" ref={rootRef}>
      <button
        type="button"
        className={`settings-kind-dropdown-button meeting-join-device-dropdown-button${isOpen ? " is-open" : ""}`}
        aria-label={ariaLabel}
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        disabled={isDisabled}
        onClick={() => setIsOpen((isCurrentlyOpen) => !isCurrentlyOpen)}
        onKeyDown={handleButtonKeyDown}
      >
        <span className="meeting-join-device-dropdown-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="meeting-join-device-dropdown-label">{selectedLabel}</span>
        <DeviceDropdownChevronIcon />
      </button>
      {isOpen ? (
        <MeetingDeviceDropdownMenu
          ariaLabel={ariaLabel}
          devices={devices}
          fallbackLabel={fallbackLabel}
          listboxId={listboxId}
          onChange={onChange}
          onClose={() => setIsOpen(false)}
          value={value}
        />
      ) : null}
    </div>
  );
}
