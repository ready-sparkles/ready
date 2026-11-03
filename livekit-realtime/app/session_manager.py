from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

import aiohttp
from livekit import rtc
from livekit.agents import stt as stt_api
from livekit.plugins import elevenlabs, silero

try:
    from livekit.plugins import noise_cancellation as livekit_noise_cancellation
except ImportError:  # pragma: no cover - optional LiveKit Cloud dependency
    livekit_noise_cancellation = None

from .assistant_client import AssistantCallbackClient
from .caption_publisher import CaptionPublisher
from .config import Settings
from .metrics import RealtimeMetrics
from .schemas import FinalTranscriptEvent, LiveTranscriptEvent, StartSessionRequest
from .task_cleanup import finish_on_cancel
from .stt_gate import (
    SttAdmissionController,
    SttGateObserver,
    SttGateSettings,
    gated_stt_stream,
)


LOGGER = logging.getLogger("readymeet.livekit_realtime.sessions")

ASSISTANT_IDENTITY_PREFIX = "readymeet-assistant-"
LEADING_SPEAKER_TAG_PATTERN = re.compile(r"^\s*\[Speaker:[^\]]+\]\s*", re.IGNORECASE)
BACKGROUND_TASK_DRAIN_TIMEOUT_SECONDS = 3.0

# Silero defaults (min_speech_duration=0.05, activation_threshold=0.5) let
# 50ms clicks and low-confidence breaths through to the STT, which then
# hallucinates words into the durable transcript. Clicks die on duration,
# breaths die on confidence; prefix padding preserves the true start of real
# speech so short words like "yes"/"no" are still captured.
TRANSCRIBER_VAD_OPTIONS: Dict[str, float] = {
    "min_speech_duration": 0.2,
    "min_silence_duration": 0.3,
    "activation_threshold": 0.6,
    "prefix_padding_duration": 0.5,
}


def build_transcriber_vad() -> Any:
    return silero.VAD.load(**TRANSCRIBER_VAD_OPTIONS)


# Matches the RoomIO defaults this transcriber used before it subscribed to
# tracks directly, so VAD thresholds and STT behaviour are unchanged.
TRANSCRIBER_SAMPLE_RATE = 24000
TRANSCRIBER_NUM_CHANNELS = 1
TRANSCRIBER_FRAME_SIZE_MS = 50
TRANSCRIBER_FLUSH_SILENCE_SECONDS = 0.5
PARTICIPANT_TRACK_DRAIN_TIMEOUT_SECONDS = 12.0


def build_transcriber_noise_cancellation() -> Any:
    if livekit_noise_cancellation is None:
        return None
    # BVC isolates one participant's voice before VAD + STT. It is applied per
    # track, so a single room connection carrying every participant's audio
    # still gets independent isolation for each of them.
    return livekit_noise_cancellation.BVC()


def build_transcriber_audio_processing() -> Any:
    # RoomIO enables automatic gain control by default. Keep that behavior
    # when consuming tracks directly so quiet and distant microphones do not
    # regress merely because the connection topology changed.
    return rtc.AudioProcessingModule(auto_gain_control=True)


TRANSCRIPT_SETTLE_IDLE_SECONDS = 2.0
TRANSCRIPT_SETTLE_MAX_SECONDS = 10.0
TRANSCRIPT_SETTLE_POLL_SECONDS = 0.25
PARTICIPANT_RECONCILE_INTERVAL_SECONDS = 2.0

# A participant transcriber whose STT has died keeps its room connection and
# its entry in participant_sessions, so a reconcile pass that only looks for
# *missing* sessions will never notice it: the failure shows up as a person
# whose words silently stop appearing. Sessions that report an unrecoverable
# STT error and do not recover within this grace window get rebuilt. The
# window exists because the speech gate heals itself by reopening on the next
# utterance, and a restart would fight that.
STT_RECOVERY_GRACE_SECONDS = 5.0


class _MetricsSttGateObserver(SttGateObserver):
    """Bridges gate decisions to service metrics.

    Decisions are recorded identically in shadow and enforcing mode (tagged by
    label), which is what makes shadow data a faithful prediction of what
    enforcement would do.
    """

    def __init__(
        self,
        *,
        metrics: RealtimeMetrics,
        admission: SttAdmissionController,
    ) -> None:
        self._metrics = metrics
        self._admission = admission

    def _sync_admission_gauge(self) -> None:
        self._metrics.record_stt_streams_in_use(self._admission.in_use)

    def on_open(self, *, shadow: bool) -> None:
        self._metrics.record_stt_gate_opened(shadow=shadow)

    def on_close(self, *, shadow: bool, open_seconds: float, reason: str) -> None:
        self._metrics.record_stt_gate_closed(shadow=shadow, open_seconds=open_seconds)

    # Capacity is a fact about provider sessions, not about gate decisions: a
    # gate can decide "open" and then be denied admission. Only the stream
    # hooks move the gauge.
    def on_stream_opened(self) -> None:
        self._sync_admission_gauge()

    def on_stream_closed(self, *, reason: str) -> None:
        self._sync_admission_gauge()

    def on_admission_denied(self, *, waited_seconds: float) -> None:
        self._metrics.record_stt_admission_denied()

    def on_prebuffer_flush(self, *, frames: int, seconds: float) -> None:
        self._metrics.record_stt_prebuffer_flush(seconds=seconds)

    def on_stream_error(self, *, reason: str) -> None:
        self._metrics.record_stt_stream_error(reason=reason)

    def on_frames_dropped(self, *, frames: int, seconds: float) -> None:
        self._metrics.record_stt_dropped_audio(seconds=seconds)


