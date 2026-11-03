from __future__ import annotations

import asyncio
import os
import sys
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, List
from unittest.mock import ANY, AsyncMock, Mock, call, patch


SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from livekit import rtc
from livekit.agents import stt as stt_api

from app.config import Settings, load_settings
from app.schemas import StartSessionRequest
import app.session_manager as session_manager


class TrustedParticipantIdentityTests(unittest.TestCase):
    def test_guest_and_sip_user_ids_require_canonical_uuid_strings(self):
        user_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        for identity, kind in [("guest:request", None), ("sip_call", rtc.ParticipantKind.PARTICIPANT_KIND_SIP)]:
            for bad_id in ["not-a-uuid", user_id + "junk", user_id.replace("-", ""), 123, None]:
                participant = SimpleNamespace(identity=identity, kind=kind,
                    attributes={"userId": bad_id}, metadata="{}")
                self.assertIsNone(session_manager._get_participant_user_id(participant))
                participant.metadata = '{"userId":"' + user_id.upper() + '"}'
                self.assertEqual(session_manager._get_participant_user_id(participant), user_id)
            for metadata in ["[]", "null", "123", '{"userId":123}', '{"userId":"bad"}', "invalid json"]:
                participant = SimpleNamespace(identity=identity, kind=kind, attributes={}, metadata=metadata)
                self.assertIsNone(session_manager._get_participant_user_id(participant))

    def test_mutable_metadata_cannot_override_authenticated_speaker(self):
        user_id = "11111111-1111-4111-8111-111111111111"
        victim_id = "22222222-2222-4222-8222-222222222222"
        participant = SimpleNamespace(identity=f"{user_id}:browser",
            attributes={"userId": victim_id}, metadata='{"userId":"' + victim_id + '"}')
        self.assertEqual(session_manager._get_participant_user_id(participant), user_id)
        participant.attributes = {}
        self.assertEqual(session_manager._get_participant_user_id(participant), user_id)
        participant.identity = "untrusted-worker"
        self.assertIsNone(session_manager._get_participant_user_id(participant))

from app.session_manager import (
    MeetingSession,
    ParticipantTranscriptionSession,
    RealtimeSessionManager,
    _build_elevenlabs_stt,
    _utc_now,
)


DEFAULT_TEST_STT_MODEL = "scribe_v2_realtime"
EXPECTED_ELEVENLABS_SERVER_VAD = {
    "vad_silence_threshold_secs": 0.5,
    "vad_threshold": 0.4,
    "min_speech_duration_ms": 100,
    "min_silence_duration_ms": 100,
}


async def flush_captions(participant_session) -> None:
    """Drain and close the per-participant caption worker.

    Captions are published off the STT consumption path now, so a test that
    triggers a speech event must explicitly wait for worker shutdown before
    asserting. Polling the deque is insufficient because the worker removes
    an item before its network publish finishes.
    """

    await participant_session._caption_publisher.aclose(drain=True)


async def _empty_async_iter():
    return
    yield  # pragma: no cover - makes this an async generator


def make_settings() -> Settings:
    return Settings(
        port=4200,
        service_secret="test-secret",
        assistant_callback_url="http://assistant.test",
        assistant_service_secret="assistant-secret",
        eleven_api_key="test-eleven-key",
        meeting_recordings_dir="/tmp/readymeet-recordings-tests",
        transcription_model=DEFAULT_TEST_STT_MODEL,
        transcription_language="",
        room_connect_timeout_seconds=20,
        assistant_callback_timeout_seconds=20.0,
    )


def make_start_request() -> StartSessionRequest:
    return StartSessionRequest(
        meetingId="550e8400-e29b-41d4-a716-446655440000",
        roomName="abc-def-ghi",
        livekitUrl="wss://example.livekit.cloud",
        token="token",
        participantIdentity="transcriber-550e8400",
        participantName="ReadyMeet Transcriber",
        participantNames=["Personbu"],
    )


class RealtimeSessionManagerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.manager = RealtimeSessionManager(make_settings())

    async def asyncTearDown(self) -> None:
        await self.manager.aclose()

    async def test_start_session_is_idempotent_for_duplicate_meeting(self) -> None:
        request = make_start_request()

        with patch("app.session_manager.MeetingSession.start", new=AsyncMock(return_value=None)):
            started = await self.manager.start_session(request)
            duplicate = await self.manager.start_session(request)

        self.assertTrue(started)
        self.assertFalse(duplicate)
        self.assertEqual(self.manager.health()["activeMeetings"], 1)

    async def test_start_session_is_idempotent_while_first_start_is_pending(self) -> None:
        request = make_start_request()
        start_entered = asyncio.Event()
        allow_start_to_finish = asyncio.Event()

        async def slow_start(_: MeetingSession) -> None:
            start_entered.set()
            await allow_start_to_finish.wait()

        with patch("app.session_manager.MeetingSession.start", new=slow_start):
            first_start = asyncio.create_task(self.manager.start_session(request))
            await start_entered.wait()

            duplicate = await self.manager.start_session(request)
            allow_start_to_finish.set()
            started = await first_start

        self.assertTrue(started)
        self.assertFalse(duplicate)
        self.assertEqual(self.manager.health()["activeMeetings"], 1)

    async def test_stop_session_is_idempotent(self) -> None:
        request = make_start_request()

        with patch("app.session_manager.MeetingSession.start", new=AsyncMock(return_value=None)), patch(
            "app.session_manager.MeetingSession.stop", new=AsyncMock(return_value=False)
        ) as stop_mock:
            await self.manager.start_session(request)
            stopped, finalized = await self.manager.stop_session(
                request.meetingId, finalize=False, drain=False
            )
            stopped_again, finalized_again = await self.manager.stop_session(
                request.meetingId, finalize=False, drain=False
            )

        self.assertTrue(stopped)
        self.assertFalse(finalized)
        self.assertFalse(stopped_again)
        self.assertFalse(finalized_again)
        self.assertEqual(stop_mock.await_count, 1)

    async def test_participant_suppression_is_idempotent(self) -> None:
        request = make_start_request()

        with patch("app.session_manager.MeetingSession.start", new=AsyncMock(return_value=None)):
            await self.manager.start_session(request)

        updated = await self.manager.set_participant_transcription_suppressed(
            request.meetingId,
            participant_identity="user-1",
            suppressed=True,
        )
        duplicate = await self.manager.set_participant_transcription_suppressed(
            request.meetingId,
            participant_identity="user-1",
            suppressed=True,
        )
        cleared = await self.manager.set_participant_transcription_suppressed(
            request.meetingId,
            participant_identity="user-1",
            suppressed=False,
        )

        self.assertTrue(updated)
        self.assertFalse(duplicate)
        self.assertTrue(cleared)

    async def test_readiness_reflects_mark_ready_state(self) -> None:
        self.manager.mark_ready(True)
        self.assertTrue(self.manager.readiness()["ready"])
        self.assertEqual(self.manager.health()["status"], "ok")

        self.manager.mark_ready(False)
        self.assertFalse(self.manager.readiness()["ready"])
        self.assertEqual(self.manager.health()["status"], "degraded")


