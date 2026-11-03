from __future__ import annotations

import hmac
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from .config import load_settings
from .logging_utils import configure_logging
from .schemas import (
    ParticipantTranscriptionControlRequest,
    ParticipantTranscriptionControlResponse,
    StartSessionRequest,
    StartSessionResponse,
    StopSessionRequest,
    StopSessionResponse,
)
from .session_manager import RealtimeSessionManager


configure_logging()
LOGGER = logging.getLogger("readymeet.livekit_realtime.app")
SETTINGS = load_settings()
MANAGER = RealtimeSessionManager(SETTINGS)


async def require_service_secret(
    x_livekit_realtime_service_secret: Optional[str] = Header(default=None),
) -> None:
    if not x_livekit_realtime_service_secret or not hmac.compare_digest(
        x_livekit_realtime_service_secret.encode("utf-8"), SETTINGS.service_secret.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="Unauthorized")


@asynccontextmanager
async def lifespan(_: FastAPI):
    MANAGER.mark_ready(True)
    LOGGER.info(
        "livekit realtime service starting",
        extra={
            "port": SETTINGS.port,
            "assistantCallbackUrl": SETTINGS.assistant_callback_url,
            "serviceSecretConfigured": bool(SETTINGS.service_secret),
        },
    )
    try:
        yield
    finally:
        MANAGER.mark_ready(False)
        LOGGER.info("livekit realtime service stopping")
        await MANAGER.aclose()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def add_request_context(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    try:
        response = await call_next(request)
    except Exception as error:  # pragma: no cover - framework boundary
        LOGGER.exception(
            "unhandled request error",
            extra={"requestId": request_id, "path": request.url.path, "method": request.method},
        )
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "requestId": request_id},
            headers={"x-request-id": request_id},
        )

    response.headers["x-request-id"] = request_id
    return response


@app.get("/health")
async def health() -> dict[str, object]:
    return MANAGER.health()


@app.get("/ready")
async def ready() -> dict[str, object]:
    readiness = MANAGER.readiness()
    if not readiness["ready"]:
        raise HTTPException(status_code=503, detail=readiness)
    return readiness


@app.get("/metrics", response_class=PlainTextResponse)
async def metrics() -> str:
    return MANAGER.render_metrics()


@app.post("/internal/meetings/{meeting_id}/start", dependencies=[Depends(require_service_secret)], response_model=StartSessionResponse)
async def start_meeting(meeting_id: str, payload: StartSessionRequest) -> StartSessionResponse:
    if payload.meetingId != meeting_id:
        raise HTTPException(status_code=400, detail="Meeting id mismatch")

    started = await MANAGER.start_session(payload)
    return StartSessionResponse(started=started)


@app.post("/internal/meetings/{meeting_id}/stop", dependencies=[Depends(require_service_secret)], response_model=StopSessionResponse)
async def stop_meeting(meeting_id: str, payload: StopSessionRequest) -> StopSessionResponse:
    stopped, finalized = await MANAGER.stop_session(
        meeting_id,
        finalize=payload.finalize if payload.finalize is not None else True,
        drain=payload.drain if payload.drain is not None else True,
    )
    return StopSessionResponse(stopped=stopped, finalized=finalized)


@app.post(
    "/internal/meetings/{meeting_id}/participant-transcription",
    dependencies=[Depends(require_service_secret)],
    response_model=ParticipantTranscriptionControlResponse,
)
async def update_participant_transcription(
    meeting_id: str, payload: ParticipantTranscriptionControlRequest
) -> ParticipantTranscriptionControlResponse:
    updated = await MANAGER.set_participant_transcription_suppressed(
        meeting_id,
        participant_identity=payload.participantIdentity,
        suppressed=payload.suppressed,
    )
    return ParticipantTranscriptionControlResponse(updated=updated, suppressed=payload.suppressed)


@app.post("/internal/meetings/stop-all", dependencies=[Depends(require_service_secret)])
async def stop_all_meetings() -> dict[str, object]:
    await MANAGER.stop_all(finalize=False, drain=False)
    return MANAGER.health()