class _ParticipantGateObserver(SttGateObserver):
    """Meeting-level observer plus per-participant recovery bookkeeping."""

    def __init__(
        self,
        *,
        delegate: SttGateObserver,
        participant_session: "ParticipantTranscriptionSession",
    ) -> None:
        self._delegate = delegate
        self._participant_session = participant_session

    def on_open(self, *, shadow: bool) -> None:
        self._delegate.on_open(shadow=shadow)

    def on_close(self, *, shadow: bool, open_seconds: float, reason: str) -> None:
        self._delegate.on_close(shadow=shadow, open_seconds=open_seconds, reason=reason)

    def on_stream_opened(self) -> None:
        self._delegate.on_stream_opened()

    def on_stream_closed(self, *, reason: str) -> None:
        self._delegate.on_stream_closed(reason=reason)

    def on_stream_healthy(self) -> None:
        # Recovery means the provider actually answered — a stream *object*
        # is created before the websocket ever connects, so clearing on
        # on_stream_opened let a fast open/fail loop reset stt_failed_at
        # every cycle and postpone the reconcile rebuild indefinitely.
        self._participant_session.note_stt_recovered()
        self._delegate.on_stream_healthy()

    def on_admission_denied(self, *, waited_seconds: float) -> None:
        self._delegate.on_admission_denied(waited_seconds=waited_seconds)

    def on_prebuffer_flush(self, *, frames: int, seconds: float) -> None:
        self._delegate.on_prebuffer_flush(frames=frames, seconds=seconds)

    def on_stream_error(self, *, reason: str) -> None:
        # Gate-level failures — stt.stream() raising, push failures, clean-EOF
        # loops, a dead VAD — never route through the SDK "error" event, so
        # without this a gate that can no longer reopen gives the reconcile
        # loop no signal at all. Preserve-first semantics keep a repeating
        # failure from resetting the grace clock, and a genuinely healthy
        # reopened stream clears it via on_stream_healthy.
        self._participant_session.note_stt_failure()
        self._delegate.on_stream_error(reason=reason)

    def on_frames_dropped(self, *, frames: int, seconds: float) -> None:
        self._delegate.on_frames_dropped(frames=frames, seconds=seconds)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return _utc_now().isoformat()


def _should_skip_transcript_content(content: str) -> bool:
    normalized = content.strip()
    if not normalized:
        return True

    return re.search(r"[\w\d]", normalized, re.UNICODE) is None


def _normalize_transcript_content(content: str) -> str:
    normalized = content.strip()
    if not normalized:
        return ""

    normalized = LEADING_SPEAKER_TAG_PATTERN.sub("", normalized).strip()
    return " ".join(normalized.split())


def _get_participant_user_id(participant: Any) -> Optional[str]:
    def canonical_user_id(value: Any) -> Optional[str]:
        if not isinstance(value, str):
            return None
        try:
            normalized = str(uuid.UUID(value))
            return normalized if normalized == value.lower() else None
        except ValueError:
            return None

    # Signed-in identities are server-issued; attributes cannot override them.
    identity = getattr(participant, "identity", "") or ""
    user_id = canonical_user_id(identity.split(":", 1)[0])
    if user_id:
        return user_id
    # Guest metadata is read-only and SIP metadata is stamped server-side.
    if not (identity.startswith("guest:") or getattr(participant, "kind", None) == rtc.ParticipantKind.PARTICIPANT_KIND_SIP):
        return None
    user_id = canonical_user_id((getattr(participant, "attributes", None) or {}).get("userId"))
    if user_id:
        return user_id
    try:
        metadata = json.loads(getattr(participant, "metadata", "") or "{}")
    except (ValueError, TypeError):
        return None
    return canonical_user_id(metadata.get("userId")) if isinstance(metadata, dict) else None


def _is_assistant_participant(participant: Any) -> bool:
    attributes = getattr(participant, "attributes", None) or {}
    assistant_role = attributes.get("assistantRole")
    if isinstance(assistant_role, str) and assistant_role:
        return True

    identity = getattr(participant, "identity", "") or ""
    return identity.startswith(ASSISTANT_IDENTITY_PREFIX)


def _is_sip_participant(participant: Any) -> bool:
    return getattr(participant, "kind", None) == rtc.ParticipantKind.PARTICIPANT_KIND_SIP


def _is_human_meeting_participant(participant: Any) -> bool:
    if _is_assistant_participant(participant):
        return False

    # Phone callers join through LiveKit SIP without an app-minted token, so
    # they may carry no userId attribute; participant kind is the only signal
    # that a dialed-in human is in the room and must be transcribed.
    return _is_sip_participant(participant) or _get_participant_user_id(participant) is not None


def _build_elevenlabs_stt(
    settings: Settings,
    *,
    http_session: Optional[aiohttp.ClientSession] = None,
) -> Any:
    kwargs: Dict[str, Any] = {
        "api_key": settings.eleven_api_key,
        "model": settings.transcription_model,
        "server_vad": {
            "vad_silence_threshold_secs": (
                settings.transcription_vad_silence_threshold_seconds
            ),
            "vad_threshold": settings.transcription_vad_threshold,
            "min_speech_duration_ms": (
                settings.transcription_vad_min_speech_duration_ms
            ),
            "min_silence_duration_ms": (
                settings.transcription_vad_min_silence_duration_ms
            ),
        },
    }
    language = settings.transcription_language.strip()
    if language and language.lower() not in {"auto", "multi"}:
        kwargs["language_code"] = language
    if http_session is not None:
        kwargs["http_session"] = http_session
    return elevenlabs.STT(**kwargs)


async def _ungated_stt_stream(*, audio: Any, stt: Any) -> Any:
    """UnGated fallback: one STT stream held open for the whole track.

    This is the pre-gate behaviour, kept for LIVEKIT_REALTIME_STT_GATE=off.
    """

    stream = stt.stream()

    async def pump() -> None:
        try:
            async for frame in audio:
                stream.push_frame(frame)
        finally:
            stream.end_input()

    pump_task = asyncio.create_task(pump())
    try:
        async for event in stream:
            yield event
    finally:
        pump_task.cancel()
        await asyncio.gather(pump_task, return_exceptions=True)
        await stream.aclose()


