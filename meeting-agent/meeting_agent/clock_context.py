"""Current calendar facts, independent of model knowledge and session age."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def current_clock(time_zone: str = "UTC", *, now: datetime | None = None) -> dict[str, str]:
    try:
        zone = ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError):
        return {"error": "invalid_time_zone", "message": "Use an IANA time zone, such as America/Los_Angeles. Do not guess the date."}
    instant = now if now is not None else datetime.now(timezone.utc)
    if instant.tzinfo is None:
        raise ValueError("Clock instant must be timezone-aware")
    local = instant.astimezone(zone)
    today = local.date()
    return {
        "utc_now": instant.astimezone(timezone.utc).isoformat(),
        "time_zone": time_zone,
        "local_now": local.isoformat(),
        "today": today.isoformat(),
        "tomorrow": (today + timedelta(days=1)).isoformat(),
        "weekday": local.strftime("%A"),
    }


def clock_instructions() -> str:
    return (
        "Session started at " + current_clock()["utc_now"] + ". This is UTC, not the user's local date. "
        "A live clock is available through the backend. Never ask the user what today's date or tomorrow's date is. "
        "Delegate time-sensitive requests so the backend can check a fresh clock in the relevant time zone, "
        "including when a session crosses midnight. Do not use a model knowledge cutoff as today's date. "
    )
