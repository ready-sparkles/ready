from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from .stt_gate import SttGateSettings, normalize_gate_mode


# The direct ElevenLabs Python plugin keeps Scribe v2 Realtime independent of
# the retiring LiveKit Inference model and preserves automatic language detection.
DEFAULT_LIVEKIT_TRANSCRIPTION_STT_MODEL = "scribe_v2_realtime"
LEGACY_LIVEKIT_INFERENCE_STT_MODEL = "elevenlabs/scribe_v2_realtime"
DEFAULT_STT_VAD_SILENCE_THRESHOLD_SECONDS = 0.5
DEFAULT_STT_VAD_THRESHOLD = 0.4
DEFAULT_STT_VAD_MIN_SPEECH_DURATION_MS = 100
DEFAULT_STT_VAD_MIN_SILENCE_DURATION_MS = 100


def _transcription_model() -> str:
    value = (
        os.getenv("LIVEKIT_REALTIME_STT_MODEL", "").strip()
        or DEFAULT_LIVEKIT_TRANSCRIPTION_STT_MODEL
    )
    if value == LEGACY_LIVEKIT_INFERENCE_STT_MODEL:
        return DEFAULT_LIVEKIT_TRANSCRIPTION_STT_MODEL
    if value != DEFAULT_LIVEKIT_TRANSCRIPTION_STT_MODEL:
        raise RuntimeError(
            "LIVEKIT_REALTIME_STT_MODEL must be scribe_v2_realtime when using "
            "the direct ElevenLabs plugin"
        )
    return value