@dataclass
class ParticipantTranscriptionSession:
    meeting_session: "MeetingSession"
    participant: rtc.RemoteParticipant
    closed: bool = False
    stt: Optional[Any] = None
    stt_failed_at: Optional[datetime] = None
    stt_error_count: int = 0
    _track: Optional[Any] = None
    _audio_stream: Optional[Any] = None
    _consumer: Optional[asyncio.Task] = None
    _caption_publisher: CaptionPublisher = field(init=False, repr=False)
    _stop_task: Optional[asyncio.Task[None]] = field(default=None, init=False, repr=False)
    _audio_processing: Optional[Any] = None
    _track_lock: asyncio.Lock = field(
        default_factory=asyncio.Lock,
        init=False,
        repr=False,
    )

    def __post_init__(self) -> None:
        self._caption_publisher = CaptionPublisher(
            room_provider=lambda: self.meeting_session.room,
            sender_identity=self.speaker_identity,
            metrics=self.meeting_session.metrics,
            log_context={"meetingId": self.meeting_session.request.meetingId},
        )

    def _attach_stt_error_handler(self, stt: Any) -> None:
        def _on_stt_error(error: Any) -> None:
            recoverable = bool(getattr(error, "recoverable", False))
            self.stt_error_count += 1
            if not recoverable:
                self.note_stt_failure()
            self.meeting_session.metrics.record_stt_stream_error(
                reason="recoverable" if recoverable else "unrecoverable",
            )
            LOGGER.warning(
                "participant stt error",
                extra={
                    "meetingId": self.meeting_session.request.meetingId,
                    "participantIdentity": self.speaker_identity,
                    "recoverable": recoverable,
                    "sttErrorCount": self.stt_error_count,
                    "errorType": type(getattr(error, "error", error)).__name__,
                },
            )

        stt.on("error", _on_stt_error)

    def note_stt_failure(self) -> None:
        """Mark this participant's STT as failing, preserving the first time.

        Preserve-first matters: a participant that keeps erroring every few
        seconds must not keep resetting the clock, or the reconcile grace
        window never elapses and the rebuild is postponed forever. The clock
        only restarts after genuine recovery (note_stt_recovered).
        """

        if self.stt_failed_at is None:
            self.stt_failed_at = _utc_now()

    def note_stt_recovered(self) -> None:
        self.stt_failed_at = None

    def needs_stt_recovery(self, *, now: Optional[datetime] = None) -> bool:
        if self.closed or self.stt_failed_at is None:
            return False

        elapsed = ((now or _utc_now()) - self.stt_failed_at).total_seconds()
        return elapsed >= STT_RECOVERY_GRACE_SECONDS

    def current_microphone_track(self) -> Optional[Any]:
        publications = getattr(self.participant, "track_publications", None) or {}
        values = publications.values() if isinstance(publications, dict) else publications
        for publication in values:
            source = getattr(publication, "source", None)
            if source is not None and source != rtc.TrackSource.SOURCE_MICROPHONE:
                continue
            track = getattr(publication, "track", None)
            if track is not None:
                return track
        return None

    async def start(self) -> None:
        if self.closed:
            return

        await self.meeting_session.ensure_http_session()
        stt = _build_elevenlabs_stt(
            self.meeting_session.settings,
            http_session=self.meeting_session.http_session,
        )
        self._attach_stt_error_handler(stt)
        self.stt = stt
        self._audio_processing = build_transcriber_audio_processing()

        # The track may not be subscribed yet; use_track() runs again from the
        # room's track_subscribed event, and on republish after a mute cycle.
        track = self.current_microphone_track()
        if track is not None:
            await self.use_track(track)

    async def use_track(self, track: Any) -> None:
        """(Re)bind transcription to this participant's microphone track."""

        async with self._track_lock:
            if self.closed or self.stt is None:
                return
            if (
                self._track is track
                and self._consumer is not None
                and not self._consumer.done()
            ):
                return

            # Construct the replacement stream before draining the old one.
            # AudioStream begins buffering immediately, so finalizing the old
            # STT stream does not clip frames from the newly published track.
            audio_stream = rtc.AudioStream.from_track(
                track=track,
                sample_rate=TRANSCRIBER_SAMPLE_RATE,
                num_channels=TRANSCRIBER_NUM_CHANNELS,
                noise_cancellation=build_transcriber_noise_cancellation(),
                frame_size_ms=TRANSCRIBER_FRAME_SIZE_MS,
            )
            adopted = False
            try:
                await self._release_track_locked(drain=True)
                if self.closed:
                    return

                self._track = track
                self._audio_stream = audio_stream
                self._consumer = asyncio.create_task(
                    self._consume_track(track, audio_stream)
                )
                adopted = True
            finally:
                # Replacement input is already buffering while the old track
                # drains. Cancellation must not orphan that unadopted stream.
                if not adopted:
                    await finish_on_cancel(asyncio.create_task(asyncio.wait_for(
                        audio_stream.aclose(), timeout=PARTICIPANT_TRACK_DRAIN_TIMEOUT_SECONDS,
                    )))

    async def release_track(
        self,
        *,
        track: Optional[Any] = None,
        drain: bool = True,
    ) -> bool:
        """Release the current track if it still matches the caller's track.

        Track events are delivered synchronously but handled in background
        tasks. Serializing them and checking the expected track prevents a
        delayed unsubscribe for an old publication from closing its
        replacement.
        """

        async with self._track_lock:
            if track is not None and self._track is not track:
                return False
            if self._track is None and self._consumer is None and self._audio_stream is None:
                return False

            await self._release_track_locked(drain=drain)
            return True

    async def _release_track_locked(self, *, drain: bool) -> None:
        await finish_on_cancel(asyncio.create_task(self._release_track_resources(drain=drain)))

    async def _release_track_resources(self, *, drain: bool) -> None:
        consumer = self._consumer
        self._consumer = None
        self._track = None
        audio_stream = self._audio_stream
        self._audio_stream = None

        deadline = asyncio.get_running_loop().time() + PARTICIPANT_TRACK_DRAIN_TIMEOUT_SECONDS
        try:
            if not drain and consumer is not None and not consumer.done():
                consumer.cancel()

            audio_close_failed = False
            if audio_stream is not None:
                try:
                    await asyncio.wait_for(
                        audio_stream.aclose(), timeout=PARTICIPANT_TRACK_DRAIN_TIMEOUT_SECONDS,
                    )
                except Exception:  # pragma: no cover - defensive teardown
                    audio_close_failed = True
                    LOGGER.debug(
                        "participant audio stream close failed",
                        extra={"participantIdentity": self.speaker_identity},
                    )

            # Closing input lets STT persist its trailing final transcript.
            # Share one bounded drain budget across audio close and consumption.
            if consumer is not None and not consumer.done() and not audio_close_failed:
                _, pending = await asyncio.wait(
                    (consumer,),
                    timeout=max(0.0, deadline - asyncio.get_running_loop().time()),
                )
                if pending:
                    LOGGER.warning(
                        "participant transcription drain timed out",
                        extra={"participantIdentity": self.speaker_identity},
                    )
        finally:
            if consumer is not None:
                if not consumer.done():
                    consumer.cancel()
                await asyncio.gather(consumer, return_exceptions=True)

    async def _processed_audio_frames(self, audio_stream: Any) -> Any:
        async for event in audio_stream:
            frame = event.frame
            if self._audio_processing is not None:
                self._audio_processing.process_stream(frame)
            yield frame

        # RoomIO appended 500 ms of silence when an input track ended. Besides
        # preserving the prior behavior, this gives streaming STT/VAD enough
        # audio to close the last utterance before end_input() is sent.
        samples_per_channel = int(
            TRANSCRIBER_SAMPLE_RATE * TRANSCRIBER_FLUSH_SILENCE_SECONDS
        )
        yield rtc.AudioFrame(
            b"\x00\x00" * samples_per_channel,
            sample_rate=TRANSCRIBER_SAMPLE_RATE,
            num_channels=TRANSCRIBER_NUM_CHANNELS,
            samples_per_channel=samples_per_channel,
        )

    async def _consume_track(self, track: Any, audio_stream: Any) -> None:
        async def frames() -> Any:
            async for frame in self._processed_audio_frames(audio_stream):
                yield frame

        meeting_session = self.meeting_session
        gate_settings = meeting_session.gate_settings
        if gate_settings.enabled:
            events = gated_stt_stream(
                audio=frames(),
                stt=self.stt,
                vad=meeting_session.vad,
                settings=gate_settings,
                admission=meeting_session.admission,
                observer=_ParticipantGateObserver(
                    delegate=meeting_session.gate_observer,
                    participant_session=self,
                ),
                label=(
                    f"{meeting_session.request.meetingId}:{self.speaker_identity}"
                ),
            )
        else:
            events = _ungated_stt_stream(audio=frames(), stt=self.stt)

        try:
            track_sid = getattr(track, "sid", None) or self.resolve_track_sid()
            async for event in events:
                await self._handle_speech_event(
                    event,
                    track_sid=str(track_sid) if track_sid else None,
                )
        except asyncio.CancelledError:
            raise
        except Exception as error:  # pragma: no cover - defensive
            LOGGER.exception(
                "participant transcription consumer failed",
                extra={
                    "meetingId": meeting_session.request.meetingId,
                    "participantIdentity": self.speaker_identity,
                    "error": str(error),
                },
            )
            self.note_stt_failure()

    async def _handle_speech_event(
        self,
        event: Any,
        *,
        track_sid: Optional[str] = None,
    ) -> None:
        event_type = getattr(event, "type", None)
        alternatives = getattr(event, "alternatives", None) or []
        text = getattr(alternatives[0], "text", "") if alternatives else ""
        if not text:
            return

        resolved_track_sid = track_sid or self.resolve_track_sid()
        if event_type == stt_api.SpeechEventType.INTERIM_TRANSCRIPT:
            self._caption_publisher.enqueue(
                text,
                is_final=False,
                track_sid=resolved_track_sid,
            )
            return

        if event_type != stt_api.SpeechEventType.FINAL_TRANSCRIPT:
            return

        # Queue captions so a slow room connection cannot stall STT events
        # or durable transcript callbacks.
        self._caption_publisher.enqueue(
            text,
            is_final=True,
            track_sid=resolved_track_sid,
        )
        # The callback client already retried. Losing this one line is better
        # than ending the STT loop, which would drop this speaker's later
        # speech until the watchdog restarts transcription.
        try:
            await self.persist_final_transcript_text(
                text,
                track_sid=resolved_track_sid,
            )
        except Exception as error:
            LOGGER.exception(
                "final transcript segment was not saved",
                extra={
                    "meetingId": self.meeting_session.request.meetingId,
                    "participantIdentity": self.speaker_identity,
                    "error": str(error),
                },
            )

    async def stop(self, *, drain: bool = True) -> None:
        if self._stop_task is None:
            self.closed = True
            self._stop_task = asyncio.create_task(self._stop(drain=drain))
        await finish_on_cancel(self._stop_task)

    async def _stop(self, *, drain: bool) -> None:
        released = False
        try:
            await self.release_track(drain=drain)
            released = True
        finally:
            # A cancelled/failed track drain must still terminate the publisher.
            await self._caption_publisher.aclose(drain=drain and released)

    @property
    def speaker_identity(self) -> str:
        return getattr(self.participant, "identity", "unknown")

    @property
    def speaker_name(self) -> str:
        return getattr(self.participant, "name", None) or self.speaker_identity

    @property
    def speaker_user_id(self) -> Optional[str]:
        return _get_participant_user_id(self.participant)

    def resolve_track_sid(self) -> Optional[str]:
        """Best-effort microphone track sid for this participant.

        Only used to annotate the segment; a missing sid must never stop a
        transcript from being persisted.
        """

        publications = getattr(self.participant, "track_publications", None) or {}
        values = publications.values() if isinstance(publications, dict) else publications
        for publication in values:
            source = getattr(publication, "source", None)
            if source is not None and source != rtc.TrackSource.SOURCE_MICROPHONE:
                continue
            sid = getattr(publication, "sid", None) or getattr(
                publication, "track_sid", None
            )
            if sid:
                return str(sid)
        return None

    async def persist_final_transcript_text(
        self,
        content: str,
        *,
        track_sid: Optional[str] = None,
    ) -> None:
        text = _normalize_transcript_content(content)
        if _should_skip_transcript_content(text):
            return

        if self.speaker_identity in self.meeting_session.suppressed_speaker_identities:
            LOGGER.info(
                "skipping suppressed speaker transcript segment",
                extra={
                    "meetingId": self.meeting_session.request.meetingId,
                    "speakerIdentity": self.speaker_identity,
                },
            )
            return

        source_segment_id = f"lk-{uuid.uuid4().hex}"
        started_at = _utc_now()
        ended_at = _utc_now()
        segment: Dict[str, Any] = {
            "speakerIdentity": self.speaker_identity,
            "speakerUserId": self.speaker_user_id,
            "speakerName": self.speaker_name,
            "content": text,
            "startedAt": started_at.isoformat(),
            "endedAt": ended_at.isoformat(),
            "segmentId": source_segment_id,
        }
        if track_sid:
            segment["trackSid"] = track_sid

        await self.meeting_session.assistant_client.send_event(
            LiveTranscriptEvent(
                type="live_transcript_segment",
                meetingId=self.meeting_session.request.meetingId,
                segment=segment,
                metadata={
                    "transcriptionModel": self.meeting_session.settings.transcription_model,
                    "language": self.meeting_session.language_metadata,
                },
            ).model_dump(mode="json", exclude_none=True)
        )
        self.meeting_session.persisted_segment_count += 1
        self.meeting_session.last_persisted_segment_at = _utc_now()


