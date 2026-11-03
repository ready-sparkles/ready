from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

from meeting_agent.env import Settings


class ActiveMeetingTurnConflictError(RuntimeError):
    def __init__(self, active_turn: Optional["MeetingTurnRecord"] = None) -> None:
        super().__init__("Meeting already has an active assistant turn")
        self.active_turn = active_turn


class InsufficientAiCreditsError(RuntimeError):
    def __init__(self, reason: str = "insufficient_credits") -> None:
        self.reason = reason
        super().__init__("Paid live AI sessions require an enforceable cost limit."
                         if reason == "unbounded_usage_not_supported" else "Insufficient AI credits.")


@dataclass
class TranscriptSegmentInput:
    meeting_id: str
    speaker_identity: str
    speaker_name: str
    content: str
    started_at: datetime
    speaker_user_id: Optional[str] = None
    speaker_role: str = "human"
    source: str = "legacy-transcript"
    source_segment_id: Optional[str] = None
    meeting_turn_id: Optional[str] = None
    agent_profile_id: Optional[str] = None
    agent_owner_user_id: Optional[str] = None
    voice_id: Optional[str] = None
    ended_at: Optional[datetime] = None


@dataclass
class AgentProfileRecord:
    id: str
    user_id: str
    name: str
    display_name: str
    system_prompt: Optional[str]
    voice_provider: str
    voice_id: Optional[str]
    llm_model: Optional[str]
    is_default: bool


@dataclass
class MeetingTurnRecord:
    id: str
    meeting_id: str
    owner_user_id: str
    owner_participant_identity: str
    agent_profile_id: str
    assistant_display_name: str
    voice_id: Optional[str]
    status: str
    started_at: datetime
    ended_at: Optional[datetime]


@dataclass
class AgentMemoryRecord:
    id: str
    user_id: str
    agent_profile_id: str
    memory_type: str
    content: str
    source: str
    created_at: datetime
    updated_at: datetime


@dataclass
class AgentConnectorRecord:
    id: str
    user_id: str
    agent_profile_id: str
    provider: str
    status: str
    scope: str
    external_account_email: Optional[str]
    created_at: datetime
    updated_at: datetime


@dataclass
class AgentToolPolicyRecord:
    id: str
    agent_profile_id: str
    tool_name: str
    mode: str
    config: Dict[str, Any]
    created_at: datetime
    updated_at: datetime


def _parse_time(value: Any) -> Optional[datetime]:
    if value is None or isinstance(value, datetime):
        return value
    if isinstance(value, str) and value != "":
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return None


