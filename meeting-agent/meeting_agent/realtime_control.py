from __future__ import annotations

import httpx

from .env import Settings


class LiveKitRealtimeControlClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                settings.livekit_realtime_request_timeout_ms / 1000.0,
                connect=5.0,
            )
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def set_participant_transcription_suppressed(
        self, meeting_id: str, participant_identity: str, suppressed: bool
    ) -> dict:
        url = "%s/internal/meetings/%s/participant-transcription" % (
            self._settings.livekit_realtime_service_url,
            meeting_id,
        )
        response = await self._client.post(
            url,
            json={
                "participantIdentity": participant_identity,
                "suppressed": suppressed,
            },
            headers={
                "content-type": "application/json",
                "x-livekit-realtime-service-secret": self._settings.livekit_realtime_service_secret,
            },
        )

        if not response.is_success:
            raise RuntimeError(
                "LiveKit realtime participant transcription control failed (%s): %s"
                % (response.status_code, response.text)
            )

        return response.json()

