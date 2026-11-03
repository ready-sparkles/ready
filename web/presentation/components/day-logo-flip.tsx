"use client";

import {
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import { type DayLogoTone, getDayIconHref } from "../../domain/day-logo";
import { createTimerGroup } from "../lib/timer-group";

// Keep a shared banner's intro from replaying as its route remounts.
// This is cosmetic, in-memory state; a fresh page load can play the intro again.
const logoPlaybackDates = new Map<string, string>();

const HALF = 0.5;
const TWO = 2;
const FLIP_DURATION_BASE_MS = 65;
const FLIP_DURATION_SPREAD_MS = 215;
const DAYS_PER_WEEK = 7;

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type CalendarState = { today: number; monthStartDay: number; key: string };

type DayLogoFlipProps = {
  tone?: DayLogoTone;
  className?: string;
  playbackKey?: string;
  /** @external day logo flip prop */
  showWeekday?: boolean;
};

function buildArtMarkClassName(className?: string): string {
  if (className !== undefined && className !== "") {
    return `meeting-pro-art-mark ${className}`;
  }

  return "meeting-pro-art-mark";
}

function computeFlipDurationMs(input: { day: number; today: number }): number {
  const progress = Math.min(1, (input.day - 1) / Math.max(1, input.today - TWO));
  const slowdown = Math.max(0, (progress - HALF) * TWO);

  return Math.round(FLIP_DURATION_BASE_MS + FLIP_DURATION_SPREAD_MS * slowdown * slowdown);
}

function weekdayLabelForDay(input: { monthStartDay: number; value: number }): string {
  return WEEKDAY_LABELS[(input.monthStartDay + input.value - 1) % DAYS_PER_WEEK] ?? "";
}

function useCalendarClock(input: { playbackKey?: string }) {
  const playbackKey = input.playbackKey;
  const [calendar, setCalendar] = useState<CalendarState | null>(null);
  const [day, setDay] = useState(1);

  useEffect(() => {
    const clock: { currentDate?: string } = {};
    const timers = createTimerGroup();
    const refreshDate = () => {
      const now = new Date();
      const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      if (key !== clock.currentDate) {
        if (
          clock.currentDate !== undefined ||
          (playbackKey !== undefined && playbackKey !== "" && logoPlaybackDates.get(playbackKey) === key)
        ) {
          setDay(now.getDate());
        }
        clock.currentDate = key;
        setCalendar({
          today: now.getDate(),
          monthStartDay: new Date(now.getFullYear(), now.getMonth(), 1).getDay(),
          key,
        });
      }
      timers.clear();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timers.setTimeout({ run: refreshDate, delayMs: midnight.getTime() - now.getTime() });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refreshDate();
      }
    };
    refreshDate();
    window.addEventListener("focus", refreshDate);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      timers.clear();
      window.removeEventListener("focus", refreshDate);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [playbackKey]);

  return { calendar, day, setDay };
}

function useReducedMotionPreference(setDay: (value: number) => void) {
  const [isReducedMotion, setIsReducedMotion] = useState<boolean | null>(null);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => {
      setIsReducedMotion(preference.matches);
      if (preference.matches) {
        setDay(new Date().getDate());
      }
    };
    updateMotion();
    preference.addEventListener("change", updateMotion);

    return () => preference.removeEventListener("change", updateMotion);
  }, [setDay]);

  return isReducedMotion;
}

function useMarkHasEntered(markRef: RefObject<HTMLDivElement | null>) {
  const [hasEntered, setHasEntered] = useState(false);

  useEffect(() => {
    const observed: { observer?: IntersectionObserver } = {};
    if (markRef.current) {
      if (typeof IntersectionObserver === "undefined") {
        setHasEntered(true);
      } else {
        observed.observer = new IntersectionObserver(
          ([entry]) => {
            if (entry?.isIntersecting === true) {
              setHasEntered(true);
              observed.observer?.disconnect();
            }
          },
          { threshold: HALF },
        );
        observed.observer.observe(markRef.current);
      }
    }

    return () => {
      observed.observer?.disconnect();
    };
  }, [markRef]);

  return hasEntered;
}

function useRememberLogoPlayback(input: {
  playbackKey?: string;
  hasEntered: boolean;
  calendar: CalendarState | null;
  isReducedMotion: boolean | null;
}) {
  useEffect(() => {
    if (
      input.playbackKey !== undefined &&
      input.playbackKey !== "" &&
      input.hasEntered &&
      input.calendar &&
      input.isReducedMotion !== null
    ) {
      logoPlaybackDates.set(input.playbackKey, input.calendar.key);
    }
  }, [input.playbackKey, input.hasEntered, input.calendar, input.isReducedMotion]);
}

