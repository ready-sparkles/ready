"""Join owned cleanup tasks even when their caller is cancelled."""
from __future__ import annotations

import asyncio
from typing import TypeVar

T = TypeVar("T")


async def finish_on_cancel(task: asyncio.Task[T]) -> T:
    """Cancellation must not abandon teardown or interrupt its finally blocks.

    Shield the owned task through repeated caller cancellations, including
    cancellation before the task first runs. Cleanup operations themselves
    must have bounded I/O waits. The caller still receives CancelledError.
    """
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            if not cancelled:
                raise
            break
    if cancelled:
        # Retrieve any exception so a racing cleanup error is not left unobserved.
        if not task.cancelled():
            task.exception()
        raise asyncio.CancelledError
    return task.result()
