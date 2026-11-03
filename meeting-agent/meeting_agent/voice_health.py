"""Content-free GPT-Live diagnostics and bounded context delivery.

SDK events: https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/
Wire acknowledgements: https://developers.openai.com/api/docs/guides/live-conversations
"""
from __future__ import annotations

import logging
import asyncio
import json
import time
import uuid
from collections import deque
from typing import Any, Callable

import tiktoken
from livekit.plugins.openai.realtime import GPTLiveModel

LOGGER = logging.getLogger("readymeet.voice_health")


class ContextBackpressure(Exception):
    """The last context append is still awaiting provider acknowledgement."""


class ObservedGPTLiveModel(GPTLiveModel):
    def __init__(self, *, monitor: VoiceSessionHealth, **kwargs: Any):
        self.monitor = monitor
        super().__init__(**kwargs)

    def session(self):
        session = super().session()
        # Synchronous: register before the SDK task connects or sends startup history.
        self.monitor.attach(session)
        return session


class VoiceSessionHealth:
    APPEND_TIMEOUT_SECONDS = 60
    MAX_PENDING_APPENDS = 8
    MAX_PENDING_TOKENS = 2400

    @classmethod
    async def create(cls, meeting_id: str, on_failure: Callable[[str], None]):
        # First use loads/decodes the BPE vocabulary. Do not do that on the
        # active audio loop (231 ms in the observed voice-mode activation).
        encoding = await asyncio.to_thread(tiktoken.get_encoding, 'o200k_base')
        return cls(meeting_id, on_failure, encoding=encoding)

    def __init__(self, meeting_id: str, on_failure: Callable[[str], None], *,
                 clock: Callable[[], float] = time.monotonic, emit: Callable[[dict], None] | None = None,
                 encoding: tiktoken.Encoding | None = None):
        self.meeting_id = meeting_id
        self.run_id = str(uuid.uuid4())
        self.clock = clock
        self.started = clock()
        self.on_failure = on_failure
        self.emit = emit or (lambda event: LOGGER.info("Voice session health %s", json.dumps(event)))
        self.encoding = encoding if encoding is not None else tiktoken.get_encoding('o200k_base')
        self.duplex = None
        self.provider_session_id = None
        self.pending: dict[str, tuple[float, int]] = {}
        self.retired_context_ids: set[str] = set()
        self.capacity_changed = asyncio.Event()
        self.context_disabled = False
        self.context_disable_reason = None
        self._context_errors_to_ignore = 0
        self.failed = False
        self.closed = False
        self.reconnects = 0
        self.errors: deque[float] = deque()
        self.sent = 0
        self.acknowledged = 0
        self.first_audio = False
        self.first_input = False

    def log(self, event: str, **fields: Any) -> None:
        self.emit(dict(event=event, meetingId=self.meeting_id, voiceRunId=self.run_id,
                       providerSessionId=self.provider_session_id,
                       elapsedMs=round((self.clock() - self.started) * 1000), **fields))

    def attach(self, duplex: Any) -> None:
        self.duplex = duplex
        duplex.on('openai_server_event_received', self.server_event)
        duplex.on('openai_client_event_queued', self.client_event)
        duplex.on('session_reconnected', self.reconnected)
        duplex.on('error', self.model_error)

    def stop(self, reason: str) -> None:
        if self.failed or self.closed:
            return
        self.failed = True
        self.log('voice-session-failed', reason=reason, reconnects=self.reconnects,
                 contextQueued=self.sent, contextAcknowledged=self.acknowledged)
        self.on_failure(reason)

    def client_event(self, event: Any) -> None:
        if self.closed:
            return
        if not isinstance(event, dict):
            event = event.model_dump()
        if event.get('type') == 'session.start':
            config = event.get('session') or {}
            items = config.get('input') or []
            text = '\n'.join(str(part.get('text', '')) for item in items for part in item.get('content', []))
            self.log('voice-provider-start-queued', historyMessages=len(items),
                     historyTokens=len(self.encoding.encode(text, disallowed_special=())))

    def server_event(self, event: dict) -> None:
        if self.closed:
            return
        kind = event.get('type')
        if kind == 'session.started':
            self.provider_session_id = (event.get('session') or {}).get('id')
            self.log('voice-provider-started')
        elif kind == 'session.input_transcript.delta' and not self.first_input:
            self.first_input = True
            self.log('voice-first-input-transcript')
        elif kind == 'session.output_audio.delta' and not self.first_audio:
            self.first_audio = True
            self.log('voice-first-audio')
        elif kind == 'session.thinking.appended' and event.get('client_event_id') in self.pending:
            event_id = event['client_event_id']
            queued_at, _ = self.pending.pop(event_id)
            self.acknowledged += 1
            self.log('voice-context-acknowledged', appendId=event_id,
                     acknowledgementMs=round((self.clock() - queued_at) * 1000))
            self.capacity_changed.set()
        elif kind == 'error':
            error = event.get('error') or {}
            # Messages, prompts, tool arguments and audio never enter these logs.
            code = error.get('code')
            matches_pending = error.get('client_event_id') in self.pending
            matches_retired = error.get('client_event_id') in self.retired_context_ids
            known = {'content_filter', 'context_injection_incomplete', 'session_finalization_failed',
                     'rate_limit_exceeded', 'invalid_request_error', 'server_error', 'session_expired'}
            self.log('voice-provider-error', code=code if code in known else 'other',
                     pendingContext=bool(self.pending), contextQueued=self.sent,
                     contextAcknowledged=self.acknowledged,
                     pendingAppendId=error.get('client_event_id') if matches_pending else None,
                     errorMatchesPending=matches_pending)
            if code in {'content_filter', 'context_injection_incomplete'}:
                # Do not replay moderated input or switch providers to bypass moderation.
                self.stop(code)
            elif matches_pending or matches_retired:
                # A rejected optional context append must not leave a dead slot or
                # replay forever. Keep live audio and authoritative transcript tools.
                self._context_errors_to_ignore += 1
                self.disable_context('context_rejected')
                self.retired_context_ids.discard(error.get('client_event_id'))
        elif kind == 'session.closed':
            reason = event.get('reason')
            self.log('voice-provider-closed', reason=reason if reason in {
                'close_requested', 'expired', 'content', 'remote_hangup', 'connection_lost'} else 'other')
            if reason == 'content':
                self.stop('content_filter')

    def model_error(self, event: Any) -> None:
        if self.closed or self.failed:
            return
        if self._context_errors_to_ignore and getattr(event, 'recoverable', False):
            self._context_errors_to_ignore -= 1
            return  # SDK emits this immediately after the corresponding raw rejection.
        now = self.clock()
        self.errors.append(now)
        while self.errors and self.errors[0] < now - 30:
            self.errors.popleft()
        self.log('voice-model-error', recoverable=bool(getattr(event, 'recoverable', False)),
                 errorsInWindow=len(self.errors))
        # The SDK owns retry exhaustion; recoverable errors are diagnostic only.
        if not getattr(event, 'recoverable', False):
            self.stop('model_unavailable')

    def reconnected(self, *_: Any) -> None:
        if self.closed:
            return
        self.reconnects += 1
        self.log('voice-reconnected', pendingContext=bool(self.pending), reconnects=self.reconnects)
        # TranscriptContext owns the bounded replay; old acknowledgements cannot release new work.
        self.pending.clear()
        self.retired_context_ids.clear()
        self._context_errors_to_ignore = 0
        if self.context_disabled and not self.failed:
            self.context_disabled = False
            self.context_disable_reason = None
            self.log("voice-context-resumed")
        self.capacity_changed.set()
        self.provider_session_id = None

    def append(self, text: str) -> None:
        self.tick()
        if self.closed or self.failed or self.context_disabled:
            raise ContextBackpressure()
        tokens = len(self.encoding.encode(text, disallowed_special=()))
        if tokens > 500:
            self.stop('context_payload_too_large')
            raise ContextBackpressure()
        if (len(self.pending) >= self.MAX_PENDING_APPENDS or
                sum(item[1] for item in self.pending.values()) + tokens > self.MAX_PENDING_TOKENS):
            raise ContextBackpressure()
        event_id = 'ready_context_' + uuid.uuid4().hex
        self.pending[event_id] = (self.clock(), tokens)
        try:
            self.duplex.send_event(dict(type='session.thinking.append', event_id=event_id,
                                        delegation_id=None, content=text))
        except Exception:
            self.disable_context('context_send_failed')
            raise ContextBackpressure() from None
        self.sent += 1
        self.log('voice-context-queued', appendId=event_id, tokens=tokens)

    def tick(self) -> None:
        if self.pending and self.clock() - min(value[0] for value in self.pending.values()) >= self.APPEND_TIMEOUT_SECONDS:
            self.disable_context('context_delivery_timeout')

    def disable_context(self, reason: str) -> None:
        if self.context_disabled:
            return
        self.context_disable_reason = reason
        self.log('voice-context-disabled', reason=reason, pendingAppends=len(self.pending))
        self.context_disabled = True
        self.retired_context_ids.update(self.pending)
        self.pending.clear()
        self.capacity_changed.set()

    async def flush_until_poll(self, context: Any, delay: float) -> None:
        """ACKs release queued work immediately without increasing database polling."""
        deadline = asyncio.get_running_loop().time() + delay
        while not (self.failed or self.closed or self.context_disabled):
            self.tick()
            self.capacity_changed.clear()
            try:
                context.deliver([], self.append)
            except ContextBackpressure:
                pass
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0 or self.context_disabled:
                return
            try:
                await asyncio.wait_for(self.capacity_changed.wait(), timeout=remaining)
            except TimeoutError:
                return

    def close(self) -> None:
        self.closed = True
        if self.duplex:
            for name, callback in [('openai_server_event_received', self.server_event),
                                   ('openai_client_event_queued', self.client_event),
                                   ('session_reconnected', self.reconnected), ('error', self.model_error)]:
                self.duplex.off(name, callback)
        self.pending.clear()
        self.retired_context_ids.clear()
        self.capacity_changed.set()
