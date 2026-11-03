"""API-owned admission and raw token settlement for one provider execution."""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx
import openai
from pydantic import BaseModel

from .api_repository import MeetingAgentRepository

LOGGER = logging.getLogger(__name__)


class CreditUsageError(RuntimeError):
    pass


class CreditSettlementError(CreditUsageError):
    pass


# Keep body fields aligned with the API's supported counted Responses request.
_RESPONSE_BODY_FIELDS = frozenset({
    "model", "input", "instructions", "max_output_tokens", "max_tool_calls", "tools",
    "tool_choice", "parallel_tool_calls", "text", "reasoning", "truncation", "temperature",
    "top_p", "top_logprobs", "stream", "include", "store", "metadata", "user",
    "safety_identifier", "service_tier", "prompt_cache_key", "prompt_cache_options",
    "prompt_cache_retention",
})


def _usage_from_mapping(usage: Any) -> dict[str, Any] | None:
    if not isinstance(usage, dict):
        return None
    if any(type(usage.get(key)) is not int or usage[key] < 0 for key in ("input_tokens", "output_tokens")):
        return None
    tokens = {key: usage[key] for key in ("input_tokens", "output_tokens")}
    details = usage.get("input_tokens_details")
    if isinstance(details, dict):
        tokens["input_tokens_details"] = {
            key: details[key] for key in ("cached_tokens", "cache_write_tokens") if key in details
        }
    return tokens


def _provider_error_usage(error: openai.APIStatusError) -> dict[str, Any] | None:
    body = error.body
    if not isinstance(body, dict) or "usage" not in body:
        return None
    return _usage_from_mapping(body.get("usage"))


def _json_request_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _json_request_value(value.model_dump(mode="json", exclude_unset=True))
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise CreditUsageError("unsupported_response_request")
        return {key: _json_request_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_request_value(item) for item in value]
    if value is None or type(value) in (str, int, float, bool):
        return value
    raise CreditUsageError("unsupported_response_request")


