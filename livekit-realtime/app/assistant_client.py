from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

import httpx

from .config import Settings
from .metrics import RealtimeMetrics


LOGGER = logging.getLogger("readymeet.livekit_realtime.assistant_client")


class AssistantCallbackClient:
    def __init__(self, settings: Settings, metrics: RealtimeMetrics) -> None:
        self._settings = settings
        self._metrics = metrics
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.assistant_callback_timeout_seconds, connect=5.0)
        )
        LOGGER.info(
            "assistant callback client initialised",
            extra={"assistantCallbackUrl": self._settings.assistant_callback_url},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def send_event(self, payload: Dict[str, Any]) -> None:
        url = f"{self._settings.assistant_callback_url}/internal/livekit-realtime/events"
        last_error: Optional[Exception] = None
        event_type = str(payload.get("type", "unknown"))
        meeting_id = str(payload.get("meetingId", "unknown"))

        LOGGER.info(
            "sending assistant callback",
            extra={"url": url, "eventType": event_type, "meetingId": meeting_id},
        )
        for attempt in range(1, 4):
            try:
                response = await self._client.post(
                    url,
                    json=payload,
                    headers={
                        "content-type": "application/json",
                        "x-assistant-service-secret": self._settings.assistant_service_secret,
                    },
                )
                response.raise_for_status()
                self._metrics.record_assistant_callback(
                    event_type=event_type,
                    outcome="success",
                )
                return
            except Exception as error:  # pragma: no cover - exercised via integration behavior
                last_error = error
                LOGGER.warning(
                    "assistant callback failed",
                    extra={
                        "attempt": attempt,
                        "url": url,
                        "eventType": event_type,
                        "meetingId": meeting_id,
                        "error": str(error),
                    },
                )
                if attempt < 3:
                    await asyncio.sleep(0.4 * attempt)

        self._metrics.record_assistant_callback(event_type=event_type, outcome="failure")
        raise RuntimeError(f"Assistant callback failed after retries: {last_error}") from last_error