class DirectTranscriptionTests(unittest.IsolatedAsyncioTestCase):
    async def test_config_defaults_to_scribe_v2_realtime(self) -> None:
        with patch("app.config._load_env", return_value=None), patch.dict(
            os.environ,
            {
                "LIVEKIT_REALTIME_SERVICE_SECRET": "test-secret",
                "ASSISTANT_SERVICE_SECRET": "assistant-secret",
                "ELEVEN_API_KEY": "test-eleven-key",
            },
            clear=True,
        ):
            settings = load_settings()

        self.assertEqual(settings.transcription_model, DEFAULT_TEST_STT_MODEL)
        self.assertEqual(settings.eleven_api_key, "test-eleven-key")
        self.assertNotIn("test-eleven-key", repr(settings))
        self.assertEqual(settings.transcription_language, "")
        self.assertEqual(settings.transcription_vad_silence_threshold_seconds, 0.5)
        self.assertEqual(settings.transcription_vad_threshold, 0.4)
        self.assertEqual(settings.transcription_vad_min_speech_duration_ms, 100)
        self.assertEqual(settings.transcription_vad_min_silence_duration_ms, 100)

    async def test_config_ignores_stale_stream_source_and_observer_credentials(self) -> None:
        with patch("app.config._load_env", return_value=None), patch.dict(
            os.environ,
            {
                "LIVEKIT_REALTIME_SERVICE_SECRET": "test-secret",
                "ASSISTANT_SERVICE_SECRET": "assistant-secret",
                "ELEVEN_API_KEY": "test-eleven-key",
                "LIVEKIT_REALTIME_TRANSCRIPT_SOURCE": "stream",
                "LIVEKIT_API_KEY": "obsolete-observer-key",
                "LIVEKIT_API_SECRET": "obsolete-observer-secret",
            },
            clear=True,
        ):
            settings = load_settings()

        self.assertFalse(hasattr(settings, "transcript_source"))
        self.assertFalse(hasattr(settings, "livekit_api_key"))
        self.assertFalse(hasattr(settings, "livekit_api_secret"))

    async def test_elevenlabs_stt_defaults_to_auto_language(self) -> None:
        settings = make_settings()

        with patch("app.session_manager.elevenlabs.STT", return_value=object()) as stt_factory:
            stt = _build_elevenlabs_stt(settings)

        self.assertIsNotNone(stt)
        stt_factory.assert_called_once_with(
            api_key="test-eleven-key",
            model=DEFAULT_TEST_STT_MODEL,
            server_vad=EXPECTED_ELEVENLABS_SERVER_VAD,
        )

    async def test_elevenlabs_stt_uses_server_vad_instead_of_manual_commit(self) -> None:
        settings = make_settings()

        with patch("app.session_manager.elevenlabs.STT", return_value=object()) as stt_factory:
            _build_elevenlabs_stt(settings)

        server_vad = stt_factory.call_args.kwargs["server_vad"]
        self.assertLessEqual(server_vad["vad_silence_threshold_secs"], 0.5)
        self.assertEqual(server_vad, EXPECTED_ELEVENLABS_SERVER_VAD)

    async def test_transcriber_vad_filters_clicks_and_breaths(self) -> None:
        # Clicks die on duration, breaths die on confidence; real short words
        # ("yes", "no") still pass and prefix padding keeps their onset audio.
        self.assertGreaterEqual(
            session_manager.TRANSCRIBER_VAD_OPTIONS["min_speech_duration"], 0.15
        )
        self.assertLessEqual(
            session_manager.TRANSCRIBER_VAD_OPTIONS["min_speech_duration"], 0.3
        )
        self.assertGreater(
            session_manager.TRANSCRIBER_VAD_OPTIONS["activation_threshold"], 0.5
        )
        self.assertGreaterEqual(
            session_manager.TRANSCRIBER_VAD_OPTIONS["prefix_padding_duration"], 0.3
        )

        with patch("app.session_manager.silero.VAD.load", return_value=object()) as vad_load:
            session_manager.build_transcriber_vad()

        vad_load.assert_called_once_with(**session_manager.TRANSCRIBER_VAD_OPTIONS)

    async def test_transcriber_audio_input_uses_noise_cancellation_when_available(self) -> None:
        sentinel = object()

        fake_plugin = SimpleNamespace(BVC=Mock(return_value=sentinel))
        with patch.object(session_manager, "livekit_noise_cancellation", fake_plugin):
            cancellation = session_manager.build_transcriber_noise_cancellation()

        # BVC is applied per track, so one shared room connection still gives
        # every participant independent voice isolation.
        self.assertIs(cancellation, sentinel)

        with patch.object(session_manager, "livekit_noise_cancellation", None):
            fallback = session_manager.build_transcriber_noise_cancellation()

        self.assertIsNone(fallback)

    async def test_transcriber_audio_input_preserves_roomio_gain_control(self) -> None:
        processor = object()
        with patch.object(
            session_manager.rtc,
            "AudioProcessingModule",
            return_value=processor,
        ) as processing_module:
            result = session_manager.build_transcriber_audio_processing()

        self.assertIs(result, processor)
        processing_module.assert_called_once_with(auto_gain_control=True)

    async def test_elevenlabs_stt_uses_explicit_http_session_outside_agent_jobs(self) -> None:
        settings = make_settings()
        http_session = object()

        with patch("app.session_manager.elevenlabs.STT", return_value=object()) as stt_factory:
            _build_elevenlabs_stt(settings, http_session=http_session)

        stt_factory.assert_called_once_with(
            api_key="test-eleven-key",
            model=DEFAULT_TEST_STT_MODEL,
            server_vad=EXPECTED_ELEVENLABS_SERVER_VAD,
            http_session=http_session,
        )

    async def test_elevenlabs_stt_treats_multi_as_auto_language_detection(self) -> None:
        settings = Settings(**{**make_settings().__dict__, "transcription_language": "multi"})

        with patch("app.session_manager.elevenlabs.STT", return_value=object()) as stt_factory:
            _build_elevenlabs_stt(settings)

        stt_factory.assert_called_once_with(
            api_key="test-eleven-key",
            model=DEFAULT_TEST_STT_MODEL,
            server_vad=EXPECTED_ELEVENLABS_SERVER_VAD,
        )

    async def test_elevenlabs_stt_maps_explicit_language_to_plugin_parameter(self) -> None:
        settings = Settings(**{**make_settings().__dict__, "transcription_language": "en"})

        with patch("app.session_manager.elevenlabs.STT", return_value=object()) as stt_factory:
            _build_elevenlabs_stt(settings)

        stt_factory.assert_called_once_with(
            api_key="test-eleven-key",
            model=DEFAULT_TEST_STT_MODEL,
            server_vad=EXPECTED_ELEVENLABS_SERVER_VAD,
            language_code="en",
        )

    async def test_config_normalizes_legacy_inference_model_for_plugin(self) -> None:
        with patch("app.config._load_env", return_value=None), patch.dict(
            os.environ,
            {
                "LIVEKIT_REALTIME_SERVICE_SECRET": "test-secret",
                "ASSISTANT_SERVICE_SECRET": "assistant-secret",
                "ELEVEN_API_KEY": "test-eleven-key",
                "LIVEKIT_REALTIME_STT_MODEL": "elevenlabs/scribe_v2_realtime",
            },
            clear=True,
        ):
            settings = load_settings()

        self.assertEqual(settings.transcription_model, DEFAULT_TEST_STT_MODEL)

    async def test_config_rejects_unsupported_plugin_model(self) -> None:
        with patch("app.config._load_env", return_value=None), patch.dict(
            os.environ,
            {
                "LIVEKIT_REALTIME_SERVICE_SECRET": "test-secret",
                "ASSISTANT_SERVICE_SECRET": "assistant-secret",
                "ELEVEN_API_KEY": "test-eleven-key",
                "LIVEKIT_REALTIME_STT_MODEL": "deepgram/nova-3:multi",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "LIVEKIT_REALTIME_STT_MODEL"):
                load_settings()

    async def test_config_requires_elevenlabs_key(self) -> None:
        with patch("app.config._load_env", return_value=None), patch.dict(
            os.environ,
            {
                "LIVEKIT_REALTIME_SERVICE_SECRET": "test-secret",
                "ASSISTANT_SERVICE_SECRET": "assistant-secret",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "ELEVEN_API_KEY"):
                load_settings()

    async def test_human_participant_starts_linked_agent_session(self) -> None:
        settings = make_settings()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=Mock(),
                metrics=Mock(),
            )
        participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
        )

        with patch.object(
            ParticipantTranscriptionSession,
            "start",
            new=AsyncMock(return_value=None),
        ) as start_mock:
            await session._start_participant_session(participant=participant)

        self.assertIn(participant.identity, session.participant_sessions)
        start_mock.assert_awaited_once()

    async def test_assistant_participant_is_not_transcribed(self) -> None:
        settings = make_settings()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=Mock(),
                metrics=Mock(),
            )
        participant = Mock(
            identity="readymeet-assistant-job",
            attributes={"assistantRole": "meeting-agent"},
            metadata="",
        )

        with patch.object(
            ParticipantTranscriptionSession,
            "start",
            new=AsyncMock(return_value=None),
        ) as start_mock:
            await session._start_participant_session(participant=participant)

        self.assertEqual(session.participant_sessions, {})
        start_mock.assert_not_awaited()

    async def test_sip_participant_without_user_id_starts_linked_agent_session(self) -> None:
        settings = make_settings()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=Mock(),
                metrics=Mock(),
            )
        participant = SimpleNamespace(
            identity="sip_+15551234567_x7Kp",
            name="Caller ...4567",
            attributes={"sip.callID": "call-1", "sip.phoneNumber": "+15551234567"},
            metadata="",
            kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP,
        )

        with patch.object(
            ParticipantTranscriptionSession,
            "start",
            new=AsyncMock(return_value=None),
        ) as start_mock:
            await session._start_participant_session(participant=participant)

        self.assertIn(participant.identity, session.participant_sessions)
        start_mock.assert_awaited_once()

    async def test_standard_participant_without_user_id_is_not_transcribed(self) -> None:
        settings = make_settings()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=Mock(),
                metrics=Mock(),
            )
        participant = SimpleNamespace(
            identity="backend-worker",
            name="",
            attributes={},
            metadata="",
            kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD,
        )

        with patch.object(
            ParticipantTranscriptionSession,
            "start",
            new=AsyncMock(return_value=None),
        ) as start_mock:
            await session._start_participant_session(participant=participant)

        self.assertEqual(session.participant_sessions, {})
        start_mock.assert_not_awaited()

    async def test_sip_final_speech_event_without_user_id_persists_with_caller_name(self) -> None:
        settings = make_settings()
        assistant_client = Mock()
        assistant_client.send_event = AsyncMock()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=assistant_client,
                metrics=Mock(),
            )
        participant = SimpleNamespace(
            identity="sip_+15551234567_x7Kp",
            name="Caller ...4567",
            attributes={"sip.callID": "call-1", "sip.phoneNumber": "+15551234567"},
            metadata="",
            kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP,
        )
        participant_session = ParticipantTranscriptionSession(
            meeting_session=session,
            participant=participant,
            stt=Mock(),
        )
        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(return_value="success"),
        ):
            await participant_session._handle_speech_event(
                SimpleNamespace(
                    type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                    alternatives=[SimpleNamespace(text="Hello from the phone.")],
                ),
                track_sid="TR_phone",
            )
            await flush_captions(participant_session)

        assistant_client.send_event.assert_awaited_once()
        payload = assistant_client.send_event.await_args.args[0]
        self.assertEqual(payload["segment"]["speakerIdentity"], participant.identity)
        self.assertEqual(payload["segment"]["speakerName"], "Caller ...4567")
        self.assertEqual(payload["segment"]["trackSid"], "TR_phone")
        self.assertEqual(payload["segment"]["content"], "Hello from the phone.")
        self.assertNotIn("speakerUserId", payload["segment"])
        self.assertEqual(session.persisted_segment_count, 1)


    async def test_reconcile_starts_missing_human_participant_sessions(self) -> None:
        settings = make_settings()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=Mock(),
                metrics=Mock(),
            )
        existing_participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
        )
        missing_participant = Mock(
            identity="650e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "650e8400-e29b-41d4-a716-446655440000"},
            metadata="",
        )
        assistant_participant = Mock(
            identity="readymeet-assistant-job",
            attributes={"assistantRole": "meeting-agent"},
            metadata="",
        )
        session.room = SimpleNamespace(
            remote_participants={
                existing_participant.identity: existing_participant,
                missing_participant.identity: missing_participant,
                assistant_participant.identity: assistant_participant,
            }
        )
        session.participant_sessions[existing_participant.identity] = Mock(
            needs_stt_recovery=Mock(return_value=False)
        )

        with patch.object(
            ParticipantTranscriptionSession,
            "start",
            new=AsyncMock(return_value=None),
        ) as start_mock:
            await session._reconcile_participant_sessions(reason="test")

        self.assertIn(existing_participant.identity, session.participant_sessions)
        self.assertIn(missing_participant.identity, session.participant_sessions)
        self.assertNotIn(assistant_participant.identity, session.participant_sessions)
        start_mock.assert_awaited_once()

    async def test_reconcile_continues_when_participant_session_start_fails(self) -> None:
        settings = make_settings()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=Mock(),
                metrics=Mock(),
            )
        failing_participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
        )
        succeeding_participant = Mock(
            identity="650e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "650e8400-e29b-41d4-a716-446655440000"},
            metadata="",
        )
        session.room = SimpleNamespace(
            remote_participants={
                failing_participant.identity: failing_participant,
                succeeding_participant.identity: succeeding_participant,
            }
        )

        with patch.object(
            ParticipantTranscriptionSession,
            "start",
            new=AsyncMock(side_effect=[RuntimeError("transcriber failed"), None]),
        ) as start_mock:
            await session._reconcile_participant_sessions(reason="test")

        self.assertNotIn(failing_participant.identity, session.participant_sessions)
        self.assertIn(succeeding_participant.identity, session.participant_sessions)
        self.assertEqual(start_mock.await_count, 2)

    async def test_final_speech_event_persists_from_events_source(self) -> None:
        settings = make_settings()
        assistant_client = Mock()
        assistant_client.send_event = AsyncMock()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=assistant_client,
                metrics=Mock(),
            )
        participant = SimpleNamespace(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            name="Personbu",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
            track_publications={
                "TR_microphone": SimpleNamespace(
                    source=rtc.TrackSource.SOURCE_MICROPHONE,
                    sid="TR_microphone",
                )
            },
        )
        participant_session = ParticipantTranscriptionSession(
            meeting_session=session,
            participant=participant,
        )

        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(return_value="success"),
        ) as publish_caption:
            await participant_session._handle_speech_event(
                SimpleNamespace(
                    type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                    alternatives=[SimpleNamespace(text="No niin, suomi toimii.")],
                )
            )
            await flush_captions(participant_session)

        publish_caption.assert_awaited_once_with(
            "No niin, suomi toimii.",
            is_final=True,
            track_sid="TR_microphone",
            segment_id=ANY,
        )
        assistant_client.send_event.assert_awaited_once()
        payload = assistant_client.send_event.await_args.args[0]
        self.assertEqual(payload["segment"]["content"], "No niin, suomi toimii.")
        self.assertEqual(
            payload["segment"]["speakerIdentity"],
            "550e8400-e29b-41d4-a716-446655440000:browser",
        )
        self.assertEqual(
            payload["segment"]["speakerUserId"],
            "550e8400-e29b-41d4-a716-446655440000",
        )
        self.assertEqual(payload["segment"]["speakerName"], "Personbu")
        self.assertEqual(payload["segment"]["trackSid"], "TR_microphone")
        self.assertEqual(session.persisted_segment_count, 1)
        self.assertIsNotNone(session.last_persisted_segment_at)


    async def test_interim_speech_event_only_publishes_caption(self) -> None:
        settings = make_settings()
        assistant_client = Mock()
        assistant_client.send_event = AsyncMock()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=assistant_client,
                metrics=Mock(),
            )
        participant_session = ParticipantTranscriptionSession(
            meeting_session=session,
            participant=SimpleNamespace(
                identity="550e8400-e29b-41d4-a716-446655440000:browser",
                name="Personbu",
                attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
                metadata="",
                track_publications={},
            ),
        )

        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(return_value="success"),
        ) as publish_caption:
            await participant_session._handle_speech_event(
                SimpleNamespace(
                    type=stt_api.SpeechEventType.INTERIM_TRANSCRIPT,
                    alternatives=[SimpleNamespace(text="interim")],
                )
            )
            await flush_captions(participant_session)

        publish_caption.assert_awaited_once_with(
            "interim",
            is_final=False,
            track_sid=None,
            segment_id=ANY,
        )
        assistant_client.send_event.assert_not_awaited()
        self.assertEqual(session.persisted_segment_count, 0)

    async def test_transcript_settle_completes_after_idle_window(self) -> None:
        settings = make_settings()
        assistant_client = Mock()
        assistant_client.send_event = AsyncMock()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=assistant_client,
                metrics=Mock(),
            )
        session.persisted_segment_count = 2
        session.last_persisted_segment_at = datetime.now(timezone.utc)

        with patch("app.session_manager.TRANSCRIPT_SETTLE_IDLE_SECONDS", 0.01), patch(
            "app.session_manager.TRANSCRIPT_SETTLE_MAX_SECONDS", 0.2
        ), patch("app.session_manager.TRANSCRIPT_SETTLE_POLL_SECONDS", 0.005):
            metadata = await session._wait_for_transcript_settle()

        self.assertTrue(metadata["transcriptSettleComplete"])
        self.assertEqual(metadata["segmentCountBeforeSettle"], 2)
        self.assertEqual(metadata["segmentCountAfterSettle"], 2)


    async def test_transcript_settle_stops_at_hard_cap(self) -> None:
        settings = make_settings()
        assistant_client = Mock()
        assistant_client.send_event = AsyncMock()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=assistant_client,
                metrics=Mock(),
            )
        session.persisted_segment_count = 1
        session.last_persisted_segment_at = datetime.now(timezone.utc)

        with patch("app.session_manager.TRANSCRIPT_SETTLE_IDLE_SECONDS", 5.0), patch(
            "app.session_manager.TRANSCRIPT_SETTLE_MAX_SECONDS", 0.01
        ), patch("app.session_manager.TRANSCRIPT_SETTLE_POLL_SECONDS", 0.005):
            metadata = await session._wait_for_transcript_settle()

        self.assertFalse(metadata["transcriptSettleComplete"])
        self.assertLess(metadata["transcriptSettleWaitSeconds"], 0.2)

    async def test_stop_finalization_includes_transcript_settle_metadata(self) -> None:
        settings = make_settings()
        assistant_client = Mock()
        assistant_client.send_event = AsyncMock()
        metrics = Mock()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=assistant_client,
                metrics=metrics,
            )
        session.persisted_segment_count = 3
        session.last_persisted_segment_at = datetime.now(timezone.utc)

        with patch.object(session.room, "disconnect", new=AsyncMock()), patch(
            "app.session_manager.TRANSCRIPT_SETTLE_IDLE_SECONDS", 0.01
        ), patch("app.session_manager.TRANSCRIPT_SETTLE_MAX_SECONDS", 0.2), patch(
            "app.session_manager.TRANSCRIPT_SETTLE_POLL_SECONDS", 0.005
        ):
            finalized = await session.stop(finalize=True, drain=True)

        self.assertTrue(finalized)
        assistant_client.send_event.assert_awaited_once()
        payload = assistant_client.send_event.await_args.args[0]
        self.assertEqual(payload["type"], "final_transcript")
        self.assertEqual(payload["metadata"]["segmentCount"], 3)
        self.assertTrue(payload["metadata"]["transcriptSettleComplete"])
        self.assertEqual(payload["metadata"]["segmentCountBeforeSettle"], 3)
        self.assertEqual(payload["metadata"]["segmentCountAfterSettle"], 3)