@dataclass(frozen=True)
class CreditUsageContext:
    repository: MeetingAgentRepository
    meeting_id: str
    user_id: str
    feature: str

    async def authorize_included_session(self, model: str) -> dict[str, Any]:
        reservation = await self.repository.reserve_credit_usage(
            meeting_id=self.meeting_id, user_id=self.user_id, model=model,
            feature=self.feature, is_unbounded=True,
        )
        self._validate_reservation(reservation)
        if reservation.get("included") is not True:
            await self.repository.release_credit_usage(**self._identity(reservation))
            raise CreditUsageError("unbounded_usage_not_supported")
        # LiveKit's cumulative audio/duration reports remain separate from token settlement.
        return reservation

    async def release_included_session(self, reservation: dict[str, Any]) -> None:
        self._validate_reservation(reservation)
        if reservation["included"] is not True:
            raise CreditUsageError("included_session_required")
        await self.repository.release_credit_usage(**self._identity(reservation))

    def _identity(self, reservation: dict[str, Any]) -> dict[str, str]:
        return {"reservation_id": reservation["reservationId"],
                "workspace_id": reservation["workspaceId"], "user_id": self.user_id}

    @staticmethod
    def _validate_reservation(reservation: Any) -> None:
        if (not isinstance(reservation, dict)
                or not isinstance(reservation.get("reservationId"), str)
                or not reservation["reservationId"]
                or not isinstance(reservation.get("workspaceId"), str)
                or not reservation["workspaceId"]
                or type(reservation.get("included")) is not bool):
            raise CreditUsageError("invalid_credit_authorization")

    async def create_response(self, client: Any, *, is_unbounded: bool = False, **request: Any) -> Any:
        maximum = request.get("max_output_tokens")
        if (type(maximum) is not int or maximum <= 0
                or ("stream" in request and request["stream"] is not False)):
            raise CreditUsageError("bounded_nonstreaming_response_required")
        transport = {"timeout": request.pop("timeout")} if "timeout" in request else {}
        extra_body = request.pop("extra_body", None)
        if extra_body is None:
            extra_body = {}
        if (not isinstance(extra_body, dict)
                or set(extra_body) - (_RESPONSE_BODY_FIELDS - {"model", "input", "max_output_tokens", "stream"})
                or set(extra_body) & set(request)
                or set(request) - _RESPONSE_BODY_FIELDS):
            raise CreditUsageError("unsupported_response_request")
        if "prompt_cache_options" in extra_body and extra_body["prompt_cache_options"] != {"mode": "explicit"}:
            raise CreditUsageError("unsupported_response_request")
        try:
            snapshot = json.dumps(_json_request_value({**request, **extra_body}), allow_nan=False)
        except (ValueError, TypeError, RecursionError) as error:
            raise CreditUsageError("unsupported_response_request") from error
        body = json.loads(snapshot)
        if not isinstance(body.get("model"), str) or not body["model"] or not isinstance(body.get("input"), (str, list)):
            raise CreditUsageError("unsupported_response_request")
        extra_body_fields = tuple(extra_body)
        reservation = await self.repository.reserve_credit_usage(
            meeting_id=self.meeting_id, user_id=self.user_id, model=body["model"],
            feature=self.feature, max_output_tokens=maximum, is_unbounded=is_unbounded,
            **({"request_body": body} if not is_unbounded else {}),
        )
        self._validate_reservation(reservation)
        identity = self._identity(reservation)
        if is_unbounded:
            valid = reservation["included"]
        else:
            authorized_output = reservation.get("maxOutputTokens")
            authorized_input = reservation.get("maxInputTokens")
            valid = ((type(authorized_output) is int and authorized_output >= maximum
                      and type(authorized_input) is int and authorized_input >= 0)
                     or (reservation["included"] and authorized_input is None
                         and (authorized_output is None or
                              (type(authorized_output) is int and authorized_output >= maximum))))
        if not valid:
            await self.repository.release_credit_usage(**identity)
            raise CreditUsageError("invalid_credit_bounds")
        generation = json.loads(snapshot)
        if extra_body_fields:
            # Unknown SDK fields must stay in extra_body, but use only the frozen snapshot.
            generation["extra_body"] = {key: generation.pop(key) for key in extra_body_fields}
        try:
            response = await client.responses.create(**generation, **transport)
        except openai.APIStatusError as error:
            # Only a rejection with no usage evidence proves the provider consumed nothing.
            if error.status_code in {400, 401, 402, 403, 404, 413, 422, 429}:
                usage = _provider_error_usage(error)
                if usage is not None:
                    await self.repository.settle_credit_usage(**identity, usage=usage)
                elif not (isinstance(error.body, dict) and "usage" in error.body):
                    await self.repository.release_credit_usage(**identity)
            raise
        # Timeouts, disconnects and cancellation have unknown outcomes: keep the hold.
        usage = getattr(response, "usage", None)
        raw = usage.model_dump() if callable(getattr(usage, "model_dump", None)) else usage
        if not isinstance(raw, dict) or any(
            type(raw.get(key)) is not int or raw[key] < 0 for key in ("input_tokens", "output_tokens")
        ):
            LOGGER.error("Provider usage missing", extra={"reservationId": reservation["reservationId"]})
            raise CreditSettlementError("provider_usage_missing")
        tokens = {key: raw[key] for key in ("input_tokens", "output_tokens")}
        details = raw.get("input_tokens_details")
        if isinstance(details, dict):
            tokens["input_tokens_details"] = {
                key: details[key] for key in ("cached_tokens", "cache_write_tokens") if key in details
            }
        for attempt in range(3):
            try:
                await self.repository.settle_credit_usage(**identity, usage=tokens)
                return response
            except (httpx.TransportError, httpx.HTTPStatusError) as error:
                if isinstance(error, httpx.HTTPStatusError) and error.response.status_code < 500:
                    break
                if attempt < 2:
                    await asyncio.sleep(0.1 * (attempt + 1))
            except Exception:
                break
        LOGGER.error("Credit settlement unresolved", extra={"reservationId": reservation["reservationId"]})
        raise CreditSettlementError("credit_settlement_unresolved")