def _text(row: Dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in row and row[name] is not None:
            return row[name]
    return None


def _alias_row(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    aliased = dict(row)
    for key, value in list(row.items()):
        snake = "".join(f"_{character.lower()}" if character.isupper() else character for character in key)
        aliased.setdefault(snake, value)
    return aliased


def _turn(row: Optional[Dict[str, Any]]) -> Optional[MeetingTurnRecord]:
    if row is None:
        return None
    return MeetingTurnRecord(
        id=str(row["id"]),
        meeting_id=str(_text(row, "meetingId", "meeting_id")),
        owner_user_id=str(_text(row, "ownerUserId", "owner_user_id")),
        owner_participant_identity=str(_text(row, "ownerParticipantIdentity", "owner_participant_identity")),
        agent_profile_id=str(_text(row, "agentProfileId", "agent_profile_id")),
        assistant_display_name=str(_text(row, "assistantDisplayName", "assistant_display_name")),
        voice_id=_text(row, "voiceId", "voice_id"),
        status=str(row["status"]),
        started_at=_parse_time(_text(row, "startedAt", "started_at")) or datetime.now(),
        ended_at=_parse_time(_text(row, "endedAt", "ended_at")),
    )


def _profile(row: Dict[str, Any]) -> AgentProfileRecord:
    return AgentProfileRecord(
        id=str(row["id"]),
        user_id=str(_text(row, "userId", "user_id")),
        name=str(row["name"]),
        display_name=str(_text(row, "displayName", "display_name")),
        system_prompt=_text(row, "systemPrompt", "system_prompt"),
        voice_provider=str(_text(row, "voiceProvider", "voice_provider")),
        voice_id=_text(row, "voiceId", "voice_id"),
        llm_model=_text(row, "llmModel", "llm_model"),
        is_default=bool(_text(row, "isDefault", "is_default")),
    )


class MeetingAgentRepository:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def open(self) -> None:
        return None

    async def _post(self, payload: Dict[str, Any]) -> Any:
        base_url = self._settings.api_base_url.rstrip("/")
        if base_url.startswith("http://localhost:"):
            base_url = "http://127.0.0.1:" + base_url.split("http://localhost:", 1)[1]
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{base_url}/v1/internal/meeting-agent",
                headers={
                    "content-type": "application/json",
                    "x-assistant-service-secret": self._settings.assistant_service_secret,
                },
                json=payload,
            )
        if response.status_code == 409:
            body = response.json()
            raise ActiveMeetingTurnConflictError(_turn(body.get("activeTurn")))
        if response.status_code == 402:
            body = response.json()
            reason = body.get("code") if isinstance(body, dict) else None
            raise InsufficientAiCreditsError(
                reason if reason == "unbounded_usage_not_supported" else "insufficient_credits")
        response.raise_for_status()
        return response.json().get("result")

    async def get_meeting_by_id(self, meeting_id: str) -> Optional[Dict[str, Any]]:
        return _alias_row(await self._post({"action": "getMeeting", "meetingId": meeting_id}))

    async def list_participants_for_meeting(self, meeting_id: str) -> List[Dict[str, Any]]:
        rows = await self._post({"action": "listParticipants", "meetingId": meeting_id})
        return [row for row in (_alias_row(item) for item in rows or []) if row is not None]

    async def get_summary_for_meeting(self, meeting_id: str) -> Optional[Dict[str, Any]]:
        return _alias_row(await self._post({"action": "getSummary", "meetingId": meeting_id}))

    async def list_action_items_for_meeting(self, meeting_id: str) -> List[Dict[str, Any]]:
        rows = await self._post({"action": "listActionItems", "meetingId": meeting_id})
        return [row for row in (_alias_row(item) for item in rows or []) if row is not None]

    async def create_action_item_for_meeting(
        self, meeting_id: str, text: str, assignee: Optional[str]
    ) -> Dict[str, Any]:
        row = _alias_row(
            await self._post(
                {
                    "action": "createActionItem",
                    "meetingId": meeting_id,
                    "text": text,
                    "assignee": assignee,
                }
            )
        )
        if row is None:
            raise RuntimeError("Failed to create task")
        return row

    async def ensure_default_agent_profile_for_user(
        self,
        *,
        user_id: str,
        display_name: str,
        voice_id: Optional[str],
        llm_model: Optional[str],
    ) -> AgentProfileRecord:
        row = await self._post(
            {
                "action": "ensureDefaultAgentProfile",
                "userId": user_id,
                "displayName": display_name,
                "voiceId": voice_id,
                "llmModel": llm_model,
            }
        )
        return _profile(row)

    async def create_meeting_turn_lease(
        self,
        *,
        meeting_id: str,
        owner_user_id: str,
        owner_participant_identity: str,
        agent_profile_id: str,
        assistant_display_name: str,
        voice_id: Optional[str],
    ) -> MeetingTurnRecord:
        row = _turn(
            await self._post(
                {
                    "action": "createMeetingTurnLease",
                    "meetingId": meeting_id,
                    "ownerUserId": owner_user_id,
                    "ownerParticipantIdentity": owner_participant_identity,
                    "agentProfileId": agent_profile_id,
                    "assistantDisplayName": assistant_display_name,
                    "voiceId": voice_id,
                }
            )
        )
        if row is None:
            raise RuntimeError("Failed to create meeting turn lease")
        return row

    async def update_meeting_turn_lease(
        self,
        *,
        meeting_turn_id: str,
        owner_user_id: str,
        owner_participant_identity: str,
        status: str,
    ) -> Optional[MeetingTurnRecord]:
        return _turn(
            await self._post(
                {
                    "action": "updateMeetingTurnLease",
                    "meetingTurnId": meeting_turn_id,
                    "ownerUserId": owner_user_id,
                    "ownerParticipantIdentity": owner_participant_identity,
                    "status": status,
                }
            )
        )

    async def reserve_credit_usage(
        self, *, meeting_id: str, user_id: str, model: str, feature: str,
        max_output_tokens: Optional[int] = None, is_unbounded: bool = False,
        request_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "action": "reserveCreditUsage", "meetingId": meeting_id, "userId": user_id,
            "provider": "openai", "model": model, "feature": feature,
        }
        if max_output_tokens is not None:
            payload["maxOutputTokens"] = max_output_tokens
        if is_unbounded:
            payload["isUnbounded"] = True
        if request_body is not None:
            payload["requestBody"] = request_body
        return await self._post(payload)

    async def settle_credit_usage(
        self, *, reservation_id: str, workspace_id: str, user_id: str, usage: Dict[str, Any],
    ) -> Any:
        return await self._post({
            "action": "settleCreditUsage", "reservationId": reservation_id,
            "workspaceId": workspace_id, "userId": user_id, "usage": usage,
        })

    async def release_credit_usage(
        self, *, reservation_id: str, workspace_id: str, user_id: str,
    ) -> Any:
        return await self._post({
            "action": "releaseCreditUsage", "reservationId": reservation_id,
            "workspaceId": workspace_id, "userId": user_id,
        })

    async def list_agent_memories_for_user(
        self, *, user_id: str, agent_profile_id: str
    ) -> List[AgentMemoryRecord]:
        rows = await self._post(
            {"action": "listAgentMemories", "userId": user_id, "agentProfileId": agent_profile_id}
        )
        return [
            AgentMemoryRecord(
                id=str(row["id"]),
                user_id=str(_text(row, "userId", "user_id")),
                agent_profile_id=str(_text(row, "agentProfileId", "agent_profile_id")),
                memory_type=str(_text(row, "memoryType", "memory_type")),
                content=str(row["content"]),
                source=str(row["source"]),
                created_at=_parse_time(_text(row, "createdAt", "created_at")) or datetime.now(),
                updated_at=_parse_time(_text(row, "updatedAt", "updated_at")) or datetime.now(),
            )
            for row in rows or []
        ]

    async def list_agent_connectors_for_user(
        self, *, user_id: str, agent_profile_id: str
    ) -> List[AgentConnectorRecord]:
        rows = await self._post(
            {"action": "listAgentConnectors", "userId": user_id, "agentProfileId": agent_profile_id}
        )
        return [
            AgentConnectorRecord(
                id=str(row["id"]),
                user_id=str(_text(row, "userId", "user_id")),
                agent_profile_id=str(_text(row, "agentProfileId", "agent_profile_id")),
                provider=str(row["provider"]),
                status=str(row["status"]),
                scope=str(row["scope"]),
                external_account_email=_text(row, "externalAccountEmail", "external_account_email"),
                created_at=_parse_time(_text(row, "createdAt", "created_at")) or datetime.now(),
                updated_at=_parse_time(_text(row, "updatedAt", "updated_at")) or datetime.now(),
            )
            for row in rows or []
        ]

    async def list_agent_tool_policies(self, *, agent_profile_id: str) -> List[AgentToolPolicyRecord]:
        rows = await self._post({"action": "listAgentToolPolicies", "agentProfileId": agent_profile_id})
        return [
            AgentToolPolicyRecord(
                id=str(row["id"]),
                agent_profile_id=str(_text(row, "agentProfileId", "agent_profile_id")),
                tool_name=str(_text(row, "toolName", "tool_name")),
                mode=str(row["mode"]),
                config=row.get("config") or {},
                created_at=_parse_time(_text(row, "createdAt", "created_at")) or datetime.now(),
                updated_at=_parse_time(_text(row, "updatedAt", "updated_at")) or datetime.now(),
            )
            for row in rows or []
        ]

    async def append_transcript_segment(self, segment: TranscriptSegmentInput) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "action": "appendTranscriptSegment",
            "meetingId": segment.meeting_id,
            "speakerIdentity": segment.speaker_identity,
            "speakerName": segment.speaker_name,
            "speakerRole": segment.speaker_role,
            "source": segment.source,
            "content": segment.content,
            "startedAt": segment.started_at.isoformat(),
        }
        if segment.speaker_user_id:
            payload["speakerUserId"] = segment.speaker_user_id
        if segment.source_segment_id:
            payload["sourceSegmentId"] = segment.source_segment_id
        if segment.meeting_turn_id:
            payload["meetingTurnId"] = segment.meeting_turn_id
        if segment.agent_profile_id:
            payload["agentProfileId"] = segment.agent_profile_id
        if segment.agent_owner_user_id:
            payload["agentOwnerUserId"] = segment.agent_owner_user_id
        if segment.voice_id:
            payload["voiceId"] = segment.voice_id
        if segment.ended_at is not None:
            payload["endedAt"] = segment.ended_at.isoformat()
        row = _alias_row(await self._post(payload))
        if row is None:
            raise RuntimeError("Failed to append transcript segment")
        return row

    async def get_transcript_segments_after(
        self, meeting_id: str, created_at: datetime, segment_id: str, *, limit: int = 200
    ) -> List[Dict[str, Any]]:
        rows = await self._post(
            {
                "action": "listTranscriptSegmentsAfter",
                "meetingId": meeting_id,
                "createdAt": created_at.isoformat(),
                "segmentId": segment_id,
                "limit": limit,
            }
        )
        return [row for row in (_alias_row(item) for item in rows or []) if row is not None]

    async def get_transcript_for_meeting(self, meeting_id: str) -> Optional[Dict[str, Any]]:
        result = await self._post({"action": "getTranscript", "meetingId": meeting_id})
        if result is None:
            return None
        segments = result.get("segments") or []
        return {"transcript": _alias_row(result.get("transcript")), "segments": segments}
