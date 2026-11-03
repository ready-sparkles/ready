"""Prompt cache policy for Responses requests (keep in sync with @readymeet/shared)."""
from __future__ import annotations

import re
from typing import Any

from livekit.plugins import openai as livekit_openai


def openai_prompt_cache_options(model: str) -> dict[str, Any]:
    """No breakpoints + explicit mode means no cache reads or writes on GPT-5.6+."""
    generation = re.match(r"^gpt-(\d+)(?:\.(\d+))?(?:-|$)", model)
    if not generation:
        return {}
    major, minor = int(generation[1]), int(generation[2] or 0)
    if major < 5 or (major == 5 and minor < 6):
        return {}
    return {"prompt_cache_options": {"mode": "explicit"}}


class UncachedResponsesLLM(livekit_openai.responses.LLM):
    """Apply the policy to every streaming turn, including tool continuations.

    LiveKit forwards chat extra_kwargs to either a WebSocket payload or the SDK.
    HTTP uses extra_body for compatibility with SDKs predating cache controls.
    GPT-Live server delegation is separate and exposes no cache option today.
    """

    def __init__(self, **kwargs: Any) -> None:
        self._cache_uses_websocket = kwargs.get("use_websocket", True) and kwargs.get("client") is None
        super().__init__(**kwargs)

    def chat(self, **kwargs: Any) -> Any:
        supplied = kwargs.pop("extra_kwargs", None)
        extra = dict(supplied) if isinstance(supplied, dict) else {}
        policy = openai_prompt_cache_options(self.model)
        if policy:
            if self._cache_uses_websocket:
                extra.update(policy)
            else:
                extra["extra_body"] = {**extra.get("extra_body", {}), **policy}
        return super().chat(**kwargs, extra_kwargs=extra)
