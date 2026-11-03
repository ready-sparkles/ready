from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional

import openai

from .api_repository import InsufficientAiCreditsError
from .credit_usage import CreditUsageContext, CreditUsageError
from .prompt_cache import openai_prompt_cache_options


MAX_SUMMARY_TRANSCRIPT_CHARS = 24000
MAX_FALLBACK_LINES = 6
MIN_SUBSTANTIVE_SEGMENTS = 2
MIN_SUBSTANTIVE_CHARS = 48


@dataclass
class SummaryGenerationInput:
    meeting_id: str
    transcript: List[Dict[str, object]]
    model: str
    api_key: Optional[str]
    timeout_ms: int


@dataclass
class SummaryGenerationOutput:
    summary: str
    action_items: List[Dict[str, Optional[str]]]
    model: str
    mode: str


def normalize_content(content: str) -> str:
    return " ".join(content.split()).strip()


def is_meta_assistant_line(content: str) -> bool:
    normalized = normalize_content(content).lower()
    return any(
        phrase in normalized
        for phrase in (
            "hold space",
            "pulling together",
            "pulling up the latest discussion",
            "thanks for your patience",
            "i am still trying to retrieve",
            "i'm still working on pulling together",
            "i will share it with you in just a moment",
            "this is ",
            "i'm your assistant",
            "im your assistant",
            "hold space",
        )
    )


def is_assistant_speaker_name(speaker_name: str) -> bool:
    normalized = speaker_name.strip().lower()
    return (
        normalized == "assistant"
        or normalized == "readymeet assistant"
        or normalized.endswith("'s assistant")
        or normalized.endswith("' assistant")
    )


def is_meta_summary_request_line(content: str) -> bool:
    normalized = normalize_content(content).lower()
    return any(
        phrase in normalized
        for phrase in (
            "summary",
            "summarize",
            "recap",
            "what's been discussed",
            "what has been discussed",
            "what did we discuss",
            "bring me up to speed",
            "action items",
        )
    )


def is_filler_line(content: str) -> bool:
    normalized = normalize_content(content).lower()
    return normalized in (
        "",
        "so,",
        "let's see.",
        "let's see",
        "yeah.",
        "okay.",
        "all right.",
        "can you hear me?",
    ) or len(normalized) < 8


def prepare_transcript_for_summary(input_data: SummaryGenerationInput) -> Dict[str, object]:
    filtered = []
    for segment in input_data.transcript:
        content = normalize_content(str(segment.get("content") or ""))
        speaker_name = str(segment.get("speakerName") or "")
        if not content:
            continue
        if is_assistant_speaker_name(speaker_name) and is_meta_assistant_line(content):
            continue
        if is_meta_summary_request_line(content) or is_filler_line(content):
            continue
        filtered.append(segment)

    deduped = []
    previous_key = ""
    for segment in filtered:
        key = "%s:%s" % (
            segment.get("speakerName"),
            normalize_content(str(segment.get("content") or "")).lower(),
        )
        if key == previous_key:
            continue
        deduped.append(segment)
        previous_key = key

    transcript_text = ""
    included = []
    for segment in deduped:
        started_at = segment.get("startedAt")
        if isinstance(started_at, datetime):
            started_iso = started_at.isoformat()
        else:
            started_iso = str(started_at)
        line = "[%s] %s: %s\n" % (
            started_iso,
            segment.get("speakerName"),
            normalize_content(str(segment.get("content") or "")),
        )
        if len(transcript_text) + len(line) > MAX_SUMMARY_TRANSCRIPT_CHARS:
            break
        transcript_text += line
        included.append(segment)

    return {"segments": included, "transcriptText": transcript_text.strip()}


def infer_assignee(content: str) -> Optional[str]:
    import re

    match = re.search(r"\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)", content)
    if not match:
        return None
    return match.group(1)


def build_fallback_action_items(
    segments: List[Dict[str, object]]
) -> List[Dict[str, Optional[str]]]:
    action_items = []
    for segment in segments:
        content = normalize_content(str(segment.get("content") or ""))
        lower = content.lower()
        if (
            "follow up" in lower
            or "action item" in lower
            or lower.startswith("send ")
            or "need to " in lower
            or "should " in lower
        ):
            action_items.append(
                {"text": content.rstrip("?"), "assignee": infer_assignee(content)}
            )
        if len(action_items) >= 3:
            break
    return action_items