class MeetingSession:
    def __init__(
        self,
        *,
        request: StartSessionRequest,
        settings: Settings,
        assistant_client: AssistantCallbackClient,
        metrics: RealtimeMetrics,
        admission: Optional[SttAdmissionController] = None,
    ) -> None:
        self.request = request
        self.settings = settings
        self.assistant_client = assistant_client
        self.metrics = metrics
        self.gate_settings: SttGateSettings = settings.stt_gate_settings()
        # The admission budget is process-wide, so it is normally owned by the
        # session manager and shared across meetings.
        self.admission = admission or SttAdmissionController(
            self.gate_settings.admission_capacity
        )
        self.gate_observer: SttGateObserver = _MetricsSttGateObserver(
            metrics=metrics,
            admission=self.admission,
        )
        self.room = rtc.Room()
        self.vad = build_transcriber_vad()
        self.recording_dir = Path(settings.meeting_recordings_dir) / request.meetingId
        self.participant_sessions: dict[str, ParticipantTranscriptionSession] = {}
        self._participant_session_start_locks: dict[str, asyncio.Lock] = {}
        self.suppressed_speaker_identities: set[str] = set()
        self.background_tasks: set[asyncio.Task[Any]] = set()
        self.http_session: Optional[aiohttp.ClientSession] = None
        self.persisted_segment_count = 0
        self.last_persisted_segment_at: Optional[datetime] = None
        self.state = "created"
        self._stop_lock = asyncio.Lock()
        self._closed = False

    @property
    def language_metadata(self) -> str:
        return self.settings.transcription_language or "auto"

    async def ensure_http_session(self) -> aiohttp.ClientSession:
        if self.http_session is None or self.http_session.closed:
            connector = aiohttp.TCPConnector(
                limit_per_host=50,
                keepalive_timeout=120,
            )
            self.http_session = aiohttp.ClientSession(connector=connector)
        return self.http_session

    async def close_http_session(self) -> None:
        if self.http_session is None:
            return

        await self.http_session.close()
        self.http_session = None

    def attach_background_task(
        self, task: asyncio.Task[Any], *, label: str, extra: Optional[Dict[str, Any]] = None
    ) -> None:
        self.background_tasks.add(task)

        def _on_done(completed: asyncio.Task[Any]) -> None:
            self.background_tasks.discard(completed)
            try:
                completed.result()
            except asyncio.CancelledError:
                LOGGER.info(
                    "background task cancelled",
                    extra={
                        "meetingId": self.request.meetingId,
                        "taskLabel": label,
                        **(extra or {}),
                    },
                )
            except Exception as error:
                LOGGER.exception(
                    "background task failed",
                    extra={
                        "meetingId": self.request.meetingId,
                        "taskLabel": label,
                        "error": str(error),
                        **(extra or {}),
                    },
                )

        task.add_done_callback(_on_done)

    def spawn_background_task(
        self, coro: Any, *, label: str, extra: Optional[Dict[str, Any]] = None
    ) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro)
        self.attach_background_task(task, label=label, extra=extra)
        return task

    async def _drain_background_tasks(self) -> None:
        background_tasks = list(self.background_tasks)
        if not background_tasks:
            return

        _, pending_tasks = await asyncio.wait(
            background_tasks,
            timeout=BACKGROUND_TASK_DRAIN_TIMEOUT_SECONDS,
        )
        for task in pending_tasks:
            task.cancel()
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)

    def _subscribe_to_microphone_publication(
        self,
        participant: rtc.RemoteParticipant,
        publication: Any,
    ) -> bool:
        """Subscribe only to audio that can feed a participant transcriber."""

        if not _is_human_meeting_participant(participant):
            return False
        if getattr(publication, "source", None) != rtc.TrackSource.SOURCE_MICROPHONE:
            return False

        try:
            publication.set_subscribed(True)
        except Exception as error:
            self.metrics.record_track_subscription_failure(
                reason="subscribe-request-failed"
            )
            LOGGER.warning(
                "failed to request microphone subscription",
                extra={
                    "meetingId": self.request.meetingId,
                    "participantIdentity": getattr(
                        participant, "identity", "unknown"
                    ),
                    "trackSid": getattr(publication, "sid", None),
                    "error": str(error),
                },
            )
            return False
        return True

    def _subscribe_to_existing_microphones(
        self,
        participant: rtc.RemoteParticipant,
    ) -> int:
        publications = getattr(participant, "track_publications", None) or {}
        values = (
            publications.values()
            if isinstance(publications, dict)
            else publications
        )
        try:
            publications_to_check = list(values)
        except TypeError:
            return 0
        return sum(
            1
            for publication in publications_to_check
            if self._subscribe_to_microphone_publication(participant, publication)
        )

    async def _start_participant_and_subscribe_existing(
        self,
        *,
        participant: rtc.RemoteParticipant,
        reason: str,
    ) -> None:
        # Create the consumer before requesting subscription. LiveKit may emit
        # track_subscribed immediately, and that callback needs a session to
        # bind the track to.
        await self._start_participant_session_safely(
            participant=participant,
            reason=reason,
        )
        if getattr(participant, "identity", "") not in self.participant_sessions:
            return
        self._subscribe_to_existing_microphones(participant)

    async def _start_participant_and_subscribe_publication(
        self,
        *,
        participant: rtc.RemoteParticipant,
        publication: Any,
        reason: str,
    ) -> None:
        await self._start_participant_session_safely(
            participant=participant,
            reason=reason,
        )
        if getattr(participant, "identity", "") not in self.participant_sessions:
            return
        self._subscribe_to_microphone_publication(participant, publication)

    async def start(self) -> None:
        self.state = "starting"
        await asyncio.to_thread(self.recording_dir.mkdir, parents=True, exist_ok=True)

        @self.room.on("participant_connected")
        def _on_participant_connected(participant: rtc.RemoteParticipant) -> None:
            self.spawn_background_task(
                self._start_participant_and_subscribe_existing(
                    participant=participant,
                    reason="participant-connected",
                ),
                label="participant-connected",
                extra={"participantIdentity": getattr(participant, "identity", "unknown")},
            )

        @self.room.on("track_published")
        def _on_track_published(
            publication: Any,
            participant: rtc.RemoteParticipant,
        ) -> None:
            if not _is_human_meeting_participant(participant):
                return
            if getattr(publication, "source", None) != rtc.TrackSource.SOURCE_MICROPHONE:
                return
            self.spawn_background_task(
                self._start_participant_and_subscribe_publication(
                    participant=participant,
                    publication=publication,
                    reason="microphone-published",
                ),
                label="participant-microphone-published",
                extra={"participantIdentity": participant.identity},
            )

        @self.room.on("track_subscribed")
        def _on_track_subscribed(
            track: Any,
            publication: Any,
            participant: rtc.RemoteParticipant,
        ) -> None:
            if getattr(publication, "source", None) != rtc.TrackSource.SOURCE_MICROPHONE:
                return
            session = self.participant_sessions.get(getattr(participant, "identity", ""))
            if session is None:
                return
            # Binds on first subscribe and rebinds after a mute/unpublish
            # cycle, which republishes a new track object.
            self.spawn_background_task(
                session.use_track(track),
                label="participant-track-subscribed",
                extra={"participantIdentity": participant.identity},
            )

        @self.room.on("track_unsubscribed")
        def _on_track_unsubscribed(
            track: Any,
            publication: Any,
            participant: rtc.RemoteParticipant,
        ) -> None:
            if getattr(publication, "source", None) != rtc.TrackSource.SOURCE_MICROPHONE:
                return
            session = self.participant_sessions.get(getattr(participant, "identity", ""))
            if session is None:
                return
            # Keep the session — the participant is still here and may
            # unmute — but stop consuming a track that no longer exists.
            self.spawn_background_task(
                session.release_track(track=track, drain=True),
                label="participant-track-unsubscribed",
                extra={"participantIdentity": participant.identity},
            )

        @self.room.on("participant_disconnected")
        def _on_participant_disconnected(participant: rtc.RemoteParticipant) -> None:
            self.spawn_background_task(
                self._stop_participant_session(participant=participant),
                label="participant-disconnected",
                extra={"participantIdentity": getattr(participant, "identity", "unknown")},
            )

        @self.room.on("reconnecting")
        def _on_reconnecting() -> None:
            LOGGER.warning(
                "room reconnecting",
                extra={"meetingId": self.request.meetingId, "roomName": self.request.roomName},
            )

        @self.room.on("reconnected")
        def _on_reconnected() -> None:
            LOGGER.info(
                "room reconnected",
                extra={"meetingId": self.request.meetingId, "roomName": self.request.roomName},
            )

        @self.room.on("disconnected")
        def _on_disconnected(reason: Any) -> None:
            LOGGER.info(
                "room disconnected",
                extra={
                    "meetingId": self.request.meetingId,
                    "roomName": self.request.roomName,
                    "reason": str(reason),
                },
            )

        await asyncio.wait_for(
            self.room.connect(
                self.request.livekitUrl,
                self.request.token,
                rtc.RoomOptions(
                    auto_subscribe=False,
                    dynacast=False,
                    connect_timeout=float(self.settings.room_connect_timeout_seconds),
                ),
            ),
            timeout=self.settings.room_connect_timeout_seconds,
        )
        self.state = "connected"

        for participant in list(self.room.remote_participants.values()):
            await self._start_participant_and_subscribe_existing(
                participant=participant,
                reason="initial-room-participants",
            )

        self.spawn_background_task(
            self._participant_session_reconcile_loop(),
            label="participant-session-reconcile",
        )

    async def stop(self, *, finalize: bool, drain: bool) -> bool:
        return await finish_on_cancel(asyncio.create_task(self._stop(finalize=finalize, drain=drain)))

    async def _stop(self, *, finalize: bool, drain: bool) -> bool:
        async with self._stop_lock:
            if self._closed:
                return False
            self._closed = True
            self.state = "stopping"

            participant_sessions = list(self.participant_sessions.values())
            self.participant_sessions.clear()
            await asyncio.gather(
                *(session.stop(drain=drain) for session in participant_sessions),
                return_exceptions=True,
            )
            for _ in participant_sessions:
                self.metrics.record_track_worker_stopped()

            await self._drain_background_tasks()
            settle_metadata: Optional[Dict[str, Any]] = None
            if finalize:
                settle_metadata = await self._wait_for_transcript_settle()
                await self._drain_background_tasks()

            await asyncio.gather(self.room.disconnect(), return_exceptions=True)
            await self.close_http_session()
            self.state = "stopped"

            if not finalize:
                return False

            return await self._finalize_transcript(settle_metadata=settle_metadata)

    def set_participant_transcription_suppressed(
        self, *, participant_identity: str, suppressed: bool
    ) -> bool:
        if suppressed:
            if participant_identity in self.suppressed_speaker_identities:
                return False
            self.suppressed_speaker_identities.add(participant_identity)
            return True

        if participant_identity not in self.suppressed_speaker_identities:
            return False

        self.suppressed_speaker_identities.remove(participant_identity)
        return True

    async def _start_participant_session(self, *, participant: rtc.RemoteParticipant) -> None:
        if not _is_human_meeting_participant(participant):
            LOGGER.info(
                "skipping non-human participant for backend transcription",
                extra={
                    "meetingId": self.request.meetingId,
                    "participantIdentity": getattr(participant, "identity", "unknown"),
                },
            )
            return

        if participant.identity in self.participant_sessions:
            return

        participant_session = ParticipantTranscriptionSession(
            meeting_session=self,
            participant=participant,
        )
        self.participant_sessions[participant.identity] = participant_session
        self.metrics.record_track_worker_started()
        LOGGER.info(
            "participant transcription session starting",
            extra={
                "meetingId": self.request.meetingId,
                "participantIdentity": participant.identity,
                "sttModel": self.settings.transcription_model,
                "languageMode": self.language_metadata,
            },
        )

        try:
            await participant_session.start()
        except Exception:
            self.participant_sessions.pop(participant.identity, None)
            self.metrics.record_track_worker_stopped()
            raise

    async def _start_participant_session_safely(
        self, *, participant: rtc.RemoteParticipant, reason: str
    ) -> None:
        participant_identity = getattr(participant, "identity", "unknown")
        start_lock = self._participant_session_start_locks.setdefault(
            participant_identity,
            asyncio.Lock(),
        )
        # participant_connected and track_published can arrive back-to-back.
        # A session is placed in participant_sessions before its async start
        # finishes, so membership alone does not mean it is ready to consume a
        # newly subscribed track. Serialize startup for the same participant.
        async with start_lock:
            try:
                await self._start_participant_session(participant=participant)
            except Exception as error:
                LOGGER.exception(
                    "participant transcription session failed",
                    extra={
                        "meetingId": self.request.meetingId,
                        "roomName": self.request.roomName,
                        "participantIdentity": participant_identity,
                        "reason": reason,
                        "error": str(error),
                    },
                )

    async def _stop_participant_session(self, *, participant: rtc.RemoteParticipant) -> None:
        participant_session = self.participant_sessions.pop(participant.identity, None)
        if participant_session is None:
            return

        try:
            await participant_session.stop(drain=True)
        finally:
            self.metrics.record_track_worker_stopped()
        LOGGER.info(
            "participant transcription session stopped",
            extra={
                "meetingId": self.request.meetingId,
                "participantIdentity": participant.identity,
            },
        )

    async def _reconcile_participant_sessions(self, *, reason: str) -> None:
        participants = list(self.room.remote_participants.values())
        eligible_participants = [
            participant
            for participant in participants
            if _is_human_meeting_participant(participant)
        ]
        missing_participants = [
            participant
            for participant in eligible_participants
            if participant.identity not in self.participant_sessions
        ]
        # A session can be present but dead: its STT reported an unrecoverable
        # error and nothing reopened it. Without this pass the participant just
        # stops appearing in the transcript, with no restart and no alarm.
        unhealthy_participants = [
            participant
            for participant in eligible_participants
            if (
                participant.identity in self.participant_sessions
                and self.participant_sessions[participant.identity].needs_stt_recovery()
            )
        ]
        if not missing_participants and not unhealthy_participants:
            return

        LOGGER.info(
            "reconciling participant transcription sessions",
            extra={
                "meetingId": self.request.meetingId,
                "roomName": self.request.roomName,
                "reason": reason,
                "eligibleParticipants": len(eligible_participants),
                "activeParticipantTranscribers": len(self.participant_sessions),
                "missingParticipantIdentities": [
                    participant.identity for participant in missing_participants
                ],
                "unhealthyParticipantIdentities": [
                    participant.identity for participant in unhealthy_participants
                ],
            },
        )

        for participant in unhealthy_participants:
            self.metrics.record_stt_stream_error(reason="restarted")
            await self._stop_participant_session(participant=participant)

        for participant in missing_participants + unhealthy_participants:
            await self._start_participant_and_subscribe_existing(
                participant=participant,
                reason=reason,
            )

    async def _participant_session_reconcile_loop(self) -> None:
        while not self._closed:
            await asyncio.sleep(PARTICIPANT_RECONCILE_INTERVAL_SECONDS)
            if self._closed:
                return
            await self._reconcile_participant_sessions(reason="periodic")

    async def _wait_for_transcript_settle(self) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        started_at = loop.time()
        deadline = started_at + TRANSCRIPT_SETTLE_MAX_SECONDS
        initial_segment_count = self.persisted_segment_count
        settled = self.last_persisted_segment_at is None

        while not settled:
            last_segment_at = self.last_persisted_segment_at
            if last_segment_at is None:
                idle_for_seconds = loop.time() - started_at
            else:
                idle_for_seconds = (_utc_now() - last_segment_at).total_seconds()
            if idle_for_seconds >= TRANSCRIPT_SETTLE_IDLE_SECONDS:
                settled = True
                break

            remaining_seconds = deadline - loop.time()
            if remaining_seconds <= 0:
                break

            await asyncio.sleep(
                min(
                    TRANSCRIPT_SETTLE_POLL_SECONDS,
                    TRANSCRIPT_SETTLE_IDLE_SECONDS - idle_for_seconds,
                    remaining_seconds,
                )
            )

        waited_seconds = loop.time() - started_at
        metadata = {
            "transcriptSettleWaitSeconds": round(waited_seconds, 3),
            "transcriptSettleIdleSeconds": TRANSCRIPT_SETTLE_IDLE_SECONDS,
            "transcriptSettleMaxSeconds": TRANSCRIPT_SETTLE_MAX_SECONDS,
            "transcriptSettleComplete": settled,
            "segmentCountBeforeSettle": initial_segment_count,
            "segmentCountAfterSettle": self.persisted_segment_count,
        }
        LOGGER.info(
            "transcript settle window completed",
            extra={
                "meetingId": self.request.meetingId,
                **metadata,
            },
        )
        return metadata

    async def _finalize_transcript(
        self, *, settle_metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        finalized_at = _utc_now_iso()
        metadata = {
            "mode": "agent-live-finalized",
            "segmentCount": self.persisted_segment_count,
            "refinedAt": finalized_at,
            "recordingDir": str(self.recording_dir),
            "transcriptionModel": self.settings.transcription_model,
            "language": self.language_metadata,
        }
        if settle_metadata:
            metadata.update(settle_metadata)

        await self.assistant_client.send_event(
            FinalTranscriptEvent(
                type="final_transcript",
                meetingId=self.request.meetingId,
                segments=[],
                metadata=metadata,
            ).model_dump(mode="json", exclude_none=True)
        )
        return True


class RealtimeSessionManager:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._metrics = RealtimeMetrics()
        self._assistant_client = AssistantCallbackClient(settings, self._metrics)
        self._gate_settings = settings.stt_gate_settings()
        # One budget for the whole process: concurrency is capped by the
        # provider account, not by any single meeting.
        self._admission = SttAdmissionController(self._gate_settings.admission_capacity)
        self._sessions: dict[str, MeetingSession] = {}
        self._lock = asyncio.Lock()
        self._ready = False

    async def aclose(self) -> None:
        self._ready = False
        await self.stop_all(finalize=False, drain=False)
        await self._assistant_client.aclose()

    def mark_ready(self, ready: bool) -> None:
        self._ready = ready
        self._metrics.record_service_ready(ready)

    async def start_session(self, request: StartSessionRequest) -> bool:
        async with self._lock:
            if request.meetingId in self._sessions:
                self._metrics.record_start_request("duplicate")
                return False

            session = MeetingSession(
                request=request,
                settings=self._settings,
                assistant_client=self._assistant_client,
                metrics=self._metrics,
                admission=self._admission,
            )
            self._sessions[request.meetingId] = session
            self._metrics.record_active_sessions(len(self._sessions))

        try:
            await session.start()
        except Exception:
            async with self._lock:
                if self._sessions.get(request.meetingId) is session:
                    self._sessions.pop(request.meetingId, None)
                self._metrics.record_active_sessions(len(self._sessions))

            self._metrics.record_start_request("failed")
            await asyncio.gather(
                session.stop(finalize=False, drain=False),
                return_exceptions=True,
            )
            session.state = "failed"
            raise

        async with self._lock:
            if self._sessions.get(request.meetingId) is not session:
                return False

            self._metrics.record_start_request("started")
            self._metrics.record_session_started()
            self._metrics.record_active_sessions(len(self._sessions))

        LOGGER.info(
            "meeting session started",
            extra={"meetingId": request.meetingId, "roomName": request.roomName},
        )
        return True

    async def stop_session(self, meeting_id: str, *, finalize: bool, drain: bool) -> tuple[bool, bool]:
        async with self._lock:
            session = self._sessions.pop(meeting_id, None)
            self._metrics.record_active_sessions(len(self._sessions))

        if session is None:
            self._metrics.record_stop_request("missing")
            return False, False

        try:
            finalized = await session.stop(finalize=finalize, drain=drain)
        except Exception:
            self._metrics.record_stop_request("failed")
            raise
        self._metrics.record_stop_request("stopped")
        LOGGER.info(
            "meeting session stopped",
            extra={"meetingId": meeting_id, "finalized": finalized},
        )
        return True, finalized

    async def stop_all(self, *, finalize: bool, drain: bool) -> None:
        async with self._lock:
            items = list(self._sessions.items())
            self._sessions.clear()
            self._metrics.record_active_sessions(0)

        await asyncio.gather(
            *(session.stop(finalize=finalize, drain=drain) for _, session in items),
            return_exceptions=True,
        )

    async def set_participant_transcription_suppressed(
        self, meeting_id: str, *, participant_identity: str, suppressed: bool
    ) -> bool:
        async with self._lock:
            session = self._sessions.get(meeting_id)

        if session is None:
            return False

        updated = session.set_participant_transcription_suppressed(
            participant_identity=participant_identity,
            suppressed=suppressed,
        )
        LOGGER.info(
            "updated participant transcription suppression",
            extra={
                "meetingId": meeting_id,
                "participantIdentity": participant_identity,
                "suppressed": suppressed,
                "updated": updated,
            },
        )
        self._metrics.record_participant_suppression_update(
            suppressed=suppressed,
            updated=updated,
        )
        return updated

    def readiness(self) -> dict[str, Any]:
        return {
            "ready": self._ready,
            "activeMeetings": len(self._sessions),
        }

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok" if self._ready else "degraded",
            "activeMeetings": len(self._sessions),
            "sttGate": {
                "mode": self._gate_settings.mode,
                "holdOpenSeconds": self._gate_settings.hold_open_seconds,
                **self._admission.snapshot(),
            },
            "sessions": {
                meeting_id: {
                    "state": session.state,
                    "suppressedParticipants": len(session.suppressed_speaker_identities),
                    "participantTranscribers": len(session.participant_sessions),
                    "unhealthyParticipantTranscribers": sum(
                        1
                        for participant_session in session.participant_sessions.values()
                        if participant_session.stt_failed_at is not None
                    ),
                    "sttModel": session.settings.transcription_model,
                    "languageMode": session.language_metadata,
                }
                for meeting_id, session in self._sessions.items()
            },
        }

    def render_metrics(self) -> str:
        return self._metrics.render_prometheus()
