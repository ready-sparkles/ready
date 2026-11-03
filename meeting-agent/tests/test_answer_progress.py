from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meeting_agent.answer_progress import report_answer_progress


class ProgressTests(unittest.IsolatedAsyncioTestCase):
    async def test_sparse_updates_wait_for_quiet_and_do_not_promise_a_result(self):
        now = 0
        spoken = []
        session = SimpleNamespace(user_state='listening', agent_state='listening')

        async def sleep(seconds):
            nonlocal now
            now += seconds
            session.user_state = 'speaking' if 15 <= now <= 25 else 'listening'
            await asyncio.sleep(0)

        await report_answer_progress(session, AsyncMock(side_effect=lambda: len(spoken) < 2),
            lambda message: spoken.append((now, message)), sleep=sleep, clock=lambda: now)
        self.assertGreaterEqual(spoken[0][0], 29)
        self.assertGreaterEqual(spoken[1][0] - spoken[0][0], 30)
        self.assertIn('Do not invent findings', spoken[0][1])
        self.assertIn('call any tools', spoken[0][1])

    async def test_fast_completion_or_cancel_does_not_speak_later(self):
        waiting = asyncio.Event()
        send = Mock()
        async def sleep(seconds):
            waiting.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(report_answer_progress(
            SimpleNamespace(), AsyncMock(return_value=True), send, sleep=sleep))
        await waiting.wait()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        send.assert_not_called()

    async def test_changed_owner_and_progress_transport_failure_stop_updates(self):
        send = Mock(side_effect=RuntimeError('closed'))
        now = 0
        async def sleep(seconds):
            nonlocal now
            now += seconds
        session = SimpleNamespace(user_state='listening', agent_state='listening')
        await report_answer_progress(session, AsyncMock(return_value=False), send, sleep=sleep)
        send.assert_not_called()
        await report_answer_progress(session, AsyncMock(return_value=True), send, sleep=sleep, clock=lambda: now)
        send.assert_called_once()

    async def test_agent_speech_also_defers_updates(self):
        now = 0
        session = SimpleNamespace(user_state='listening', agent_state='speaking')
        send = Mock()
        async def sleep(seconds):
            nonlocal now
            now += seconds
        await report_answer_progress(session, AsyncMock(side_effect=lambda: now < 60), send,
                                     sleep=sleep, clock=lambda: now)
        send.assert_not_called()