def build_fallback_summary(input_data: SummaryGenerationInput) -> SummaryGenerationOutput:
    prepared = prepare_transcript_for_summary(input_data)
    preview_segments = list(prepared["segments"])[:MAX_FALLBACK_LINES]
    action_items = build_fallback_action_items(list(prepared["segments"]))

    if not preview_segments:
        summary = "There is not enough substantive discussion yet to generate a meaningful summary."
    elif len(preview_segments) == 1:
        first = preview_segments[0]
        summary = "%s mainly said: %s" % (
            first.get("speakerName"),
            normalize_content(str(first.get("content") or "")),
        )
    else:
        highlights = []
        for segment in preview_segments:
            highlights.append(
                "%s said %s"
                % (
                    segment.get("speakerName"),
                    normalize_content(str(segment.get("content") or "")),
                )
            )
        summary = "So far, the meeting mainly covered %s." % "; ".join(highlights)

    return SummaryGenerationOutput(
        summary=summary,
        action_items=action_items,
        model="fallback-summary-v2",
        mode="fallback",
    )


async def generate_summary_and_action_items(
    input_data: SummaryGenerationInput,
    *, credit_usage: CreditUsageContext,
) -> SummaryGenerationOutput:
    prepared = prepare_transcript_for_summary(input_data)
    segments = list(prepared["segments"])
    substantive_char_count = sum(
        len(normalize_content(str(segment.get("content") or ""))) for segment in segments
    )

    if len(segments) < MIN_SUBSTANTIVE_SEGMENTS or substantive_char_count < MIN_SUBSTANTIVE_CHARS:
        fallback_input = SummaryGenerationInput(
            meeting_id=input_data.meeting_id,
            transcript=segments,
            model=input_data.model,
            api_key=input_data.api_key,
            timeout_ms=input_data.timeout_ms,
        )
        return build_fallback_summary(fallback_input)

    if not input_data.api_key or not segments:
        return build_fallback_summary(input_data)

    client = openai.AsyncClient(api_key=input_data.api_key, max_retries=0)
    try:
        response = await asyncio.wait_for(
            credit_usage.create_response(
                client, model=input_data.model, max_output_tokens=8192,
                extra_body=openai_prompt_cache_options(input_data.model),
                input=[
                    {
                        "role": "system",
                        "content": (
                            "You generate concise, accurate meeting recaps. Ignore assistant "
                            "greeting and progress chatter, deduplicate repeated requests, focus "
                            "on substantive discussion, and return strict JSON with keys summary "
                            "(string) and actionItems (array of {text, assignee|null}). The "
                            "summary should be 2-4 sentences, spoken-language friendly, and "
                            "mention the main topics, any decisions, and unresolved asks. If the "
                            "meeting is mostly testing or exploratory chatter, say that plainly "
                            "rather than inventing decisions."
                        ),
                    },
                    {
                        "role": "user",
                        "content": "Meeting ID: %s\nTranscript:\n%s"
                        % (input_data.meeting_id, prepared["transcriptText"]),
                    },
                ],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "meeting_summary",
                        "strict": True,
                        "schema": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["summary", "actionItems"],
                            "properties": {
                                "summary": {"type": "string"},
                                "actionItems": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "additionalProperties": False,
                                        "required": ["text", "assignee"],
                                        "properties": {
                                            "text": {"type": "string"},
                                            "assignee": {"type": ["string", "null"]},
                                        },
                                    },
                                },
                            },
                        },
                    }
                },
            ),
            timeout=input_data.timeout_ms / 1000.0,
        )

        payload = getattr(response, "output_parsed", None)
        if not payload:
            payload = json.loads(response.output_text)

        action_items = []
        for item in payload.get("actionItems", []):
            action_items.append(
                {"text": str(item.get("text") or ""), "assignee": item.get("assignee")}
            )

        return SummaryGenerationOutput(
            summary=str(payload.get("summary") or "").strip(),
            action_items=action_items,
            model=input_data.model,
            mode="model",
        )
    except (CreditUsageError, InsufficientAiCreditsError):
        raise
    except Exception:
        return build_fallback_summary(input_data)
    finally:
        await client.close()
