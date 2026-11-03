from __future__ import annotations
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from livekit import rtc
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from meeting_agent.voice_health import VoiceSessionHealth, ContextBackpressure
from meeting_agent.transcript_context import TranscriptContext


class VoiceHealthTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.logs = []
        self.stop = Mock()
        self.health = VoiceSessionHealth('meeting', self.stop, clock=lambda: self.now, emit=self.logs.append)
        self.duplex = rtc.EventEmitter()
        self.duplex.send_event = Mock()
        self.health.attach(self.duplex)

    def test_only_matching_ack_releases_backpressure(self):
        self.health.append('Private meeting details')
        first = self.duplex.send_event.call_args.args[0]
        self.assertIn('delegation_id', first)
        self.assertIsNone(first['delegation_id'])
        for _ in range(self.health.MAX_PENDING_APPENDS - 1): self.health.append('Queued')
        with self.assertRaises(ContextBackpressure): self.health.append('Next')
        self.duplex.emit('openai_server_event_received', {'type': 'session.thinking.appended', 'client_event_id': 'wrong'})
        with self.assertRaises(ContextBackpressure): self.health.append('Next')
        self.duplex.emit('openai_server_event_received', {'type': 'session.thinking.appended', 'client_event_id': first['event_id']})
        self.health.append('Next')
        self.assertEqual(self.health.acknowledged, 1)
        self.assertEqual(self.duplex.send_event.call_count, self.health.MAX_PENDING_APPENDS + 1)
        self.assertNotIn('Private meeting', str(self.logs))

    def test_moderation_stops_once_without_retrying_or_logging_content(self):
        for _ in range(5):
            self.duplex.emit('openai_server_event_received', {'type': 'error', 'error': {
                'code': 'content_filter', 'message': 'PRIVATE CONTENT', 'param': 'SECRET'}})
        self.stop.assert_called_once_with('content_filter')
        with self.assertRaises(ContextBackpressure): self.health.append('No retry')
        self.duplex.send_event.assert_not_called()
        self.assertNotIn('PRIVATE CONTENT', str(self.logs))
        self.assertNotIn('SECRET', str(self.logs))

    def test_incomplete_injection_is_correlated_without_replaying(self):
        self.health.append('Private context')
        event_id = self.duplex.send_event.call_args.args[0]['event_id']
        self.duplex.emit('openai_server_event_received', {'type': 'error', 'error': {
            'code': 'context_injection_incomplete', 'client_event_id': event_id}})
        self.stop.assert_called_once_with('context_injection_incomplete')
        error_log = next(row for row in self.logs if row['event'] == 'voice-provider-error')
        self.assertTrue(error_log['errorMatchesPending'])
        with self.assertRaises(ContextBackpressure): self.health.append('Private context')
        self.assertEqual(self.duplex.send_event.call_count, 1)

    def test_missing_ack_disables_optional_context_without_stopping_live_audio(self):
        self.health.append('Context')
        self.now = 59
        self.health.tick()
        self.stop.assert_not_called()
        self.now = 60
        self.health.tick()
        self.health.tick()
        self.stop.assert_not_called()
        self.assertTrue(self.health.context_disabled)
        self.assertFalse(self.health.pending)
        with self.assertRaises(ContextBackpressure): self.health.append('Do not retry')
        self.assertEqual(self.duplex.send_event.call_count, 1)

    def test_reconnect_discards_old_ack_and_allows_sdk_retries(self):
        self.health.append('Old context')
        old = self.duplex.send_event.call_args.args[0]['event_id']
        self.duplex.emit('session_reconnected', None)
        self.health.append('Replayed context')
        self.duplex.emit('openai_server_event_received', {'type': 'session.thinking.appended', 'client_event_id': old})
        self.assertEqual(len(self.health.pending), 1)
        for index in range(3):
            self.duplex.emit('error', SimpleNamespace(recoverable=True))
            if index < 2: self.duplex.emit('session_reconnected', None)
        self.stop.assert_not_called()
        self.duplex.emit('error', SimpleNamespace(recoverable=False))
        self.stop.assert_called_once_with('model_unavailable')

    def test_isolated_error_ages_out_and_close_detaches_callbacks(self):
        self.duplex.emit('error', SimpleNamespace(recoverable=True))
        self.now = 31
        self.duplex.emit('error', SimpleNamespace(recoverable=True))
        self.duplex.emit('error', SimpleNamespace(recoverable=True))
        self.stop.assert_not_called()
        self.health.close()
        self.duplex.emit('error', SimpleNamespace(recoverable=False))
        self.stop.assert_not_called()
        self.assertFalse(self.health.pending)

    def test_rejected_append_clears_slots_without_killing_or_replaying_voice(self):
        for _ in range(4): self.health.append('Rejected')
        for event_id in list(self.health.pending):
            self.duplex.emit('openai_server_event_received', {'type': 'error', 'error': {
                'code': 'invalid_request_error', 'client_event_id': event_id}})
            self.duplex.emit('error', SimpleNamespace(recoverable=True))
        self.assertTrue(self.health.context_disabled)
        self.assertFalse(self.health.pending)
        self.now = 120
        self.health.tick()
        self.stop.assert_not_called()
        self.assertEqual(len(self.health.errors), 0)
        with self.assertRaises(ContextBackpressure): self.health.append('No retry')
        self.assertEqual(self.duplex.send_event.call_count, 4)
        # A subsequent actual connection failure must still stop the session.
        self.duplex.emit('error', SimpleNamespace(recoverable=False))
        self.stop.assert_called_once_with('model_unavailable')

    def test_send_exception_and_token_budget_are_bounded(self):
        for _ in range(6):
            try: self.health.append('word ' * 450)
            except ContextBackpressure: pass
        self.assertLessEqual(sum(value[1] for value in self.health.pending.values()), self.health.MAX_PENDING_TOKENS)
        self.assertLess(self.duplex.send_event.call_count, 6)
        self.health.reconnected()
        self.duplex.send_event.side_effect = RuntimeError('socket closed')
        with self.assertRaises(ContextBackpressure): self.health.append('test')
        self.assertFalse(self.health.pending)
        self.assertTrue(self.health.context_disabled)
        self.stop.assert_not_called()

    def test_reconnect_resumes_context_after_timeout_rejection_or_send_failure(self):
        for cause in ('timeout', 'rejection', 'send_failure'):
            with self.subTest(cause=cause):
                self.setUp()
                context = TranscriptContext([], owner_identity='owner', owner_user_id='owner', assistant_identity='agent')
                self.duplex.on('session_reconnected', context.reconnect)
                if cause == 'send_failure':
                    self.duplex.send_event.side_effect = RuntimeError('offline')
                try:
                    context.deliver([dict(id='1', content='Decision', speaker_name='Other')], self.health.append)
                except ContextBackpressure:
                    pass
                old_ids = list(self.health.pending)
                if cause == 'timeout':
                    self.now = 60
                    self.health.tick()
                elif cause == 'rejection':
                    self.health.server_event({'type': 'error', 'error': {
                        'code': 'invalid_request_error', 'client_event_id': old_ids[0]}})
                self.assertTrue(self.health.context_disabled)
                self.assertEqual(self.health.context_disable_reason, {
                    "timeout": "context_delivery_timeout",
                    "rejection": "context_rejected",
                    "send_failure": "context_send_failed",
                }[cause])
                self.duplex.send_event.side_effect = None
                self.duplex.send_event.reset_mock()
                self.duplex.emit('session_reconnected', None)
                self.assertFalse(self.health.context_disabled)
                self.assertIsNone(self.health.context_disable_reason)
                context.deliver([], self.health.append)
                self.assertTrue(self.health.pending)
                self.assertTrue(any('Decision' in call.args[0]['content']
                                    for call in self.duplex.send_event.call_args_list))
                pending = dict(self.health.pending)
                for event_id in old_ids:
                    self.health.server_event({'type': 'session.thinking.appended', 'client_event_id': event_id})
                self.assertEqual(self.health.pending, pending)
                self.stop.assert_not_called()

    def test_startup_counts_and_first_audio_are_content_free(self):
        self.duplex.emit('openai_client_event_queued', {'type': 'session.start', 'session': {
            'instructions': 'SECRET INSTRUCTIONS', 'input': [{'content': [{'text': 'PRIVATE TRANSCRIPT'}]}]}})
        self.duplex.emit('openai_server_event_received', {'type': 'session.started', 'session': {'id': 'session-1'}})
        for _ in range(100): self.duplex.emit('openai_server_event_received', {'type': 'session.output_audio.delta', 'delta': 'PRIVATE AUDIO'})
        self.assertEqual(len(self.logs), 3)
        self.assertNotIn('PRIVATE', str(self.logs))
        self.assertNotIn('SECRET', str(self.logs))
        self.assertEqual(self.logs[-1]['providerSessionId'], 'session-1')

    def test_long_history_and_unheard_speech_progress_without_loss(self):
        rows = [dict(id=str(i), content=f'Decision {i}: ' + 'word ' * 80, speaker_name='Colleague') for i in range(600)]
        context = TranscriptContext(rows, owner_identity='owner', owner_user_id='owner', assistant_identity='agent')
        self.assertTrue(context.truncated)
        self.assertLess(context.diagnostics()['startupTokens'], 8192)
        self.assertNotIn('word', str(context.diagnostics()))
        updates = [dict(id='new-' + str(i), content=f'New decision {i}', speaker_name='Colleague') for i in range(3)]
        for _ in range(3):
            try: context.deliver(updates, self.health.append)
            except ContextBackpressure: pass
            event_id = self.duplex.send_event.call_args.args[0]['event_id']
            self.duplex.emit('openai_server_event_received', {'type': 'session.thinking.appended', 'client_event_id': event_id})
        self.assertTrue(all(row['id'] in context.seen for row in updates))
        self.assertEqual(self.duplex.send_event.call_count, 3)


class VoiceFailureCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_ack_flushes_busy_meeting_backlog_before_next_database_poll(self):
        import asyncio
        events = rtc.EventEmitter()
        events.send_event = Mock()
        health = VoiceSessionHealth('meeting', Mock(), emit=lambda event: None)
        health.attach(events)
        context = TranscriptContext([], owner_identity='owner', owner_user_id='owner', assistant_identity='agent')
        rows = [dict(id=str(i), content=f'Short statement {i}', speaker_name='Other') for i in range(20)]
        with self.assertRaises(ContextBackpressure):
            context.deliver(rows, health.append, max_chunks=20)
        self.assertEqual(events.send_event.call_count, 8)
        task = asyncio.create_task(health.flush_until_poll(context, 2))
        try:
            for _ in range(3):
                for event_id in list(health.pending):
                    events.emit('openai_server_event_received', {'type': 'session.thinking.appended', 'client_event_id': event_id})
                await asyncio.sleep(0.01)
            self.assertEqual(events.send_event.call_count, 20)
            self.assertEqual(len(context.seen), 20)
            self.assertFalse(task.done())  # Still within the original two-second polling interval.
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


    async def test_observer_is_attached_before_the_sdk_session_task_can_run(self):
        from unittest.mock import patch
        from livekit.plugins.openai.realtime import GPTLiveModel
        from meeting_agent.voice_health import ObservedGPTLiveModel
        events = rtc.EventEmitter()
        logs = []
        health = VoiceSessionHealth('meeting', Mock(), emit=logs.append)
        model = ObservedGPTLiveModel(monitor=health, api_key='mock-no-provider')
        with patch.object(GPTLiveModel, 'session', return_value=events):
            self.assertIs(model.session(), events)
        events.emit('openai_server_event_received', {'type': 'session.started', 'session': {'id': 'provider'}})
        self.assertEqual(logs[-1]['event'], 'voice-provider-started')
        health.close()



if __name__ == '__main__': unittest.main()


class VoiceHealthInitializationTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_tokenizer_load_does_not_block_the_audio_loop(self):
        import asyncio
        import threading
        from unittest.mock import patch
        loop_thread = threading.get_ident()
        started, release = threading.Event(), threading.Event()
        encoding = object()
        def load(name):
            self.assertEqual(name, 'o200k_base')
            self.assertNotEqual(threading.get_ident(), loop_thread)
            started.set()
            release.wait(timeout=1)
            return encoding
        with patch('meeting_agent.voice_health.tiktoken.get_encoding', side_effect=load) as loader:
            task = asyncio.create_task(VoiceSessionHealth.create('meeting', Mock()))
            try:
                for _ in range(100):
                    if started.is_set(): break
                    await asyncio.sleep(0.001)
                self.assertTrue(started.is_set())
                self.assertFalse(task.done())
            finally:
                release.set()
            health = await task
        self.assertIs(health.encoding, encoding)
        loader.assert_called_once()
        health.close()