def _float_in_range(name: str, default: float, minimum: float, maximum: float) -> float:
    value = float(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _int_in_range(name: str, default: int, minimum: int, maximum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _load_env() -> None:
    service_dir = Path(__file__).resolve().parents[1]
    root_dir = service_dir
    for parent in service_dir.parents:
        if (parent / "pnpm-workspace.yaml").exists():
            root_dir = parent
            break

    if root_dir != service_dir:
        load_dotenv(root_dir / ".env")

    load_dotenv(service_dir / ".env", override=True)


@dataclass(frozen=True)
class Settings:
    port: int
    service_secret: str
    assistant_callback_url: str
    assistant_service_secret: str
    eleven_api_key: str = field(repr=False)
    meeting_recordings_dir: str
    transcription_model: str
    transcription_language: str
    room_connect_timeout_seconds: int
    assistant_callback_timeout_seconds: float
    # ElevenLabs defaults to manual commits and otherwise waits about 36 seconds
    # before auto-committing accumulated audio. Server VAD gives the captions
    # an utterance boundary even when the meeting's voice agent is disabled.
    transcription_vad_silence_threshold_seconds: float = (
        DEFAULT_STT_VAD_SILENCE_THRESHOLD_SECONDS
    )
    transcription_vad_threshold: float = DEFAULT_STT_VAD_THRESHOLD
    transcription_vad_min_speech_duration_ms: int = (
        DEFAULT_STT_VAD_MIN_SPEECH_DURATION_MS
    )
    transcription_vad_min_silence_duration_ms: int = (
        DEFAULT_STT_VAD_MIN_SILENCE_DURATION_MS
    )
    # Speech gating keeps a participant's STT stream open only around actual
    # speech. Defaults are inert (mode "off") so enabling it is a deliberate,
    # reversible config change.
    stt_gate_mode: str = "off"
    stt_gate_hold_open_seconds: float = 8.0
    stt_gate_min_open_seconds: float = 3.0
    stt_gate_prebuffer_seconds: float = 1.5
    stt_gate_admission_capacity: int = 0
    stt_gate_admission_wait_seconds: float = 5.0
    stt_gate_max_blocked_buffer_seconds: float = 30.0

    def stt_gate_settings(self) -> SttGateSettings:
        return SttGateSettings(
            mode=self.stt_gate_mode,
            hold_open_seconds=self.stt_gate_hold_open_seconds,
            min_open_seconds=self.stt_gate_min_open_seconds,
            prebuffer_seconds=self.stt_gate_prebuffer_seconds,
            admission_capacity=self.stt_gate_admission_capacity,
            admission_wait_seconds=self.stt_gate_admission_wait_seconds,
            max_blocked_buffer_seconds=self.stt_gate_max_blocked_buffer_seconds,
        )


def load_settings() -> Settings:
    _load_env()

    assistant_callback_url = os.getenv("ASSISTANT_CALLBACK_URL", "http://localhost:4100")
    service_secret = os.getenv("LIVEKIT_REALTIME_SERVICE_SECRET", "livekit_realtime_shared_secret")
    assistant_service_secret = os.getenv("ASSISTANT_SERVICE_SECRET", "")
    eleven_api_key = os.getenv("ELEVEN_API_KEY", "").strip()

    if not service_secret:
        raise RuntimeError("LIVEKIT_REALTIME_SERVICE_SECRET is required")
    if not assistant_service_secret:
        raise RuntimeError("ASSISTANT_SERVICE_SECRET is required")
    if not eleven_api_key:
        raise RuntimeError("ELEVEN_API_KEY is required")

    # service_secret defaults to a known value for local development. Refuse to
    # start in production if that publicly-known default is still in place.
    if (
        os.getenv("NODE_ENV") == "production"
        and service_secret == "livekit_realtime_shared_secret"
    ):
        raise RuntimeError(
            "Refusing to start in production with the insecure default "
            "LIVEKIT_REALTIME_SERVICE_SECRET. Set a unique, high-entropy secret "
            "shared with the assistant service."
        )

    return Settings(
        port=int(os.getenv("PORT") or os.getenv("LIVEKIT_REALTIME_PORT", "4200")),
        service_secret=service_secret,
        assistant_callback_url=assistant_callback_url,
        assistant_service_secret=assistant_service_secret,
        eleven_api_key=eleven_api_key,
        meeting_recordings_dir=os.getenv("MEETING_RECORDINGS_DIR", "/tmp/readymeet-recordings"),
        transcription_model=_transcription_model(),
        transcription_language=os.getenv("LIVEKIT_REALTIME_STT_LANGUAGE", "").strip(),
        room_connect_timeout_seconds=int(os.getenv("LIVEKIT_REALTIME_ROOM_CONNECT_TIMEOUT_SECONDS", "20")),
        assistant_callback_timeout_seconds=float(
            os.getenv("LIVEKIT_REALTIME_ASSISTANT_CALLBACK_TIMEOUT_SECONDS", "20")
        ),
        transcription_vad_silence_threshold_seconds=_float_in_range(
            "LIVEKIT_REALTIME_STT_VAD_SILENCE_THRESHOLD_SECONDS",
            DEFAULT_STT_VAD_SILENCE_THRESHOLD_SECONDS,
            0.3,
            3.0,
        ),
        transcription_vad_threshold=_float_in_range(
            "LIVEKIT_REALTIME_STT_VAD_THRESHOLD",
            DEFAULT_STT_VAD_THRESHOLD,
            0.1,
            0.9,
        ),
        transcription_vad_min_speech_duration_ms=_int_in_range(
            "LIVEKIT_REALTIME_STT_VAD_MIN_SPEECH_DURATION_MS",
            DEFAULT_STT_VAD_MIN_SPEECH_DURATION_MS,
            50,
            2000,
        ),
        transcription_vad_min_silence_duration_ms=_int_in_range(
            "LIVEKIT_REALTIME_STT_VAD_MIN_SILENCE_DURATION_MS",
            DEFAULT_STT_VAD_MIN_SILENCE_DURATION_MS,
            50,
            2000,
        ),
        stt_gate_mode=normalize_gate_mode(os.getenv("LIVEKIT_REALTIME_STT_GATE", "")),
        stt_gate_hold_open_seconds=float(
            os.getenv("LIVEKIT_REALTIME_STT_GATE_HOLD_OPEN_SECONDS", "8")
        ),
        stt_gate_min_open_seconds=float(
            os.getenv("LIVEKIT_REALTIME_STT_GATE_MIN_OPEN_SECONDS", "3")
        ),
        stt_gate_prebuffer_seconds=float(
            os.getenv("LIVEKIT_REALTIME_STT_GATE_PREBUFFER_SECONDS", "1.5")
        ),
        # 0 means unlimited. This budget is per-process: divide the provider
        # cap by the number of realtime instances before setting it.
        stt_gate_admission_capacity=int(
            os.getenv("LIVEKIT_REALTIME_STT_GATE_ADMISSION_CAPACITY", "0")
        ),
        stt_gate_admission_wait_seconds=float(
            os.getenv("LIVEKIT_REALTIME_STT_GATE_ADMISSION_WAIT_SECONDS", "5")
        ),
        stt_gate_max_blocked_buffer_seconds=float(
            os.getenv("LIVEKIT_REALTIME_STT_GATE_MAX_BLOCKED_BUFFER_SECONDS", "30")
        ),
    )