class SttGateWiringTests(unittest.IsolatedAsyncioTestCase):
    def _make_session(self, gate_mode: str) -> MeetingSession:
        settings = replace(make_settings(), stt_gate_mode=gate_mode)
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            return MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=Mock(),
                metrics=Mock(),
            )

    def _make_participant_session(
        self, session: MeetingSession
    ) -> ParticipantTranscriptionSession:
        participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
            name="Personbu",
            track_publications={},
        )
        return ParticipantTranscriptionSession(
            meeting_session=session,
            participant=participant,
            stt=Mock(),
        )

    async def _drive_consumer(self, participant_session, session) -> None:
        """Run _consume_track far enough to see which STT path it selects."""

        empty_stream = SimpleNamespace(
            __aiter__=lambda self_: self_,
            __anext__=AsyncMock(side_effect=StopAsyncIteration),
            aclose=AsyncMock(),
        )
        await participant_session._consume_track(Mock(), empty_stream)

    async def test_gate_is_bypassed_when_disabled(self) -> None:
        session = self._make_session("off")
        participant_session = self._make_participant_session(session)

        with patch("app.session_manager.gated_stt_stream") as gated, patch(
            "app.session_manager._ungated_stt_stream"
        ) as ungated:
            ungated.return_value = _empty_async_iter()
            await self._drive_consumer(participant_session, session)

        gated.assert_not_called()
        ungated.assert_called_once()

    async def test_gate_wraps_stt_when_enabled(self) -> None:
        session = self._make_session("on")
        participant_session = self._make_participant_session(session)

        with patch("app.session_manager.gated_stt_stream") as gated:
            gated.return_value = _empty_async_iter()
            await self._drive_consumer(participant_session, session)

        gated.assert_called_once()
        kwargs = gated.call_args.kwargs
        # The gate must stay bound to this participant's own STT and the
        # process-wide admission budget; speaker attribution rides on the
        # per-track subscription, not on anything the gate does.
        self.assertIs(kwargs["stt"], participant_session.stt)
        self.assertIs(kwargs["admission"], session.admission)
        self.assertEqual(kwargs["settings"].mode, "on")
        self.assertIn("550e8400-e29b-41d4-a716-446655440000:browser", kwargs["label"])

    async def test_unrecoverable_stt_error_marks_session_for_recovery(self) -> None:
        session = self._make_session("off")
        participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
            name="Personbu",
        )
        participant_session = ParticipantTranscriptionSession(
            meeting_session=session,
            participant=participant,
        )
        handlers: list = []
        stt = Mock()
        stt.on.side_effect = lambda event, handler: handlers.append((event, handler))
        participant_session._attach_stt_error_handler(stt)

        self.assertEqual(handlers[0][0], "error")
        handler = handlers[0][1]

        handler(SimpleNamespace(recoverable=True, error=RuntimeError("blip")))
        self.assertIsNone(participant_session.stt_failed_at)
        self.assertFalse(participant_session.needs_stt_recovery())

        handler(SimpleNamespace(recoverable=False, error=RuntimeError("dead")))
        self.assertIsNotNone(participant_session.stt_failed_at)
        # Still inside the grace window, so the gate gets a chance to heal.
        self.assertFalse(participant_session.needs_stt_recovery())
        self.assertTrue(
            participant_session.needs_stt_recovery(
                now=_utc_now()
                + timedelta(seconds=session_manager.STT_RECOVERY_GRACE_SECONDS + 1)
            )
        )

        participant_session.note_stt_recovered()
        self.assertIsNone(participant_session.stt_failed_at)

    async def test_repeated_unrecoverable_errors_preserve_first_failure_time(self) -> None:
        session = self._make_session("off")
        participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
            name="Personbu",
        )
        participant_session = ParticipantTranscriptionSession(
            meeting_session=session,
            participant=participant,
        )
        handlers: list = []
        stt = Mock()
        stt.on.side_effect = lambda event, handler: handlers.append((event, handler))
        participant_session._attach_stt_error_handler(stt)
        handler = handlers[0][1]

        # First failure happened just under the grace window ago.
        first_failure = _utc_now() - timedelta(
            seconds=session_manager.STT_RECOVERY_GRACE_SECONDS - 1
        )
        handler(SimpleNamespace(recoverable=False, error=RuntimeError("dead")))
        participant_session.stt_failed_at = first_failure

        # A participant that keeps erroring must not keep resetting the clock:
        # otherwise the grace window never elapses and reconcile is postponed
        # forever — the exact silent-death this machinery exists to catch.
        handler(SimpleNamespace(recoverable=False, error=RuntimeError("still dead")))
        self.assertEqual(participant_session.stt_failed_at, first_failure)
        self.assertTrue(
            participant_session.needs_stt_recovery(
                now=first_failure
                + timedelta(seconds=session_manager.STT_RECOVERY_GRACE_SECONDS)
            )
        )

    async def test_gate_level_stream_errors_mark_session_for_recovery(self) -> None:
        session = self._make_session("on")
        participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
            name="Personbu",
        )
        participant_session = ParticipantTranscriptionSession(
            meeting_session=session,
            participant=participant,
        )
        observer = session_manager._ParticipantGateObserver(
            delegate=session_manager.SttGateObserver(),
            participant_session=participant_session,
        )

        # Gate-level failures (stt.stream() raising, push failures, EOF
        # loops, a dead VAD) never route through the SDK error event. If they
        # do not mark the session, a gate that can no longer reopen gives the
        # reconcile loop no signal at all.
        observer.on_stream_error(reason="open_failed")
        self.assertIsNotNone(participant_session.stt_failed_at)

        # And a healthy stream clears it, as with SDK-reported failures.
        observer.on_stream_healthy()
        self.assertIsNone(participant_session.stt_failed_at)

    async def test_recovery_clears_on_real_stream_not_on_gate_decision(self) -> None:
        session = self._make_session("on")
        participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
            name="Personbu",
        )
        participant_session = ParticipantTranscriptionSession(
            meeting_session=session,
            participant=participant,
        )
        participant_session.stt_failed_at = _utc_now()

        observer = session_manager._ParticipantGateObserver(
            delegate=session_manager.SttGateObserver(),
            participant_session=participant_session,
        )

        # A gate decision only means the participant started speaking. It can
        # be followed by an admission denial and no stream at all, so it must
        # not be read as recovery.
        observer.on_open(shadow=False)
        self.assertIsNotNone(participant_session.stt_failed_at)

        # A stream *object* existing is not recovery either: the websocket
        # connects lazily, so a fast open/fail loop would otherwise clear the
        # flag every cycle and postpone the reconcile rebuild forever.
        observer.on_stream_opened()
        self.assertIsNotNone(participant_session.stt_failed_at)

        # Recovery is the provider actually answering.
        observer.on_stream_healthy()
        self.assertIsNone(participant_session.stt_failed_at)

    async def test_reconcile_restarts_a_dead_participant_transcriber(self) -> None:
        session = self._make_session("off")
        participant = Mock(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
        )
        session.room = SimpleNamespace(
            remote_participants={participant.identity: participant}
        )
        dead_session = Mock(
            needs_stt_recovery=Mock(return_value=True),
            stop=AsyncMock(return_value=None),
        )
        session.participant_sessions[participant.identity] = dead_session

        with patch.object(
            ParticipantTranscriptionSession,
            "start",
            new=AsyncMock(return_value=None),
        ) as start_mock:
            await session._reconcile_participant_sessions(reason="test")

        # The dead session is torn down and rebuilt rather than left in place
        # producing nothing for the rest of the meeting.
        dead_session.stop.assert_awaited_once()
        start_mock.assert_awaited_once()
        self.assertIn(participant.identity, session.participant_sessions)
        self.assertIsNot(session.participant_sessions[participant.identity], dead_session)