function useFlipImagePreload(input: {
  calendar: CalendarState | null;
  day: number;
  hasEntered: boolean;
  isReducedMotion: boolean | null;
  tone: DayLogoTone;
  setDay: (value: number) => void;
  setReadyDate: (value: string) => void;
}) {
  const isPlaybackNeeded = input.calendar !== null && input.day < input.calendar.today;

  useEffect(() => {
    const calendar = input.calendar;
    if (!input.hasEntered || input.isReducedMotion !== false || calendar === null || !isPlaybackNeeded) {
      return;
    }
    const playback = { isCancelled: false };
    void (async () => {
      try {
        await Promise.all(
          Array.from({ length: calendar.today }, (_, index) => {
            const image = new Image();
            image.src = getDayIconHref({ dayNumber: index + 1, tone: input.tone });

            return image.decode();
          }),
        );
        if (!playback.isCancelled) {
          input.setReadyDate(calendar.key);
        }
      } catch (error) {
        if (playback.isCancelled) {
          return;
        }
        const isDecodeFailure =
          error instanceof Error || error === undefined || typeof error === "object" || typeof error === "string";
        if (isDecodeFailure || typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
          input.setDay(calendar.today);
        }
      }
    })();

    return () => {
      playback.isCancelled = true;
    };
  }, [
    input.hasEntered,
    input.isReducedMotion,
    input.calendar,
    isPlaybackNeeded,
    input.tone,
    input.setDay,
    input.setReadyDate,
  ]);
}

function DayLogoSurface(input: { value: number; tone: DayLogoTone; monthStartDay: number | null }): ReactNode {
  return (
    <div className="meeting-pro-logo-surface">
      <img
        className="meeting-pro-art-logo"
        src={getDayIconHref({ dayNumber: input.value, tone: input.tone })}
        alt=""
        draggable={false}
      />
      {input.monthStartDay !== null ? (
        <span className="meeting-pro-logo-weekday">
          {weekdayLabelForDay({ monthStartDay: input.monthStartDay, value: input.value })}
        </span>
      ) : null}
    </div>
  );
}

function DayLogoFlipSequence(input: {
  day: number;
  nextDay: number;
  tone: DayLogoTone;
  monthStartDay: number | null;
  onAdvanceDay: () => void;
}): ReactNode {
  const surface = (value: number) => (
    <DayLogoSurface value={value} tone={input.tone} monthStartDay={input.monthStartDay} />
  );

  return (
    <div key={input.day} className="meeting-pro-flip">
      <div className="meeting-pro-flip-half is-top">{surface(input.day)}</div>
      <div className="meeting-pro-flip-half is-bottom">{surface(input.nextDay)}</div>
      <div className="meeting-pro-flip-shadow is-lower" />
      <div className="meeting-pro-flip-shadow is-upper" />
      <div
        className="meeting-pro-flip-page"
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) {
            input.onAdvanceDay();
          }
        }}
      >
        <div className="meeting-pro-flip-face is-front">{surface(input.day)}</div>
        <div className="meeting-pro-flip-face is-back">{surface(input.nextDay)}</div>
      </div>
    </div>
  );
}

function DayLogoFlipBody(input: {
  calendar: CalendarState | null;
  day: number;
  hasEntered: boolean;
  isReducedMotion: boolean | null;
  readyDate: string | null;
  tone: DayLogoTone;
  monthStartDay: number | null;
  setDay: Dispatch<SetStateAction<number>>;
}): ReactNode {
  const today = input.calendar?.today ?? 1;
  const isInitialized = input.calendar !== null && input.isReducedMotion !== null;
  const isFlipping =
    input.hasEntered && input.readyDate === input.calendar?.key && input.isReducedMotion === false && input.day < today;

  if (!isInitialized || !input.hasEntered) {
    return null;
  }

  if (isFlipping) {
    const nextDay = Math.min(input.day + 1, today);

    return (
      <DayLogoFlipSequence
        day={input.day}
        nextDay={nextDay}
        tone={input.tone}
        monthStartDay={input.monthStartDay}
        onAdvanceDay={() => {
          input.setDay((value) => Math.min(value + 1, today));
        }}
      />
    );
  }

  const settledDay = input.isReducedMotion === true ? today : input.day;

  return <DayLogoSurface value={settledDay} tone={input.tone} monthStartDay={input.monthStartDay} />;
}

/** The day logo, flipping from the 1st up to today's date the first time it
 * comes into view, like a page-a-day calendar. */
export function DayLogoFlip({ tone = "brand", className, playbackKey, ...externalDayLogoFlipProps }: DayLogoFlipProps) {
  const isWeekdayShown = externalDayLogoFlipProps.showWeekday ?? true;

  const markRef = useRef<HTMLDivElement>(null);
  const [readyDate, setReadyDate] = useState<string | null>(null);
  const { calendar, day, setDay } = useCalendarClock({ playbackKey });
  const isReducedMotion = useReducedMotionPreference(setDay);
  const hasEntered = useMarkHasEntered(markRef);

  useRememberLogoPlayback({ playbackKey, hasEntered, calendar, isReducedMotion });
  useFlipImagePreload({
    calendar,
    day,
    hasEntered,
    isReducedMotion,
    tone,
    setDay,
    setReadyDate,
  });

  const today = calendar?.today ?? 1;
  const monthStartDay = isWeekdayShown ? (calendar?.monthStartDay ?? null) : null;
  const duration = computeFlipDurationMs({ day, today });
  const flipStyle: CSSProperties = {
    "--flip-duration": `${duration}ms`,
  };

  return (
    <div ref={markRef} className={buildArtMarkClassName(className)} style={flipStyle}>
      <DayLogoFlipBody
        calendar={calendar}
        day={day}
        hasEntered={hasEntered}
        isReducedMotion={isReducedMotion}
        readyDate={readyDate}
        tone={tone}
        monthStartDay={monthStartDay}
        setDay={setDay}
      />
    </div>
  );
}
