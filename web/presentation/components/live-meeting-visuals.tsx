"use client";

// Shared presentational pieces of the live meeting room: participant tiles,
// control-bar icons, and status labels, exactly as the room renders them.
// The public home page reuses these so its product showcase stays 1:1 with
// the product. Keep this file free of LiveKit/runtime dependencies.

import { useEffect, useId, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";

import type { ParticipantSpeechSource } from "../../domain/participant-speech-store";

import { AvatarSpeechFrame } from "./avatar-speech-frame";

import avatarTileStyles from "./live-avatar-tile.module.css";

const CAPTIONS_WAVE_LEVEL_GAMMA = 0.7;
const CAPTIONS_WAVE_LEVEL_SCALE = 1.85;
const CAPTIONS_WAVE_BAR_WIDTH = 25.1309;
const CAPTIONS_WAVE_BAR_RX = 12.5655;
const CAPTIONS_WAVE_BAR_X_FIRST = 0;
const CAPTIONS_WAVE_BAR_X_SECOND = 40.208;
const CAPTIONS_WAVE_BAR_X_THIRD = 80.4199;
const CAPTIONS_WAVE_BAR_X_FOURTH = 120.627;
const CAPTIONS_WAVE_BAR_MULTIPLIER_FIRST = 0.42;
const CAPTIONS_WAVE_BAR_MULTIPLIER_SECOND = 0.8;
const CAPTIONS_WAVE_BAR_MULTIPLIER_THIRD = 1;
const CAPTIONS_WAVE_BAR_MULTIPLIER_FOURTH = 0.68;
const CAPTIONS_WAVE_BAR_LAYOUT = [
  {
    x: CAPTIONS_WAVE_BAR_X_FIRST,
    width: CAPTIONS_WAVE_BAR_WIDTH,
    rx: CAPTIONS_WAVE_BAR_RX,
    multiplier: CAPTIONS_WAVE_BAR_MULTIPLIER_FIRST,
  },
  {
    x: CAPTIONS_WAVE_BAR_X_SECOND,
    width: CAPTIONS_WAVE_BAR_WIDTH,
    rx: CAPTIONS_WAVE_BAR_RX,
    multiplier: CAPTIONS_WAVE_BAR_MULTIPLIER_SECOND,
  },
  {
    x: CAPTIONS_WAVE_BAR_X_THIRD,
    width: CAPTIONS_WAVE_BAR_WIDTH,
    rx: CAPTIONS_WAVE_BAR_RX,
    multiplier: CAPTIONS_WAVE_BAR_MULTIPLIER_THIRD,
  },
  {
    x: CAPTIONS_WAVE_BAR_X_FOURTH,
    width: CAPTIONS_WAVE_BAR_WIDTH,
    rx: CAPTIONS_WAVE_BAR_RX,
    multiplier: CAPTIONS_WAVE_BAR_MULTIPLIER_FOURTH,
  },
];
const CAPTIONS_WAVE_WOBBLE_BASE_ACTIVE = 0.84;
const CAPTIONS_WAVE_WOBBLE_PHASE_STEP = 0.9;
const CAPTIONS_WAVE_WOBBLE_AMPLITUDE = 0.32;
const CAPTIONS_WAVE_WOBBLE_BASE_IDLE = 0.82;
const CAPTIONS_WAVE_BAR_SCALE_MIN = 0.24;
const CAPTIONS_WAVE_SVG_HEIGHT = 160;
const CAPTIONS_WAVE_CENTER_DIVISOR = 2;
const CAPTIONS_WAVE_GRADIENT_STOP_OPACITY_ACTIVE = 0.95;
const CAPTIONS_WAVE_GRADIENT_STOP_OPACITY_IDLE = 0.7;
const VOICE_MODE_COMPOSING_ORB_SIZE = 64;
const VOICE_MODE_COMPOSING_ORB_DISPLAY_PX = 36;
const VOICE_MODE_COMPOSING_ORB_OPACITY = 0.65;
const USER_INITIALS_MAX_CHARS = 2;
const DEFAULT_PARTICIPANT_LABEL = "Participant";
const DEFAULT_USER_INITIALS_SOURCE = "ReadyMeet User";
const FALLBACK_USER_INITIAL = "R";

function isNonEmptyNullableString(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value.length > 0;
}

function getInitialsSource(input: { displayName?: string | null; email?: string | null }): string {
  const trimmedDisplayName = input.displayName?.trim();
  if (trimmedDisplayName !== undefined && trimmedDisplayName.length > 0) {
    return trimmedDisplayName;
  }

  const trimmedEmail = input.email?.trim();
  if (trimmedEmail !== undefined && trimmedEmail.length > 0) {
    return trimmedEmail;
  }

  return DEFAULT_USER_INITIALS_SOURCE;
}

function getAvatarTileAccessibleLabel(input: {
  displayName: string | null | undefined;
  callerPhoneNumber: string | null | undefined;
}): string {
  const participantLabel = isNonEmptyNullableString(input.displayName) ? input.displayName : DEFAULT_PARTICIPANT_LABEL;
  if (isNonEmptyNullableString(input.callerPhoneNumber)) {
    return `${participantLabel} ${formatDialInPhoneNumber(input.callerPhoneNumber)}`;
  }

  return participantLabel;
}

export function CaptionsWaveIcon({
  isEnabled,
  isActive,
  isError,
  level,
  phase,
}: {
  isEnabled: boolean;
  isActive: boolean;
  isError: boolean;
  level: number;
  phase: number;
}) {
  const normalizedLevel = Math.min(
    1,
    Math.max(0, Math.pow(level, CAPTIONS_WAVE_LEVEL_GAMMA) * CAPTIONS_WAVE_LEVEL_SCALE),
  );
  const gradientIdPrefix = useId().replace(/:/g, "");
  const bars = CAPTIONS_WAVE_BAR_LAYOUT;
  const barScales = bars.map((bar, index) => {
    const wobble = isActive
      ? CAPTIONS_WAVE_WOBBLE_BASE_ACTIVE +
        Math.abs(Math.sin(phase + index * CAPTIONS_WAVE_WOBBLE_PHASE_STEP)) * CAPTIONS_WAVE_WOBBLE_AMPLITUDE
      : CAPTIONS_WAVE_WOBBLE_BASE_IDLE;

    return CAPTIONS_WAVE_BAR_SCALE_MIN + normalizedLevel * bar.multiplier * wobble;
  });
  const shouldUseActiveGradient = isEnabled && isActive && !isError;

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 145.758 160"
      className={[
        "captions-wave-icon",
        isEnabled ? "is-enabled" : "is-disabled",
        isActive ? "is-active" : "",
        isError ? "is-error" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <defs>
        {bars.map((bar, index) => (
          <linearGradient
            key={`${gradientIdPrefix}-gradient-${index}`}
            id={`${gradientIdPrefix}-gradient-${index}`}
            x1={bar.x + bar.width / CAPTIONS_WAVE_CENTER_DIVISOR}
            y1={0}
            x2={bar.x + bar.width / CAPTIONS_WAVE_CENTER_DIVISOR}
            y2={CAPTIONS_WAVE_SVG_HEIGHT}
            gradientUnits="userSpaceOnUse"
          >
            <stop
              stopColor={shouldUseActiveGradient ? "#58e7ce" : "currentColor"}
              stopOpacity={
                shouldUseActiveGradient
                  ? CAPTIONS_WAVE_GRADIENT_STOP_OPACITY_ACTIVE
                  : CAPTIONS_WAVE_GRADIENT_STOP_OPACITY_IDLE
              }
            />
            <stop offset="1" stopColor={shouldUseActiveGradient ? "#eef4ff" : "currentColor"} />
          </linearGradient>
        ))}
      </defs>
      {bars.map((bar, index) => (
        <rect
          key={`${gradientIdPrefix}-bar-${index}`}
          x={bar.x}
          y={0}
          width={bar.width}
          height={CAPTIONS_WAVE_SVG_HEIGHT}
          rx={bar.rx}
          fill={`url(#${gradientIdPrefix}-gradient-${index})`}
          style={{ ["--bar-scale" as string]: `${barScales.at(index) ?? CAPTIONS_WAVE_BAR_SCALE_MIN}` }}
          className="captions-wave-bar"
        />
      ))}
    </svg>
  );
}

export function CameraIcon({ isEnabled }: { isEnabled: boolean }) {
  if (!isEnabled) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="control-button-icon camera-control-button-icon"
        fill="none"
      >
        <path d="M5.25 5.25H12.75C14.4069 5.25 15.75 6.59315 15.75 8.25V15.75L5.25 5.25Z" fill="currentColor" />
        <path d="M2.25 8.25L12.75 18.75H5.25C3.59315 18.75 2.25 17.4069 2.25 15.75V8.25Z" fill="currentColor" />
        <path
          d="M16.5 10.1893L20.47 6.2193C20.9425 5.74684 21.75 6.0815 21.75 6.75V17.25C21.75 17.9185 20.9425 18.2532 20.47 17.7807L16.5 13.8107V10.1893Z"
          fill="currentColor"
        />
        <path
          d="M1.29295 1.29289C1.68348 0.902369 2.31649 0.902369 2.70702 1.29289L22.207 20.7929C22.5975 21.1834 22.5975 21.8164 22.207 22.207C21.8165 22.5975 21.1835 22.5975 20.793 22.207L1.29295 2.70696C0.90243 2.31643 0.90243 1.68342 1.29295 1.29289Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="control-button-icon camera-control-button-icon" fill="none">
      <path
        d="M5.25 5.25H12.75C14.4069 5.25 15.75 6.59315 15.75 8.25V15.75C15.75 17.4069 14.4069 18.75 12.75 18.75H5.25C3.59315 18.75 2.25 17.4069 2.25 15.75V8.25C2.25 6.59315 3.59315 5.25 5.25 5.25Z"
        fill="currentColor"
      />
      <path
        d="M16.5 10.1893L20.47 6.2193C20.9425 5.74684 21.75 6.0815 21.75 6.75V17.25C21.75 17.9185 20.9425 18.2532 20.47 17.7807L16.5 13.8107V10.1893Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function BackgroundBlurIcon({ isEnabled }: { isEnabled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`control-button-icon background-blur-control-button-icon${isEnabled ? " is-background-blur-enabled" : ""}`}
      fill="none"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.5513 2.25C13.4654 2.24999 14.9971 2.24998 16.2271 2.37248C16.1143 2.66571 16.0303 2.86761 15.9766 2.98438C15.8159 3.05836 15.502 3.18172 15.003 3.36637L14.3059 3.6243C13.5211 3.91473 13 4.66312 13 5.5C13 6.33688 13.5211 7.08528 14.3059 7.3757L15.003 7.63363C15.502 7.81828 15.8198 7.94164 15.9805 8.01563C16.0545 8.17626 16.1817 8.49803 16.3664 8.99705L16.6243 9.69407C16.9147 10.4789 17.6631 11 18.5 11C19.3369 11 20.0853 10.4789 20.3757 9.69407L20.6336 8.99705C20.8183 8.49803 20.9416 8.17626 21.0156 8.01562C21.1323 7.96186 21.3341 7.88203 21.6272 7.77156C21.75 9.01601 21.75 10.6414 21.75 12.5572C21.75 14.7479 21.75 16.4686 21.5694 17.812C21.3843 19.1886 20.9973 20.2809 20.1391 21.1391C19.2809 21.9973 18.1886 22.3843 16.812 22.5694C15.4686 22.75 13.7479 22.75 11.5572 22.75C9.36646 22.75 7.53144 22.75 6.18802 22.5694C4.81137 22.3843 3.71911 21.9973 2.86091 21.1391C2.00272 20.2809 1.61568 19.1886 1.43059 17.812C1.24998 16.4686 1.24999 14.7479 1.25 12.5572V12.5572C1.24999 10.3665 1.24998 8.53144 1.43059 7.18802C1.61568 5.81137 2.00272 4.71911 2.86091 3.86091C3.71911 3.00272 4.81137 2.61568 6.18802 2.43059C7.53144 2.24998 9.36056 2.24999 11.5513 2.25H11.5513ZM13.9951 10C13.9951 11.3807 12.8742 12.5 11.4915 12.5C10.1089 12.5 8.98797 11.3807 8.98797 10C8.98797 8.61929 10.1089 7.5 11.4915 7.5C12.8742 7.5 13.9951 8.61929 13.9951 10ZM16.6512 16.8779C14.3633 12.874 8.63674 12.874 6.34882 16.8779C6.21617 17.11 6.21713 17.3952 6.35132 17.6264C6.48551 17.8577 6.73265 18 7 18H16C16.2674 18 16.5145 17.8577 16.6487 17.6264C16.7829 17.3952 16.7838 17.11 16.6512 16.8779Z"
        fill="currentColor"
      />
      <path
        d="M18.5 1.25C18.8138 1.25 19.0945 1.4454 19.2034 1.73972L19.4613 2.43675C19.8233 3.4151 19.9388 3.68091 20.1289 3.87106C20.3191 4.06121 20.5849 4.17667 21.5633 4.53869L22.2603 4.79661C22.5546 4.90552 22.75 5.18617 22.75 5.5C22.75 5.81383 22.5546 6.09448 22.2603 6.20339L21.5633 6.46131C20.5849 6.82333 20.3191 6.93879 20.1289 7.12894C19.9388 7.31909 19.8233 7.5849 19.4613 8.56325L19.2034 9.26028C19.0945 9.5546 18.8138 9.75 18.5 9.75C18.1862 9.75 17.9055 9.5546 17.7966 9.26028L17.5387 8.56325C17.1767 7.5849 17.0612 7.31909 16.8711 7.12894C16.6809 6.93879 16.4151 6.82333 15.4367 6.46131L14.7397 6.20339C14.4454 6.09448 14.25 5.81383 14.25 5.5C14.25 5.18617 14.4454 4.90552 14.7397 4.79661L15.4367 4.53869C16.4151 4.17667 16.6809 4.06121 16.8711 3.87106C17.0612 3.68091 17.1767 3.4151 17.5387 2.43675L17.7966 1.73972C17.9055 1.4454 18.1862 1.25 18.5 1.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ScreenShareIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="control-button-icon screen-share-control-button-icon"
      fill="none"
    >
      <path
        d="M7.37159 8.02763C6.9421 7.68041 6.8754 7.05077 7.22262 6.62128L7.22525 6.6181C7.4557 6.34026 8.13855 5.51697 8.4928 5.10724C9.18888 4.30216 10.0839 3.30886 10.7507 2.73239C11.1117 2.42023 11.5726 2.23021 12.0764 2.25158C12.5244 2.2706 12.9279 2.45397 13.2502 2.73274C13.9167 3.30923 14.8117 4.30239 15.5077 5.1074C15.8633 5.51865 16.1801 5.8962 16.408 6.17085C16.5215 6.3077 16.7119 6.54056 16.7764 6.61945L16.7773 6.62047C17.1245 7.04993 17.0585 7.68032 16.629 8.02757C16.1996 8.37482 15.57 8.30818 15.2227 7.87875C15.001 7.61154 14.3393 6.81385 13.9949 6.41553C13.6841 6.05615 13.3533 5.68253 13.034 5.33694L13.034 14.75C13.034 15.3023 12.5863 15.75 12.034 15.75C11.4817 15.75 11.034 15.3023 11.034 14.75L11.034 5.26397C10.6941 5.62946 10.3384 6.03054 10.0057 6.41532C9.66131 6.81367 9.35361 7.18041 9.13196 7.44765C9.02123 7.58115 8.83924 7.80368 8.77814 7.87841C8.43092 8.30787 7.80107 8.37483 7.37159 8.02763Z"
        fill="currentColor"
      />
      <path
        d="M9.78404 10.2499H8.94631C7.81352 10.2499 6.88773 10.2498 6.15689 10.3481C5.39294 10.4508 4.7306 10.6731 4.20191 11.2018C3.67321 11.7305 3.45093 12.3928 3.34822 13.1568C3.24996 13.8876 3.24998 14.8133 3.25 15.9461C3.24998 17.0789 3.24996 18.1121 3.34822 18.843C3.45093 19.6069 3.67321 20.2693 4.20191 20.798C4.7306 21.3267 5.39294 21.549 6.15689 21.6517C6.88775 21.7499 7.81348 21.7499 8.94632 21.7499H15.0537C16.1865 21.7499 17.1123 21.7499 17.8431 21.6517C18.6071 21.549 19.2694 21.3267 19.7981 20.798C20.3268 20.2693 20.5491 19.6069 20.6518 18.843C20.75 18.1121 20.75 17.079 20.75 15.9462C20.75 14.8134 20.75 13.8876 20.6518 13.1568C20.5491 12.3928 20.3268 11.7305 19.7981 11.2018C19.2694 10.6731 18.6071 10.4508 17.8431 10.3481C17.1123 10.2498 16.1866 10.2499 15.0538 10.2499H14.284L14.284 14.7499C14.284 15.9925 13.2767 16.9999 12.034 16.9999C10.7914 16.9999 9.78404 15.9925 9.78404 14.7499L9.78404 10.2499Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function PhoneDownIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      viewBox="0 -4 24 24"
      className="control-button-icon hangup-control-button-icon"
      fill="none"
    >
      <path
        d="M16.1172 9.39975L16.1275 9.46503C16.2478 10.2281 16.308 10.6096 16.4949 10.9179C16.5506 11.0096 16.614 11.0956 16.6844 11.1748C16.921 11.4408 17.2531 11.5913 17.9173 11.8922C18.9156 12.3443 19.4147 12.5704 19.8935 12.4804C20.0341 12.4539 20.1709 12.408 20.3005 12.3438C20.7419 12.1251 21.0352 11.6291 21.6219 10.6369C22.2338 9.60219 22.5397 9.08483 22.4959 8.49439C22.486 8.36207 22.4539 8.19426 22.4144 8.06849C22.2379 7.50729 21.8231 7.20265 20.9935 6.59336C15.3777 2.46871 8.62234 2.46873 3.00648 6.59336C2.17691 7.20265 1.76212 7.50729 1.58563 8.06849C1.54607 8.19426 1.51397 8.36207 1.50414 8.4944C1.46027 9.08483 1.76621 9.60219 2.37809 10.6369C2.96479 11.6291 3.25814 12.1251 3.69947 12.3438C3.82907 12.408 3.96588 12.4539 4.10648 12.4804C4.58527 12.5704 5.0844 12.3443 6.08265 11.8922C6.74691 11.5913 7.07904 11.4408 7.31564 11.1748C7.38603 11.0956 7.44944 11.0096 7.50506 10.9179C7.69198 10.6096 7.75215 10.2281 7.87248 9.46503L7.88277 9.39975C8.00698 8.61211 8.06908 8.21829 8.34146 7.85715C8.37956 7.80663 8.44892 7.72641 8.49302 7.68185C8.80822 7.36338 9.08637 7.2896 9.64267 7.14205C11.141 6.74464 12.859 6.74464 14.3573 7.14205C14.9136 7.2896 15.1918 7.36338 15.507 7.68185C15.5511 7.72641 15.6204 7.80663 15.6585 7.85715C15.9309 8.21829 15.993 8.61211 16.1172 9.39975Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function MicrophoneIcon({ isEnabled }: { isEnabled: boolean }) {
  if (!isEnabled) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="control-button-icon microphone-control-button-icon"
        fill="none"
      >
        <path
          d="M1.29295 1.29289C1.68348 0.902369 2.31649 0.902369 2.70702 1.29289L22.207 20.7929C22.5975 21.1834 22.5975 21.8164 22.207 22.207C21.8165 22.5975 21.1835 22.5975 20.793 22.207L1.29295 2.70696C0.90243 2.31643 0.90243 1.68342 1.29295 1.29289Z"
          fill="currentColor"
        />
        <path
          d="M14.5693 14.5713C13.7806 15.1542 12.806 15.5 11.75 15.5C9.12665 15.5 7 13.3734 7 10.75V7.00195L14.5693 14.5713Z"
          fill="currentColor"
        />
        <path
          d="M11.75 1C14.3734 1 16.5 3.12665 16.5 5.75V10.75C16.5 11.4043 16.3672 12.0275 16.1279 12.5947L7.3916 3.8584C8.12266 2.17631 9.79895 1 11.75 1Z"
          fill="currentColor"
        />
        <path
          d="M4.88823 11.0035C5.42134 10.9597 5.88872 11.3511 5.93315 11.8785C6.16511 14.6319 8.49272 16.7494 11.2857 16.7496H12.2144C13.482 16.7495 14.6524 16.3116 15.5757 15.5777L16.9429 16.9449C15.7847 17.9176 14.3191 18.5387 12.7183 18.647V20.5836H14.6568C15.1916 20.5838 15.6255 21.0124 15.6255 21.5416C15.6255 22.0707 15.1917 22.4994 14.6568 22.4996H8.84331C8.30839 22.4994 7.87456 22.0708 7.87456 21.5416C7.8746 21.0124 8.30841 20.5837 8.84331 20.5836H10.7808V18.647C7.20807 18.405 4.30507 15.6172 4.00346 12.0377C3.95903 11.5102 4.35502 11.0474 4.88823 11.0035Z"
          fill="currentColor"
        />
        <path
          d="M18.6119 11.0035C19.1451 11.0474 19.5411 11.5102 19.4966 12.0377C19.4052 13.1225 19.0727 14.1334 18.5572 15.024L17.1236 13.5904C17.361 13.061 17.5158 12.4855 17.5669 11.8785C17.6114 11.3511 18.0787 10.9596 18.6119 11.0035Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="control-button-icon microphone-control-button-icon"
      fill="none"
    >
      <path
        d="M18.862 11.2532C19.3952 11.2972 19.791 11.7599 19.7466 12.2874C19.445 15.8671 16.5417 18.6549 12.9688 18.8967V20.8331H14.9064C15.4414 20.8331 15.8752 21.2622 15.8752 21.7915C15.8752 22.3208 15.4414 22.7498 14.9064 22.7498H9.09361C8.55855 22.7498 8.12481 22.3208 8.12481 21.7915C8.12481 21.2622 8.55855 20.8331 9.09361 20.8331H11.0312V18.8967C7.45826 18.6549 4.55496 15.8671 4.2534 12.2874C4.20897 11.7599 4.60479 11.2972 5.138 11.2532C5.6712 11.2093 6.139 11.6008 6.18343 12.1283C6.41538 14.8817 8.74249 16.9995 11.5355 16.9997H12.4645C15.2575 16.9995 17.5846 14.8817 17.8166 12.1283C17.861 11.6008 18.3288 11.2093 18.862 11.2532Z"
        fill="currentColor"
      />
      <path
        d="M16.75 11.0002C16.75 13.6235 14.6234 15.7502 12 15.7502C9.37665 15.7502 7.25 13.6235 7.25 11.0002V6.00015C7.25 3.3768 9.37665 1.25015 12 1.25015C14.6234 1.25015 16.75 3.3768 16.75 6.00015V11.0002Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function VoiceModeIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="control-button-icon voice-mode-control-button-icon"
      fill="none"
    >
      <path
        d="M7.13889 20.775V3.225C7.13889 2.68652 7.57417 2.25 8.11111 2.25C8.64805 2.25 9.08333 2.68652 9.08333 3.225V20.775C9.08333 21.3135 8.64805 21.75 8.11111 21.75C7.57417 21.75 7.13889 21.3135 7.13889 20.775ZM14.9167 18.825V11.025C14.9167 10.4865 15.3519 10.05 15.8889 10.05C16.4258 10.05 16.8611 10.4865 16.8611 11.025V18.825C16.8611 19.3635 16.4258 19.8 15.8889 19.8C15.3519 19.8 14.9167 19.3635 14.9167 18.825ZM11.0278 16.875V7.125C11.0278 6.58652 11.4631 6.15 12 6.15C12.5369 6.15 12.9722 6.58652 12.9722 7.125V16.875C12.9722 17.4135 12.5369 17.85 12 17.85C11.4631 17.85 11.0278 17.4135 11.0278 16.875ZM3.25 14.925V9.075C3.25 8.53652 3.68528 8.1 4.22222 8.1C4.75917 8.1 5.19444 8.53652 5.19444 9.075V14.925C5.19444 15.4635 4.75917 15.9 4.22222 15.9C3.68528 15.9 3.25 15.4635 3.25 14.925ZM18.8056 13.95V11.025C18.8056 10.4865 19.2408 10.05 19.7778 10.05C20.3147 10.05 20.75 10.4865 20.75 11.025V13.95C20.75 14.4885 20.3147 14.925 19.7778 14.925C19.2408 14.925 18.8056 14.4885 18.8056 13.95Z"
        fill="currentColor"
      />
      <path
        d="M18.5 2.25C18.8228 2.25 19.1098 2.45644 19.2119 2.7627L19.5732 3.84766C19.6645 4.12103 19.879 4.33548 20.1523 4.42676L21.2373 4.78809C21.5436 4.89017 21.75 5.17718 21.75 5.5C21.75 5.82282 21.5436 6.10983 21.2373 6.21191L20.1523 6.57324C19.879 6.66452 19.6645 6.87897 19.5732 7.15234L19.2119 8.2373C19.1098 8.54356 18.8228 8.75 18.5 8.75C18.1772 8.75 17.8902 8.54356 17.7881 8.2373L17.4268 7.15234C17.3355 6.87897 17.121 6.66452 16.8477 6.57324L15.7627 6.21191C15.4564 6.10983 15.25 5.82282 15.25 5.5C15.25 5.17718 15.4564 4.89017 15.7627 4.78809L16.8477 4.42676C17.121 4.33548 17.3355 4.12103 17.4268 3.84766L17.7881 2.7627L17.835 2.65332C17.9625 2.40837 18.2174 2.25 18.5 2.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function VoiceModeComposingOrb() {
  return (
    <ThinkingOrb
      state="composing"
      size={VOICE_MODE_COMPOSING_ORB_SIZE}
      theme="dark"
      className="voice-mode-composing-orb"
      style={{
        width: VOICE_MODE_COMPOSING_ORB_DISPLAY_PX,
        height: VOICE_MODE_COMPOSING_ORB_DISPLAY_PX,
        opacity: VOICE_MODE_COMPOSING_ORB_OPACITY,
      }}
      aria-hidden="true"
    />
  );
}

export function InfoIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="control-button-icon" fill="none">
      <path
        d="M22.75 11.9999C22.75 17.937 17.9371 22.7499 12 22.7499C6.06294 22.7499 1.25 17.937 1.25 11.9999C1.25 6.06288 6.06294 1.24994 12 1.24994C17.9371 1.24994 22.75 6.06288 22.75 11.9999ZM11 8.24994C11 8.80222 11.4477 9.24994 12 9.24994C12.5523 9.24994 13 8.80222 13 8.24994C13 7.69765 12.5523 7.24994 12 7.24994C11.4477 7.24994 11 7.69765 11 8.24994ZM13 15.9999V11.9999C13 11.4477 12.5523 10.9999 12 10.9999C11.4477 10.9999 11 11.4477 11 11.9999V15.9999C11 16.5522 11.4477 16.9999 12 16.9999C12.5523 16.9999 13 16.5522 13 15.9999Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function SettingsGearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="control-button-icon live-settings-trigger-icon" fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.74975 22.4469C10.0241 22.6444 10.3181 22.7181 10.5977 22.75H13.4023C13.6819 22.7181 13.9759 22.6444 14.2503 22.4469C14.5245 22.2495 14.6873 21.9946 14.8058 21.7402C14.9122 21.5117 15.4485 19.9112 15.4485 19.9112C15.4485 19.9112 15.7104 19.4678 15.9256 19.3266C16.3481 19.0495 16.7744 18.9894 17.0521 19.0495C17.0521 19.0495 18.9336 19.5792 19.1993 19.6213C19.4948 19.6681 19.8181 19.674 20.1524 19.5385C20.4866 19.4031 20.714 19.1739 20.893 18.935L22.3316 16.4526C22.4442 16.1934 22.5272 15.9008 22.4917 15.5633C22.4561 15.2258 22.3138 14.9568 22.1496 14.7266C22.0021 14.5199 20.7592 13.1363 20.5441 12.898C20.5441 12.898 20.2841 12.4993 20.2841 11.9998C20.2841 11.4151 20.5441 11.1019 20.5441 11.1019C20.5441 11.1019 22.0021 9.47998 22.1496 9.2733C22.3138 9.04311 22.4561 8.7741 22.4917 8.4366C22.5272 8.09914 22.4442 7.80652 22.3316 7.54733C22.2304 7.31456 20.893 5.06487 20.893 5.06487C20.714 4.82595 20.4866 4.59685 20.1524 4.46138C19.8181 4.32586 19.4948 4.33183 19.1993 4.3786C18.9336 4.42064 17.382 4.85698 17.0521 4.95035C17.0521 4.95035 16.5227 5.06487 15.9256 4.67329C15.7104 4.53218 15.5437 4.32813 15.4484 4.08872C15.4484 4.08872 14.9122 2.48829 14.8058 2.25981C14.6873 2.00543 14.5245 1.75047 14.2503 1.55308C13.9759 1.3556 13.6819 1.28188 13.4023 1.25H10.5977C10.3181 1.28188 10.0241 1.3556 9.74975 1.55308C9.47551 1.75047 9.31274 2.00543 9.19424 2.25981C9.0878 2.48829 8.55157 4.08872 8.55157 4.08872C8.45627 4.32813 8.28956 4.53218 8.07438 4.67329C7.47727 5.06487 6.94794 4.95035 6.94794 4.95035C6.61796 4.85698 5.06641 4.42064 4.80069 4.3786C4.50518 4.33183 4.18189 4.32586 3.84759 4.46138C3.51342 4.59685 3.28602 4.82595 3.10699 5.06487C3.10699 5.06487 1.76957 7.31456 1.66843 7.54733C1.55583 7.80652 1.47276 8.09914 1.50833 8.4366C1.5439 8.7741 1.68619 9.04311 1.85043 9.2733C1.99791 9.47998 3.45586 11.1019 3.45586 11.1019C3.45586 11.1019 3.71591 11.4151 3.71591 11.9998C3.71591 12.4993 3.45588 12.898 3.45588 12.898C3.24083 13.1363 1.99791 14.5199 1.85044 14.7266C1.68619 14.9568 1.5439 15.2258 1.50833 15.5633C1.47276 15.9008 1.55583 16.1934 1.66844 16.4526L3.10697 18.935C3.28601 19.1739 3.51341 19.4031 3.84761 19.5385C4.18191 19.674 4.50519 19.6681 4.80071 19.6213C5.06643 19.5792 6.94789 19.0495 6.94789 19.0495C7.22563 18.9894 7.65193 19.0495 8.07443 19.3266C8.28957 19.4678 8.55153 19.9112 8.55153 19.9112C8.55153 19.9112 9.0878 21.5117 9.19424 21.7402C9.31274 21.9946 9.47551 22.2495 9.74975 22.4469ZM12.0195 15.5C13.9525 15.5 15.5195 13.933 15.5195 12C15.5195 10.067 13.9525 8.5 12.0195 8.5C10.0865 8.5 8.51953 10.067 8.51953 12C8.51953 13.933 10.0865 15.5 12.0195 15.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export { CopyStatusIcon } from "./copy-status-icon";

export function ParticipantTileCallerLabel({ callerPhoneNumber }: { callerPhoneNumber?: string | null }) {
  if (!isNonEmptyNullableString(callerPhoneNumber)) {
    return null;
  }

  return <span className="live-participant-tile-label">{formatDialInPhoneNumber(callerPhoneNumber)}</span>;
}

export function AvatarTile({
  participantId,
  displayName,
  email,
  avatarUrl,
  callerPhoneNumber,
  speechLevel = 0,
  isSpeaking = false,
  speechSource,
  isSpeechVisible = true,
  isFlipTarget = true,
}: {
  participantId: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  callerPhoneNumber?: string | null;
  speechLevel?: number;
  isSpeaking?: boolean;
  speechSource?: ParticipantSpeechSource;
  isSpeechVisible?: boolean;
  isFlipTarget?: boolean;
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const [isImageLoaded, setIsImageLoaded] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const initials = getUserInitials({ displayName, email });
  const shouldShowImage = isNonEmptyNullableString(avatarUrl) && !hasImageError;
  const accessibleLabel = getAvatarTileAccessibleLabel({ displayName, callerPhoneNumber });

  useEffect(() => {
    setHasImageError(false);
    setIsImageLoaded(false);
  }, [avatarUrl]);

  useEffect(() => {
    if (!shouldShowImage || !imageRef.current) {
      return;
    }

    if (imageRef.current.complete && imageRef.current.naturalWidth > 0) {
      setIsImageLoaded(true);
    }
  }, [shouldShowImage, avatarUrl]);

  return (
    <article
      className={[
        "video-tile",
        "live-video-tile",
        isFlipTarget ? "live-video-flip-target" : "",
        avatarTileStyles.avatarTile,
      ]
        .filter(Boolean)
        .join(" ")}
      data-participant-visual-id={isFlipTarget ? participantId : undefined}
      aria-label={accessibleLabel}
    >
      <AvatarSpeechFrame
        speechLevel={speechLevel}
        isSpeaking={isSpeaking}
        speechSource={speechSource}
        isSpeechVisible={isSpeechVisible}
      >
        <div
          className={[
            avatarTileStyles.media,
            !shouldShowImage ? avatarTileStyles.initialsMedia : "",
            shouldShowImage && !isImageLoaded ? avatarTileStyles.mediaLoading : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {shouldShowImage ? (
            <img
              ref={imageRef}
              src={avatarUrl}
              alt={isNonEmptyNullableString(displayName) ? `${displayName} avatar` : "Participant avatar"}
              className={[avatarTileStyles.image, isImageLoaded ? avatarTileStyles.imageReady : ""]
                .filter(Boolean)
                .join(" ")}
              referrerPolicy="no-referrer"
              onLoad={() => setIsImageLoaded(true)}
              onError={() => {
                setHasImageError(true);
                setIsImageLoaded(false);
              }}
            />
          ) : (
            <span className={avatarTileStyles.fallback} aria-hidden="true">
              {initials}
            </span>
          )}
        </div>
      </AvatarSpeechFrame>
      <ParticipantTileCallerLabel callerPhoneNumber={callerPhoneNumber} />
    </article>
  );
}

export function formatDialInPhoneNumber(phoneNumber: string) {
  const normalized = phoneNumber.trim();
  const match = normalized.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (match) {
    const [, areaCode, exchange, subscriber] = match;
    if (areaCode !== undefined && exchange !== undefined && subscriber !== undefined) {
      return `+1 ${areaCode}-${exchange}-${subscriber}`;
    }
  }

  return normalized;
}

export function getUserInitials(input: { displayName?: string | null; email?: string | null }) {
  const source = getInitialsSource(input);
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return FALLBACK_USER_INITIAL;
  }

  const [onlyPart] = parts;
  if (parts.length === 1 && onlyPart !== undefined) {
    return onlyPart.slice(0, USER_INITIALS_MAX_CHARS).toUpperCase();
  }
  const [firstPart, secondPart] = parts;
  if (firstPart === undefined || secondPart === undefined) {
    return FALLBACK_USER_INITIAL;
  }

  return `${firstPart[0] ?? ""}${secondPart[0] ?? ""}`.toUpperCase();
}

export function UserAvatarBadge({
  displayName,
  email,
  avatarUrl,
  className,
  onClick,
  size = "default",
  participantCount,
}: {
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  className?: string;
  onClick?: () => void;
  size?: "default" | "large";
  participantCount?: number;
}) {
  const [hasImageError, setHasImageError] = useState(false);
  const initials = getUserInitials({ displayName, email });
  const shouldShowImage = isNonEmptyNullableString(avatarUrl) && !hasImageError;
  const Tag = onClick ? "button" : "aside";

  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      onPointerUp={onClick ? (event) => event.currentTarget.blur() : undefined}
      className={[
        "live-user-avatar",
        size === "large" ? "is-large" : "",
        typeof participantCount === "number" ? "has-count" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={isNonEmptyNullableString(displayName) ? `${displayName} avatar` : "Your avatar"}
      title={displayName ?? email ?? "Your profile"}
    >
      <span className="live-user-avatar-media">
        {shouldShowImage ? (
          <img
            src={avatarUrl}
            alt={isNonEmptyNullableString(displayName) ? `${displayName} avatar` : "Your avatar"}
            className="live-user-avatar-image"
            referrerPolicy="no-referrer"
            onError={() => setHasImageError(true)}
          />
        ) : (
          <span className="live-user-avatar-fallback" aria-hidden="true">
            {initials}
          </span>
        )}
      </span>
      {typeof participantCount === "number" ? (
        <span className="live-user-avatar-count" aria-hidden="true">
          {participantCount}
        </span>
      ) : null}
    </Tag>
  );
}
