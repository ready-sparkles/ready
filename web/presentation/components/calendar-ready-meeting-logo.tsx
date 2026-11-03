import type { NormalizedCalendarEvent } from "@readymeet/shared";

import { getCalendarEventLogoDay } from "../../domain/calendar-events";
import { getDayIconHref } from "../../domain/day-logo";

import { ReadyLogo } from "./ready-logo";

export function ReadyMeetingLogo({ event }: { event: NormalizedCalendarEvent }) {
  return <ReadyMeetingLogoTile day={getCalendarEventLogoDay(event)} />;
}

/** The same sized logo tile as calendar cards, showing today's date. */
export function ReadyMeetingTodayLogo() {
  return <ReadyMeetingLogoTile day={null} />;
}

function ReadyMeetingLogoTile({ day }: { day: number | null }) {
  return (
    <span className="workspace-brief-card-icon-tile workspace-ready-meeting-logo-tile" aria-hidden="true">
      <span className="meeting-pro-logo-surface workspace-ready-meeting-mark">
        {day === null ? (
          <ReadyLogo className="meeting-pro-art-logo" label="" />
        ) : (
          <img className="meeting-pro-art-logo" src={getDayIconHref({ dayNumber: day })} alt="" />
        )}
      </span>
    </span>
  );
}
