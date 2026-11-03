"""Sparse spoken reassurance for an active transcript request, never a tool retry."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable


async def report_answer_progress(
    session: Any,
    still_current: Callable[[], Awaitable[bool]],
    send: Callable[[str], None],
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    clock: Callable[[], float] = time.monotonic,
    first_delay: float = 15,
    interval: float = 30,
) -> None:
    """Caller cancels and awaits this task before publishing success/failure.

    Wait for a quiet gap rather than interrupt either speaker. The timer never
    claims a percentage or completion estimate and does not call a backend model.
    """
    try:
        await sleep(first_delay)
        while await still_current():
            quiet_since = clock()
            while clock() - quiet_since < 4:
                if not await still_current():
                    return
                if session.user_state == "speaking" or session.agent_state == "speaking":
                    quiet_since = clock()
                await sleep(1)
            if not await still_current():
                return
            if session.user_state == "speaking" or session.agent_state == "speaking":
                continue
            send(
                "The requested meeting answer is still being prepared. Briefly reassure the user "
                "in their language, for example: I'm still reviewing the discussion. "
                "Say only one short sentence, then keep listening. Do not invent findings, "
                "promise a completion time, repeat the request, or call any tools."
            )
            await sleep(interval)
    except asyncio.CancelledError:
        raise
    except Exception:
        # A progress-channel failure must not discard a successfully running analysis.
        return