class SingleConnectionTests(unittest.IsolatedAsyncioTestCase):
    """The point of the change: one backend connection, not one per person."""

    async def test_participants_share_one_room_connection(self) -> None:
        settings = make_settings()
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            session = MeetingSession(
                request=make_start_request(),
                settings=settings,
                assistant_client=Mock(),
                metrics=Mock(),
            )

        participants = [
            SimpleNamespace(
                identity=f"550e8400-e29b-41d4-a716-44665544000{index}:browser",
                name=f"Person {index}",
                attributes={"userId": f"550e8400-e29b-41d4-a716-44665544000{index}"},
                metadata="",
                track_publications={},
            )
            for index in range(4)
        ]

        with patch.object(
            ParticipantTranscriptionSession, "start", new=AsyncMock(return_value=None)
        ):
            for participant in participants:
                await session._start_participant_session(participant=participant)

        self.assertEqual(len(session.participant_sessions), 4)
        # Every participant is transcribed off the meeting's single existing
        # connection. Previously each one opened its own hidden room, so a
        # four-person meeting cost 2N+2 = 10 LiveKit participants; it is now
        # N+2 = 6.
        for participant_session in session.participant_sessions.values():
            self.assertIs(participant_session.meeting_session.room, session.room)
            self.assertFalse(hasattr(participant_session, "room"))

    async def test_start_never_opens_an_observer_with_stale_stream_env(self) -> None:
        room = Mock()
        room.on.side_effect = lambda _event: lambda handler: handler
        room.remote_participants = {}
        room.connect = AsyncMock()
        room.disconnect = AsyncMock()
        with patch("app.config._load_env"), patch.dict(
            os.environ,
            {
                "LIVEKIT_REALTIME_TRANSCRIPT_SOURCE": "stream",
                "LIVEKIT_REALTIME_SERVICE_SECRET": "test-secret",
                "ASSISTANT_SERVICE_SECRET": "assistant-secret",
                "ELEVEN_API_KEY": "test-eleven-key",
            },
            clear=True,
        ), patch("app.session_manager.rtc.Room", return_value=room) as room_factory, patch(
            "app.session_manager.silero.VAD.load", return_value=object()
        ), patch("app.session_manager.asyncio.to_thread", new=AsyncMock()):
            session = MeetingSession(
                request=make_start_request(),
                settings=load_settings(),
                assistant_client=Mock(),
                metrics=Mock(),
            )
            with patch.object(
                session,
                "spawn_background_task",
                side_effect=lambda coro, **_kwargs: coro.close(),
            ):
                await session.start()
            await session.stop(finalize=False, drain=False)

        room_factory.assert_called_once_with()
        room.connect.assert_awaited_once()
        self.assertEqual(room.connect.await_args.args[1], session.request.token)
        room.register_text_stream_handler.assert_not_called()
        room.disconnect.assert_awaited_once()
        self.assertFalse(hasattr(session, "transcript_stream_room"))
        self.assertFalse(hasattr(session, "create_transcript_stream_observer_token"))

    async def test_no_per_participant_token_minting_remains(self) -> None:
        # The per-participant transcriber tokens existed only to open those
        # extra connections. Their absence is the invariant.
        self.assertFalse(
            hasattr(MeetingSession, "create_participant_transcriber_token")
        )
        self.assertFalse(hasattr(session_manager, "LiveTranscriptAgent"))


class ParticipantTrackLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def _make_participant_session(self) -> ParticipantTranscriptionSession:
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            meeting_session = MeetingSession(
                request=make_start_request(),
                settings=make_settings(),
                assistant_client=Mock(),
                metrics=Mock(),
            )
        return ParticipantTranscriptionSession(
            meeting_session=meeting_session,
            participant=SimpleNamespace(
                identity="550e8400-e29b-41d4-a716-446655440000:browser",
                name="Personbu",
                attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
                metadata="",
                track_publications={},
            ),
            stt=Mock(),
        )

    async def test_a_failed_transcript_save_does_not_stop_later_lines(self) -> None:
        participant = self._make_participant_session()
        saved_lines: list[str] = []

        async def send_event(payload: dict[str, Any]) -> None:
            content = payload["segment"]["content"]
            if not saved_lines and content == "first sentence":
                saved_lines.append("(failed)")
                raise RuntimeError("Assistant callback failed after retries")
            saved_lines.append(content)

        participant.meeting_session.assistant_client.send_event = send_event

        async def speech_events() -> Any:
            for text in ("first sentence", "second sentence", "third sentence"):
                yield SimpleNamespace(
                    type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                    alternatives=[SimpleNamespace(text=text)],
                )

        with patch(
            "app.session_manager._ungated_stt_stream", return_value=speech_events()
        ), patch.object(
            participant._caption_publisher,
            "_publish_caption",
            new=AsyncMock(return_value="success"),
        ), self.assertLogs("readymeet.livekit_realtime.sessions", level="ERROR"):
            await participant._consume_track(SimpleNamespace(sid="TR"), object())
            await flush_captions(participant)

        self.assertEqual(saved_lines, ["(failed)", "second sentence", "third sentence"])
        self.assertIsNone(participant.stt_failed_at)
        self.assertEqual(participant.meeting_session.persisted_segment_count, 2)

    async def test_failed_track_release_still_closes_caption_worker(self) -> None:
        participant = self._make_participant_session()
        participant.release_track = AsyncMock(side_effect=RuntimeError("release failed"))
        publisher = participant._caption_publisher
        publisher._publish_caption = AsyncMock(return_value="success")
        publisher.enqueue("caption", is_final=True, track_sid=None)
        worker = publisher.worker_task
        with self.assertRaisesRegex(RuntimeError, "release failed"):
            await participant.stop()
        self.assertTrue(worker.done())
        self.assertIsNone(publisher.worker_task)

    async def test_cancelled_disconnect_finishes_track_and_caption_cleanup(self) -> None:
        participant = self._make_participant_session()
        entered, release = asyncio.Event(), asyncio.Event()
        async def close_audio():
            entered.set()
            await release.wait()
        participant._track = object()
        participant._audio_stream = SimpleNamespace(aclose=close_audio)
        consumer = asyncio.create_task(asyncio.Event().wait())
        participant._consumer = consumer
        publisher = participant._caption_publisher
        publisher._publish_caption = AsyncMock(return_value="success")
        publisher.enqueue("last caption", is_final=True, track_sid=None)
        worker = publisher.worker_task
        with patch("app.session_manager.PARTICIPANT_TRACK_DRAIN_TIMEOUT_SECONDS", 0.02):
            stopping = asyncio.create_task(participant.stop())
            await entered.wait()
            stopping.cancel()
            await asyncio.sleep(0)
            stopping.cancel()
            second_stop = asyncio.create_task(participant.stop())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(stopping, 0.5)
            await asyncio.wait_for(second_stop, 0.5)
        self.assertTrue(consumer.done())
        self.assertTrue(worker.done())
        self.assertIsNone(publisher.worker_task)

    async def test_cancelled_track_replacement_closes_unadopted_stream(self) -> None:
        participant = self._make_participant_session()
        entered, release = asyncio.Event(), asyncio.Event()
        async def close_audio():
            entered.set()
        participant._track = object()
        participant._audio_stream = SimpleNamespace(aclose=close_audio)
        consumer = asyncio.create_task(release.wait())
        participant._consumer = consumer
        replacement = SimpleNamespace(aclose=AsyncMock())
        with patch("app.session_manager.rtc.AudioStream.from_track", return_value=replacement):
            swapping = asyncio.create_task(participant.use_track(object()))
            await entered.wait()
            swapping.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(swapping, 0.5)
        replacement.aclose.assert_awaited_once()
        self.assertTrue(consumer.done())
        self.assertIsNone(participant._audio_stream)
        await participant.stop(drain=False)

    async def test_cancelled_track_release_joins_old_consumer_before_replacement(self) -> None:
        participant = self._make_participant_session()
        old_track, replacement = object(), object()
        entered, release = asyncio.Event(), asyncio.Event()
        async def close_audio():
            entered.set()
            await release.wait()
        participant._track = old_track
        participant._audio_stream = SimpleNamespace(aclose=close_audio)
        consumer = asyncio.create_task(asyncio.Event().wait())
        participant._consumer = consumer
        with patch("app.session_manager.PARTICIPANT_TRACK_DRAIN_TIMEOUT_SECONDS", 0.02):
            releasing = asyncio.create_task(participant.release_track(track=old_track))
            await entered.wait()
            releasing.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(releasing, 0.5)
        self.assertTrue(consumer.done())
        participant._track = replacement
        self.assertFalse(await participant.release_track(track=old_track))
        self.assertIs(participant._track, replacement)
        await participant.stop(drain=False)

    async def test_room_close_joins_a_disconnecting_participant_worker(self) -> None:
        participant = self._make_participant_session()
        meeting = participant.meeting_session
        meeting.room.disconnect = AsyncMock()
        meeting.close_http_session = AsyncMock()
        meeting.participant_sessions[participant.speaker_identity] = participant
        started = asyncio.Event()
        async def release_track(**kwargs):
            started.set()
            await asyncio.sleep(0.04)
        participant.release_track = release_track
        publisher = participant._caption_publisher
        publisher._publish_caption = AsyncMock(return_value="success")
        publisher.enqueue("last caption", is_final=True, track_sid=None)
        worker = publisher.worker_task
        disconnect = meeting.spawn_background_task(
            meeting._stop_participant_session(participant=participant.participant), label="disconnect-test")
        await started.wait()
        self.assertFalse(meeting.participant_sessions)  # Removed before room teardown.
        with patch("app.session_manager.BACKGROUND_TASK_DRAIN_TIMEOUT_SECONDS", 0.001):
            await asyncio.wait_for(meeting.stop(finalize=False, drain=True), 0.5)
        self.assertTrue(disconnect.done())
        self.assertTrue(worker.done())
        self.assertIsNone(publisher.worker_task)
        meeting.room.disconnect.assert_awaited_once()
        meeting.close_http_session.assert_awaited_once()

    async def test_graceful_release_closes_audio_and_awaits_consumer(self) -> None:
        participant_session = self._make_participant_session()
        track = object()
        audio_closed = asyncio.Event()
        consumer_drained = asyncio.Event()
        audio_stream = Mock()
        audio_stream.aclose = AsyncMock(side_effect=lambda: audio_closed.set())

        async def consumer() -> None:
            await audio_closed.wait()
            consumer_drained.set()

        consumer_task = asyncio.create_task(consumer())
        participant_session._track = track
        participant_session._audio_stream = audio_stream
        participant_session._consumer = consumer_task

        released = await participant_session.release_track(track=track, drain=True)

        self.assertTrue(released)
        audio_stream.aclose.assert_awaited_once()
        self.assertTrue(consumer_drained.is_set())
        self.assertTrue(consumer_task.done())
        self.assertFalse(consumer_task.cancelled())

    async def test_graceful_release_persists_trailing_final_transcript(self) -> None:
        participant_session = self._make_participant_session()
        participant_session.meeting_session.assistant_client.send_event = AsyncMock()
        participant_session._audio_processing = Mock()
        track = object()
        audio_closed = asyncio.Event()
        stt_input_ended = asyncio.Event()

        class ClosingAudioStream:
            def __aiter__(self):
                return self

            async def __anext__(self):
                await audio_closed.wait()
                raise StopAsyncIteration

            async def aclose(self) -> None:
                audio_closed.set()

        class FinalizingSttStream:
            def __init__(self) -> None:
                self.emitted = False

            def push_frame(self, frame) -> None:
                return None

            def end_input(self) -> None:
                stt_input_ended.set()

            def __aiter__(self):
                return self

            async def __anext__(self):
                await stt_input_ended.wait()
                if self.emitted:
                    raise StopAsyncIteration
                self.emitted = True
                return SimpleNamespace(
                    type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                    alternatives=[SimpleNamespace(text="The final words.")],
                )

            async def aclose(self) -> None:
                return None

        stt_stream = FinalizingSttStream()
        participant_session.stt = SimpleNamespace(stream=lambda: stt_stream)
        audio_stream = ClosingAudioStream()
        consumer_task = asyncio.create_task(
            participant_session._consume_track(track, audio_stream)
        )
        participant_session._track = track
        participant_session._audio_stream = audio_stream
        participant_session._consumer = consumer_task

        await participant_session.release_track(track=track, drain=True)

        send_event = participant_session.meeting_session.assistant_client.send_event
        send_event.assert_awaited_once()
        self.assertEqual(
            send_event.await_args.args[0]["segment"]["content"],
            "The final words.",
        )

    async def test_immediate_release_cancels_consumer(self) -> None:
        participant_session = self._make_participant_session()
        track = object()
        audio_stream = Mock()
        audio_stream.aclose = AsyncMock()

        async def consumer() -> None:
            await asyncio.Event().wait()

        consumer_task = asyncio.create_task(consumer())
        await asyncio.sleep(0)
        participant_session._track = track
        participant_session._audio_stream = audio_stream
        participant_session._consumer = consumer_task

        released = await participant_session.release_track(track=track, drain=False)

        self.assertTrue(released)
        self.assertTrue(consumer_task.cancelled())
        audio_stream.aclose.assert_awaited_once()

    async def test_graceful_release_times_out_and_cancels_wedged_consumer(self) -> None:
        participant_session = self._make_participant_session()
        track = object()
        audio_stream = Mock()
        audio_stream.aclose = AsyncMock()

        async def consumer() -> None:
            await asyncio.Event().wait()

        consumer_task = asyncio.create_task(consumer())
        await asyncio.sleep(0)
        participant_session._track = track
        participant_session._audio_stream = audio_stream
        participant_session._consumer = consumer_task

        with patch(
            "app.session_manager.PARTICIPANT_TRACK_DRAIN_TIMEOUT_SECONDS",
            0.001,
        ):
            released = await participant_session.release_track(
                track=track,
                drain=True,
            )

        self.assertTrue(released)
        self.assertTrue(consumer_task.cancelled())

    async def test_draining_old_track_keeps_its_own_track_sid(self) -> None:
        participant_session = self._make_participant_session()
        participant_session.meeting_session.assistant_client.send_event = AsyncMock()
        old_track = SimpleNamespace(sid="TR_old")
        participant_session.participant.track_publications = {
            "TR_new": SimpleNamespace(
                source=rtc.TrackSource.SOURCE_MICROPHONE,
                sid="TR_new",
            )
        }
        audio_stream = Mock()

        async def speech_events():
            yield SimpleNamespace(
                type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                alternatives=[SimpleNamespace(text="final from old track")],
            )

        with patch(
            "app.session_manager._ungated_stt_stream",
            return_value=speech_events(),
        ), patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(return_value="success"),
        ) as publish_caption:
            await participant_session._consume_track(old_track, audio_stream)
            await flush_captions(participant_session)

        publish_caption.assert_awaited_once_with(
            "final from old track",
            is_final=True,
            track_sid="TR_old",
            segment_id=ANY,
        )
        payload = (
            participant_session.meeting_session.assistant_client.send_event
            .await_args.args[0]
        )
        self.assertEqual(payload["segment"]["trackSid"], "TR_old")

    async def test_stale_unsubscribe_cannot_release_replacement_track(self) -> None:
        participant_session = self._make_participant_session()
        old_track = object()
        replacement_track = object()
        replacement_stream = Mock()
        replacement_stream.aclose = AsyncMock()

        async def consumer() -> None:
            await asyncio.Event().wait()

        replacement_consumer = asyncio.create_task(consumer())
        await asyncio.sleep(0)
        participant_session._track = replacement_track
        participant_session._audio_stream = replacement_stream
        participant_session._consumer = replacement_consumer

        released = await participant_session.release_track(
            track=old_track,
            drain=True,
        )

        self.assertFalse(released)
        self.assertIs(participant_session._track, replacement_track)
        self.assertIs(participant_session._consumer, replacement_consumer)
        replacement_stream.aclose.assert_not_awaited()

        replacement_consumer.cancel()
        await asyncio.gather(replacement_consumer, return_exceptions=True)

    async def test_audio_frames_apply_gain_control_and_append_flush_silence(self) -> None:
        participant_session = self._make_participant_session()
        participant_session._audio_processing = Mock()
        input_frame = Mock()
        flush_frame = object()

        async def audio_stream():
            yield SimpleNamespace(frame=input_frame)

        with patch("app.session_manager.rtc.AudioFrame", return_value=flush_frame) as frame:
            frames = [
                item
                async for item in participant_session._processed_audio_frames(
                    audio_stream()
                )
            ]

        participant_session._audio_processing.process_stream.assert_called_once_with(
            input_frame
        )
        self.assertEqual(frames, [input_frame, flush_frame])
        frame.assert_called_once_with(
            b"\x00\x00" * 12_000,
            sample_rate=session_manager.TRANSCRIBER_SAMPLE_RATE,
            num_channels=session_manager.TRANSCRIBER_NUM_CHANNELS,
            samples_per_channel=12_000,
        )


