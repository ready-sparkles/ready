from __future__ import annotations

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class StartSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    meetingId: str
    roomName: str
    livekitUrl: str
    token: str
    participantIdentity: str
    participantName: str
    participantNames: List[str] = Field(default_factory=list)


class StopSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    finalize: Optional[bool] = None
    drain: Optional[bool] = None


class StartSessionResponse(BaseModel):
    started: bool


class StopSessionResponse(BaseModel):
    stopped: bool
    finalized: bool


class ParticipantTranscriptionControlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    participantIdentity: str
    suppressed: bool


class ParticipantTranscriptionControlResponse(BaseModel):
    updated: bool
    suppressed: bool


class TranscriptSegmentPayload(BaseModel):
    speakerIdentity: str
    speakerUserId: Optional[str] = None
    speakerName: str
    content: str
    startedAt: str
    endedAt: str


class LiveTranscriptSegmentPayload(TranscriptSegmentPayload):
    trackSid: Optional[str] = None
    segmentId: str


class LiveTranscriptEvent(BaseModel):
    type: Literal["live_transcript_segment"]
    meetingId: str
    segment: LiveTranscriptSegmentPayload
    metadata: Optional[Dict[str, str]] = None


class FinalTranscriptEventMetadata(BaseModel):
    mode: Literal["postcall-refined", "agent-live-finalized"]
    segmentCount: int
    refinedAt: str
    recordingDir: str
    transcriptionModel: str
    language: str = ""
    transcriptSettleWaitSeconds: Optional[float] = None
    transcriptSettleIdleSeconds: Optional[float] = None
    transcriptSettleMaxSeconds: Optional[float] = None
    transcriptSettleComplete: Optional[bool] = None
    segmentCountBeforeSettle: Optional[int] = None
    segmentCountAfterSettle: Optional[int] = None


class FinalTranscriptEvent(BaseModel):
    type: Literal["final_transcript"]
    meetingId: str
    segments: List[TranscriptSegmentPayload]
    metadata: FinalTranscriptEventMetadata
