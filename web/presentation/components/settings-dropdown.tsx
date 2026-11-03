"use client";

import { useEffect, useId, useRef } from "react";

export type SettingsDropdownOption<Value extends string> = {
  value: Value;
  title: string;
  description?: string;
};

export function SettingsDropdown<Value extends string>({
  value,
  options,
  isOpen,
  ariaLabel,
  className,
  isDisabled = false,
  onOpenChange,
  onSelect,
}: {
  value: Value;
  options: readonly SettingsDropdownOption<Value>[];
  isOpen: boolean;
  ariaLabel: string;
  className?: string;
  isDisabled?: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onSelect: (value: Value) => void;
}) {
  const menuId = useId();
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      const isInsideDropdown = target instanceof Node ? (dropdownRef.current?.contains(target) ?? false) : false;
      if (!isInsideDropdown) {
        onOpenChange(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onOpenChange(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onOpenChange]);

  if (!selectedOption) {
    return null;
  }

  return (
    <div
      ref={dropdownRef}
      className={`settings-kind-dropdown${className !== undefined && className !== "" ? ` ${className}` : ""}`}
    >
      <button
        type="button"
        className="settings-kind-dropdown-button"
        aria-label={`${ariaLabel}: ${selectedOption.title}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        disabled={isDisabled}
        onClick={() => onOpenChange(!isOpen)}
      >
        <span>{selectedOption.title}</span>
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
      </button>
      {isOpen ? (
        <div id={menuId} className="settings-kind-dropdown-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`settings-kind-dropdown-option${option.value === value ? " is-selected" : ""}`}
              onClick={() => {
                onOpenChange(false);
                onSelect(option.value);
              }}
            >
              <span className="settings-kind-dropdown-option-title">{option.title}</span>
              {option.description !== undefined && option.description !== "" ? <span>{option.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