class CaptionPublishOffHotPathTests(unittest.IsolatedAsyncioTestCase):
    """Captions must not sit on the STT consumption path, and must stay ordered."""

    def _make_session(self) -> ParticipantTranscriptionSession:
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            meeting_session = MeetingSession(
                request=make_start_request(),
                settings=make_settings(),
                assistant_client=Mock(),
                metrics=Mock(),
            )
        return ParticipantTranscriptionSession(
            meeting_session=meeting_session,
            participant=SimpleNamespace(
                identity="550e8400-e29b-41d4-a716-446655440000:browser",
                name="Personbu",
                attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
                metadata="",
                track_publications={},
            ),
            stt=Mock(),
        )

    async def test_a_stalled_publish_does_not_block_event_handling(self) -> None:
        participant_session = self._make_session()
        release = asyncio.Event()

        async def hanging_publish(*args: Any, **kwargs: Any) -> None:
            await release.wait()

        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(side_effect=hanging_publish),
        ):
            # A slow room connection must not stall consumption of the next STT
            # event behind a stream_text handshake.
            for index in range(5):
                await asyncio.wait_for(
                    participant_session._handle_speech_event(
                        SimpleNamespace(
                            type=stt_api.SpeechEventType.INTERIM_TRANSCRIPT,
                            alternatives=[SimpleNamespace(text=f"chunk {index}")],
                        )
                    ),
                    timeout=0.5,
                )
            release.set()
            await flush_captions(participant_session)

    async def test_finals_persist_while_caption_publication_is_stalled(self) -> None:
        participant_session = self._make_session()
        assistant_client = participant_session.meeting_session.assistant_client
        assistant_client.send_event = AsyncMock()
        started, release = asyncio.Event(), asyncio.Event()

        async def stalled_publish(*args: Any, **kwargs: Any) -> str:
            started.set()
            await release.wait()
            return "success"

        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(side_effect=stalled_publish),
        ):
            try:
                for index in range(2):
                    await asyncio.wait_for(
                        participant_session._handle_speech_event(
                            SimpleNamespace(
                                type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                                alternatives=[SimpleNamespace(text=f"Final {index}")],
                            )
                        ),
                        timeout=0.5,
                    )
                    await asyncio.wait_for(started.wait(), timeout=0.5)
                self.assertFalse(release.is_set())
                self.assertEqual(assistant_client.send_event.await_count, 2)
                self.assertEqual(participant_session.meeting_session.persisted_segment_count, 2)
                self.assertNotIn("trackSid", assistant_client.send_event.await_args.args[0]["segment"])
            finally:
                release.set()
                await flush_captions(participant_session)

    async def test_finals_persist_despite_caption_failures(self) -> None:
        for failure in ("disconnected", "open", "write", "close", "timeout"):
            with self.subTest(failure=failure):
                participant_session = self._make_session()
                session = participant_session.meeting_session
                session.assistant_client.send_event = AsyncMock()
                writer = SimpleNamespace(write=AsyncMock(), aclose=AsyncMock())
                stream_text = AsyncMock(return_value=writer)
                session.room = SimpleNamespace(
                    isconnected=lambda: failure != "disconnected",
                    local_participant=SimpleNamespace(stream_text=stream_text),
                )
                if failure == "open":
                    stream_text.side_effect = RuntimeError("stream rejected")
                elif failure == "write":
                    writer.write.side_effect = RuntimeError("chunk rejected")
                elif failure == "close":
                    writer.aclose.side_effect = RuntimeError("trailer rejected")
                elif failure == "timeout":
                    async def hanging_write(_text: str) -> None:
                        await asyncio.Event().wait()
                    writer.write.side_effect = hanging_write

                with patch("app.caption_publisher.CAPTION_PUBLISH_TIMEOUT_SECONDS", 0.01):
                    await participant_session._handle_speech_event(
                        SimpleNamespace(
                            type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                            alternatives=[SimpleNamespace(text="Keep these words.")],
                        ),
                        track_sid="TR_microphone",
                    )
                    await flush_captions(participant_session)

                session.assistant_client.send_event.assert_awaited_once()
                payload = session.assistant_client.send_event.await_args.args[0]
                self.assertEqual(payload["segment"]["content"], "Keep these words.")
                self.assertEqual(payload["segment"]["trackSid"], "TR_microphone")
                self.assertEqual(payload["segment"]["speakerIdentity"], participant_session.speaker_identity)
                self.assertEqual(session.persisted_segment_count, 1)
                outcome = {
                    "open": "error", "write": "error", "close": "close_failed",
                }.get(failure, failure)
                session.metrics.record_caption_publish.assert_called_once_with(outcome=outcome)
                if failure in {"write", "close", "timeout"}:
                    writer.aclose.assert_awaited_once()

    async def test_callback_failure_is_logged_without_blocking_captions(self) -> None:
        participant_session = self._make_session()
        session = participant_session.meeting_session
        session.assistant_client.send_event = AsyncMock(side_effect=RuntimeError("callback rejected"))
        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(return_value="success"),
        ) as publish_caption:
            with self.assertLogs("readymeet.livekit_realtime.sessions", level="ERROR") as logs:
                await participant_session._handle_speech_event(
                    SimpleNamespace(
                        type=stt_api.SpeechEventType.FINAL_TRANSCRIPT,
                        alternatives=[SimpleNamespace(text="Still caption this.")],
                    )
                )
            await flush_captions(participant_session)

        publish_caption.assert_awaited_once()
        self.assertEqual(session.persisted_segment_count, 0)
        self.assertIsNone(session.last_persisted_segment_at)
        record = logs.records[0]
        self.assertEqual(record.meetingId, session.request.meetingId)
        self.assertEqual(record.participantIdentity, participant_session.speaker_identity)

    async def test_direct_persistence_normalizes_and_filters_suppressed_content(self) -> None:
        participant_session = self._make_session()
        session = participant_session.meeting_session
        session.assistant_client.send_event = AsyncMock()
        for text in ("", "...", "[Speaker: Personbu]   "):
            await participant_session.persist_final_transcript_text(text)
        session.assistant_client.send_event.assert_not_awaited()

        await participant_session.persist_final_transcript_text(" [Speaker: Personbu] Hello   world. ")
        payload = session.assistant_client.send_event.await_args.args[0]
        self.assertEqual(payload["segment"]["content"], "Hello world.")
        session.suppressed_speaker_identities.add(participant_session.speaker_identity)
        await participant_session.persist_final_transcript_text("Do not save this.")
        session.assistant_client.send_event.assert_awaited_once()
        self.assertEqual(session.persisted_segment_count, 1)

    async def test_captions_publish_in_order(self) -> None:
        participant_session = self._make_session()
        published: List[tuple] = []

        async def record(
            text: str, *, is_final: bool, track_sid: Any, segment_id: str
        ) -> str:
            await asyncio.sleep(0)
            published.append((text, is_final))
            return "success"

        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(side_effect=record),
        ):
            publisher = participant_session._caption_publisher
            publisher.enqueue("one", is_final=True, track_sid=None)
            publisher.enqueue("two", is_final=True, track_sid=None)
            publisher.enqueue("three", is_final=True, track_sid=None)
            await flush_captions(participant_session)

        # Independent spawns would let a later final overtake an earlier one and
        # leave the UI showing stale text.
        self.assertEqual(published, [("one", True), ("two", True), ("three", True)])

    async def test_trailing_interims_coalesce_but_finals_never_drop(self) -> None:
        participant_session = self._make_session()
        published: List[tuple] = []

        async def record(
            text: str, *, is_final: bool, track_sid: Any, segment_id: str
        ) -> str:
            await asyncio.sleep(0)
            published.append((text, is_final))
            return "success"

        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(side_effect=record),
        ):
            # Queue faster than the worker drains: only the newest interim is
            # worth publishing, but every final must survive.
            publisher = participant_session._caption_publisher
            publisher.enqueue("i1", is_final=False, track_sid=None)
            publisher.enqueue("i2", is_final=False, track_sid=None)
            publisher.enqueue("i3", is_final=False, track_sid=None)
            publisher.enqueue("FINAL-A", is_final=True, track_sid=None)
            publisher.enqueue("i4", is_final=False, track_sid=None)
            publisher.enqueue("FINAL-B", is_final=True, track_sid=None)
            await flush_captions(participant_session)

        finals = [text for text, is_final in published if is_final]
        self.assertEqual(finals, ["FINAL-A", "FINAL-B"])
        self.assertNotIn("i1", [text for text, _ in published])
        self.assertNotIn("i2", [text for text, _ in published])
        self.assertEqual(
            participant_session.meeting_session.metrics
            .record_caption_interim_coalesced.call_count,
            2,
        )
        participant_session.meeting_session.metrics.record_caption_pending_finals.assert_has_calls(
            [call(1), call(2)]
        )

    async def test_stop_flushes_queued_captions(self) -> None:
        participant_session = self._make_session()
        published: List[str] = []

        async def record(
            text: str, *, is_final: bool, track_sid: Any, segment_id: str
        ) -> str:
            published.append(text)
            return "success"

        with patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(side_effect=record),
        ):
            participant_session._caption_publisher.enqueue(
                "last words", is_final=True, track_sid=None
            )
            await participant_session.stop(drain=True)

        # The meeting's final caption must still reach the room, and the worker
        # must not outlive the session.
        self.assertEqual(published, ["last words"])
        self.assertIsNone(participant_session._caption_publisher.worker_task)
        self.assertEqual(participant_session._caption_publisher.pending_count, 0)


    async def test_timed_out_writer_closes_and_next_final_publishes(self) -> None:
        participant_session = self._make_session()
        participant_session.meeting_session.room = SimpleNamespace(
            isconnected=lambda: True,
        )
        first_write_started = asyncio.Event()

        async def hanging_write(_text: str) -> None:
            first_write_started.set()
            await asyncio.Event().wait()

        first_writer = SimpleNamespace(
            write=AsyncMock(side_effect=hanging_write),
            aclose=AsyncMock(),
        )
        second_writer = SimpleNamespace(
            write=AsyncMock(),
            aclose=AsyncMock(),
        )
        participant_session.meeting_session.room.local_participant = SimpleNamespace(
            stream_text=AsyncMock(side_effect=[first_writer, second_writer])
        )

        with patch(
            "app.caption_publisher.CAPTION_PUBLISH_TIMEOUT_SECONDS",
            0.01,
        ):
            participant_session._caption_publisher.enqueue(
                "first",
                is_final=True,
                track_sid="TR_microphone",
            )
            participant_session._caption_publisher.enqueue(
                "second",
                is_final=True,
                track_sid="TR_microphone",
            )
            await first_write_started.wait()
            await flush_captions(participant_session)

        participant_session.meeting_session.metrics.record_caption_publish.assert_has_calls(
            [call(outcome="timeout"), call(outcome="success")]
        )
        first_writer.aclose.assert_awaited_once()
        second_writer.write.assert_awaited_once_with("second")
        second_writer.aclose.assert_awaited_once()

        await participant_session.stop(drain=False)

    async def test_stop_without_drain_cancels_caption_worker_immediately(self) -> None:
        participant_session = self._make_session()
        publish_started = asyncio.Event()
        publish_cancelled = asyncio.Event()

        async def hanging_publish(*args: Any, **kwargs: Any) -> bool:
            publish_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                publish_cancelled.set()
            return True

        with patch(
            "app.caption_publisher.CAPTION_PUBLISH_TIMEOUT_SECONDS",
            60.0,
        ), patch.object(
            participant_session._caption_publisher,
            "_publish_caption",
            new=AsyncMock(side_effect=hanging_publish),
        ):
            participant_session._caption_publisher.enqueue(
                "do not drain", is_final=True, track_sid=None
            )
            await publish_started.wait()
            await asyncio.wait_for(
                participant_session.stop(drain=False),
                timeout=0.1,
            )

        self.assertTrue(publish_cancelled.is_set())
        self.assertIsNone(participant_session._caption_publisher.worker_task)
        self.assertEqual(participant_session._caption_publisher.pending_count, 0)


