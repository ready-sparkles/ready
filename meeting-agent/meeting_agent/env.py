from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


# The direct ElevenLabs Python plugin keeps Scribe v2 Realtime independent of
# the retiring LiveKit Inference model and preserves automatic language detection.
DEFAULT_MEETING_ASSISTANT_STT_MODEL = "scribe_v2_realtime"
LEGACY_LIVEKIT_INFERENCE_STT_MODEL = "elevenlabs/scribe_v2_realtime"
DEFAULT_OPENAI_MEETING_ASSISTANT_REALTIME_MODEL = "gpt-live-1"
SERVICE_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = SERVICE_DIR
for parent in SERVICE_DIR.parents:
    if (parent / "pnpm-workspace.yaml").exists():
        ROOT_DIR = parent
        break

load_dotenv(ROOT_DIR / ".env")
if ROOT_DIR != SERVICE_DIR:
    load_dotenv(SERVICE_DIR / ".env", override=True)


def _require(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError("Meeting agent missing required environment variable: %s" % name)
    return value


def _optional(name: str, default: str = "") -> str:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip()


def _int(name: str, default: int) -> int:
    raw = _optional(name)
    if not raw:
        return default
    return int(raw)


def _bool(name: str, default: bool) -> bool:
    raw = _optional(name)
    if not raw:
        return default
    return raw.lower() in ("1", "true", "yes", "on")


def _meeting_assistant_stt_model() -> str:
    value = _optional(
        "MEETING_ASSISTANT_STT_MODEL", DEFAULT_MEETING_ASSISTANT_STT_MODEL
    )
    if value == LEGACY_LIVEKIT_INFERENCE_STT_MODEL:
        return DEFAULT_MEETING_ASSISTANT_STT_MODEL
    if value != DEFAULT_MEETING_ASSISTANT_STT_MODEL:
        raise RuntimeError(
            "MEETING_ASSISTANT_STT_MODEL must be scribe_v2_realtime when using "
            "the direct ElevenLabs plugin"
        )
    return value


def _assistant_model_default() -> str:
    explicit = _optional("OPENAI_MEETING_ASSISTANT_MODEL")
    if explicit:
        return explicit

    legacy = _optional("OPENAI_REALTIME_MODEL")
    if legacy and not legacy.startswith("gpt-realtime"):
        return legacy

    return "gpt-4o-mini"


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    assistant_service_secret: str
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    livekit_room_assistant_name: str
    livekit_realtime_service_url: str
    livekit_realtime_service_secret: str
    livekit_realtime_request_timeout_ms: int
    openai_api_key: str
    eleven_api_key: str = field(repr=False)
    meeting_assistant_stt_model: str
    meeting_assistant_stt_language: str
    openai_meeting_assistant_model: str
    openai_meeting_assistant_tts_model: str
    openai_meeting_assistant_realtime_model: str
    openai_meeting_assistant_live_backend_model: str
    openai_meeting_assistant_voice: str
    openai_meeting_agent_help_model: str
    openai_meeting_agent_help_timeout_ms: int
    openai_meeting_summary_model: str
    openai_meeting_summary_progress_delay_ms: int
    openai_meeting_summary_timeout_ms: int
    openai_web_search_enabled: bool
    openai_web_search_context_size: str
    billing_monthly_plan_included_credits: int
    assistant_identity_prefix: str = "readymeet-assistant"
    assistant_display_name: str = "ReadyMeet Assistant"
    debug_log_path: str = "/tmp/readymeet-meeting-agent.log"
    # In group mode the assistant's STT stream is open for the whole meeting
    # even though audio only flows during a push-to-talk turn. Gating keeps it
    # open only while frames are arriving. Default off: enabling is deliberate.
    meeting_assistant_stt_gate_enabled: bool = False
    meeting_assistant_stt_gate_idle_seconds: float = 5.0


def load_settings() -> Settings:
    return Settings(
        api_base_url=_optional("API_BASE_URL", "http://localhost:4000"),
        assistant_service_secret=_require("ASSISTANT_SERVICE_SECRET"),
        livekit_url=_require("LIVEKIT_URL"),
        livekit_api_key=_require("LIVEKIT_API_KEY"),
        livekit_api_secret=_require("LIVEKIT_API_SECRET"),
        livekit_room_assistant_name=_optional(
            "LIVEKIT_ROOM_ASSISTANT_NAME", "readymeet-meeting-agent"
        ),
        livekit_realtime_service_url=_optional(
            "LIVEKIT_REALTIME_SERVICE_URL", "http://localhost:4200"
        ),
        livekit_realtime_service_secret=_optional(
            "LIVEKIT_REALTIME_SERVICE_SECRET", "livekit_realtime_shared_secret"
        ),
        livekit_realtime_request_timeout_ms=_int(
            "LIVEKIT_REALTIME_REQUEST_TIMEOUT_MS", 12000
        ),
        openai_api_key=_require("OPENAI_API_KEY"),
        eleven_api_key=_require("ELEVEN_API_KEY"),
        meeting_assistant_stt_model=_meeting_assistant_stt_model(),
        meeting_assistant_stt_language=_optional("MEETING_ASSISTANT_STT_LANGUAGE"),
        meeting_assistant_stt_gate_enabled=_bool("MEETING_ASSISTANT_STT_GATE", False),
        meeting_assistant_stt_gate_idle_seconds=float(
            _optional("MEETING_ASSISTANT_STT_GATE_IDLE_SECONDS", "5") or "5"
        ),
        openai_meeting_assistant_model=_assistant_model_default(),
        openai_meeting_assistant_tts_model=_optional(
            "OPENAI_MEETING_ASSISTANT_TTS_MODEL", "gpt-4o-mini-tts"
        ),
        openai_meeting_assistant_realtime_model=_optional(
            "OPENAI_MEETING_ASSISTANT_REALTIME_MODEL",
            DEFAULT_OPENAI_MEETING_ASSISTANT_REALTIME_MODEL,
        ),
        openai_meeting_assistant_voice=_optional(
            "OPENAI_MEETING_ASSISTANT_VOICE",
            _optional("OPENAI_MEETING_ASSISTANT_REALTIME_VOICE", "marin"),
        ),
        openai_meeting_assistant_live_backend_model=_optional(
            "OPENAI_MEETING_ASSISTANT_LIVE_BACKEND_MODEL", "gpt-5.6-luna"
        ),
        openai_meeting_agent_help_model=_optional(
            "OPENAI_MEETING_AGENT_HELP_MODEL", "gpt-5.5"
        ),
        openai_meeting_agent_help_timeout_ms=_int(
            "OPENAI_MEETING_AGENT_HELP_TIMEOUT_MS", 20000
        ),
        openai_meeting_summary_model=_optional(
            "OPENAI_MEETING_SUMMARY_MODEL", "gpt-5.5"
        ),
        openai_meeting_summary_progress_delay_ms=_int(
            "OPENAI_MEETING_SUMMARY_PROGRESS_DELAY_MS", 500
        ),
        openai_meeting_summary_timeout_ms=_int(
            "OPENAI_MEETING_SUMMARY_TIMEOUT_MS", 12000
        ),
        openai_web_search_enabled=_bool(
            "OPENAI_MEETING_ASSISTANT_WEB_SEARCH_ENABLED", True
        ),
        openai_web_search_context_size=_optional(
            "OPENAI_MEETING_ASSISTANT_WEB_SEARCH_CONTEXT_SIZE", "medium"
        ),
        billing_monthly_plan_included_credits=_int(
            "BILLING_MONTHLY_PLAN_INCLUDED_CREDITS", 200
        ),
    )