class SelectiveMicrophoneSubscriptionTests(unittest.IsolatedAsyncioTestCase):
    def _make_session(self) -> MeetingSession:
        with patch("app.session_manager.silero.VAD.load", return_value=object()):
            return MeetingSession(
                request=make_start_request(),
                settings=make_settings(),
                assistant_client=Mock(),
                metrics=Mock(),
            )

    def _human_participant(self, *, publications=None):
        return SimpleNamespace(
            identity="550e8400-e29b-41d4-a716-446655440000:browser",
            name="Personbu",
            attributes={"userId": "550e8400-e29b-41d4-a716-446655440000"},
            metadata="",
            track_publications=publications or {},
        )

    async def test_main_room_connect_disables_automatic_track_subscription(self) -> None:
        session = self._make_session()

        def discard_background_task(coro, **_kwargs):
            coro.close()
            return Mock()

        with patch.object(
            session.room, "connect", new=AsyncMock()
        ) as connect, patch.object(
            type(session.room),
            "remote_participants",
            new_callable=lambda: property(lambda _room: {}),
        ), patch.object(
            session,
            "spawn_background_task",
            new=Mock(side_effect=discard_background_task),
        ), patch(
            "app.session_manager.asyncio.to_thread", new=AsyncMock()
        ):
            await session.start()

        connect_options = connect.await_args.args[2]
        self.assertFalse(connect_options.auto_subscribe)

    def test_only_human_microphone_publications_are_subscribed(self) -> None:
        session = self._make_session()
        microphone = Mock(
            source=rtc.TrackSource.SOURCE_MICROPHONE,
            set_subscribed=Mock(),
        )
        camera = Mock(
            source=rtc.TrackSource.SOURCE_CAMERA,
            set_subscribed=Mock(),
        )
        screen_share = Mock(
            source=rtc.TrackSource.SOURCE_SCREENSHARE,
            set_subscribed=Mock(),
        )
        participant = self._human_participant()

        self.assertTrue(
            session._subscribe_to_microphone_publication(participant, microphone)
        )
        self.assertFalse(
            session._subscribe_to_microphone_publication(participant, camera)
        )
        self.assertFalse(
            session._subscribe_to_microphone_publication(participant, screen_share)
        )

        microphone.set_subscribed.assert_called_once_with(True)
        camera.set_subscribed.assert_not_called()
        screen_share.set_subscribed.assert_not_called()

    def test_assistant_microphone_is_not_subscribed(self) -> None:
        session = self._make_session()
        microphone = Mock(
            source=rtc.TrackSource.SOURCE_MICROPHONE,
            set_subscribed=Mock(),
        )
        participant = SimpleNamespace(
            identity="readymeet-assistant-123",
            attributes={"assistantRole": "meeting-assistant"},
            metadata="",
            track_publications={"TR_assistant": microphone},
        )

        subscribed = session._subscribe_to_existing_microphones(participant)

        self.assertEqual(subscribed, 0)
        microphone.set_subscribed.assert_not_called()

    def test_existing_human_and_sip_microphones_are_subscribed(self) -> None:
        session = self._make_session()
        human_microphone = Mock(
            source=rtc.TrackSource.SOURCE_MICROPHONE,
            set_subscribed=Mock(),
        )
        human_camera = Mock(
            source=rtc.TrackSource.SOURCE_CAMERA,
            set_subscribed=Mock(),
        )
        human = self._human_participant(
            publications={
                "TR_microphone": human_microphone,
                "TR_camera": human_camera,
            }
        )
        sip_microphone = Mock(
            source=rtc.TrackSource.SOURCE_MICROPHONE,
            set_subscribed=Mock(),
        )
        sip = SimpleNamespace(
            identity="sip_+15551234567_x7Kp",
            kind=rtc.ParticipantKind.PARTICIPANT_KIND_SIP,
            attributes={},
            metadata="",
            track_publications={"TR_phone": sip_microphone},
        )

        self.assertEqual(session._subscribe_to_existing_microphones(human), 1)
        self.assertEqual(session._subscribe_to_existing_microphones(sip), 1)
        human_microphone.set_subscribed.assert_called_once_with(True)
        human_camera.set_subscribed.assert_not_called()
        sip_microphone.set_subscribed.assert_called_once_with(True)

    async def test_session_exists_before_a_new_microphone_is_subscribed(self) -> None:
        session = self._make_session()
        participant = self._human_participant()
        order: list[str] = []
        microphone = Mock(source=rtc.TrackSource.SOURCE_MICROPHONE)
        microphone.set_subscribed = Mock(
            side_effect=lambda _value: order.append("subscribe")
        )

        async def start_session(**_kwargs) -> None:
            order.append("session")
            session.participant_sessions[participant.identity] = Mock()

        with patch.object(
            session,
            "_start_participant_session_safely",
            new=AsyncMock(side_effect=start_session),
        ):
            await session._start_participant_and_subscribe_publication(
                participant=participant,
                publication=microphone,
                reason="test",
            )

        self.assertEqual(order, ["session", "subscribe"])

    async def test_connected_and_published_events_wait_for_one_complete_start(
        self,
    ) -> None:
        session = self._make_session()
        callbacks = {}
        event_tasks = []

        class EventRoom:
            def __init__(self) -> None:
                self.remote_participants = {}
                self.connect = AsyncMock()

            def on(self, event_name):
                def register(callback):
                    callbacks[event_name] = callback
                    return callback

                return register

        session.room = EventRoom()
        participant = self._human_participant()
        microphone = Mock(
            source=rtc.TrackSource.SOURCE_MICROPHONE,
            set_subscribed=Mock(),
        )
        camera = Mock(
            source=rtc.TrackSource.SOURCE_CAMERA,
            set_subscribed=Mock(),
        )
        start_entered = asyncio.Event()
        allow_start_to_finish = asyncio.Event()
        start_calls = 0

        async def delayed_start(_participant_session) -> None:
            nonlocal start_calls
            start_calls += 1
            start_entered.set()
            await allow_start_to_finish.wait()

        def spawn_event_task(coro, *, label, **_kwargs):
            if label == "participant-session-reconcile":
                coro.close()
                return Mock()
            task = asyncio.create_task(coro)
            event_tasks.append(task)
            return task

        with patch.object(
            ParticipantTranscriptionSession,
            "start",
            new=delayed_start,
        ), patch.object(
            session,
            "spawn_background_task",
            side_effect=spawn_event_task,
        ), patch(
            "app.session_manager.asyncio.to_thread",
            new=AsyncMock(),
        ):
            await session.start()
            callbacks["participant_connected"](participant)
            await start_entered.wait()
            callbacks["track_published"](microphone, participant)
            callbacks["track_published"](camera, participant)
            await asyncio.sleep(0)

            # Even though the session is already visible in the mapping, the
            # microphone subscription must wait for its async start to finish.
            microphone.set_subscribed.assert_not_called()
            allow_start_to_finish.set()
            await asyncio.gather(*event_tasks)

        microphone.set_subscribed.assert_called_once_with(True)
        camera.set_subscribed.assert_not_called()
        self.assertEqual(start_calls, 1)

    async def test_failed_session_start_does_not_subscribe_microphone(self) -> None:
        session = self._make_session()
        participant = self._human_participant()
        microphone = Mock(
            source=rtc.TrackSource.SOURCE_MICROPHONE,
            set_subscribed=Mock(),
        )

        with patch.object(
            session,
            "_start_participant_session_safely",
            new=AsyncMock(),
        ):
            await session._start_participant_and_subscribe_publication(
                participant=participant,
                publication=microphone,
                reason="test",
            )

        microphone.set_subscribed.assert_not_called()

    def test_subscription_request_failure_is_counted(self) -> None:
        session = self._make_session()
        participant = self._human_participant()
        microphone = Mock(source=rtc.TrackSource.SOURCE_MICROPHONE)
        microphone.set_subscribed = Mock(side_effect=RuntimeError("subscribe failed"))

        subscribed = session._subscribe_to_microphone_publication(
            participant,
            microphone,
        )

        self.assertFalse(subscribed)
        session.metrics.record_track_subscription_failure.assert_called_once_with(
            reason="subscribe-request-failed"
        )


if __name__ == "__main__":
    unittest.main()
