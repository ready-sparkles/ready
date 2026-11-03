from __future__ import annotations

from collections import defaultdict
from threading import Lock


METRIC_METADATA: dict[str, tuple[str, str]] = {
    "readymeet_livekit_realtime_service_ready": (
        "gauge",
        "Whether the LiveKit realtime service is ready to accept traffic.",
    ),
    "readymeet_livekit_realtime_active_sessions": (
        "gauge",
        "Number of active meeting sessions currently managed by the realtime service.",
    ),
    "readymeet_livekit_realtime_active_track_workers": (
        "gauge",
        "Number of active per-track worker loops currently processing audio.",
    ),
    "readymeet_livekit_realtime_start_requests_total": (
        "counter",
        "Count of start-session requests grouped by outcome.",
    ),
    "readymeet_livekit_realtime_stop_requests_total": (
        "counter",
        "Count of stop-session requests grouped by outcome.",
    ),
    "readymeet_livekit_realtime_sessions_started_total": (
        "counter",
        "Total number of realtime meeting sessions started successfully.",
    ),
    "readymeet_livekit_realtime_track_workers_total": (
        "counter",
        "Total number of track worker lifecycle events grouped by action.",
    ),
    "readymeet_livekit_realtime_assistant_callbacks_total": (
        "counter",
        "Total number of assistant callback deliveries grouped by event type and outcome.",
    ),
    "readymeet_livekit_realtime_participant_suppression_total": (
        "counter",
        "Total number of participant suppression updates grouped by requested state and outcome.",
    ),
    "readymeet_livekit_realtime_track_subscription_failures_total": (
        "counter",
        "Total number of remote track subscription failures grouped by reason.",
    ),
    "readymeet_livekit_realtime_caption_publish_total": (
        "counter",
        "Caption publish attempts grouped by outcome.",
    ),
    "readymeet_livekit_realtime_caption_interims_coalesced_total": (
        "counter",
        "Obsolete interim captions replaced before publication.",
    ),
    "readymeet_livekit_realtime_caption_pending_finals_peak": (
        "gauge",
        "Process high-water mark for final captions pending in one publisher.",
    ),
    "readymeet_livekit_realtime_stt_gates_open": (
        "gauge",
        "Number of participant STT gates currently deciding 'open'. In shadow "
        "mode this is the concurrency enforcement would have produced.",
    ),
    "readymeet_livekit_realtime_stt_gates_open_peak": (
        "gauge",
        "High-water mark of concurrently open participant STT gates.",
    ),
    "readymeet_livekit_realtime_stt_streams_in_use": (
        "gauge",
        "Number of STT streams currently holding an admission slot.",
    ),
    "readymeet_livekit_realtime_stt_gate_events_total": (
        "counter",
        "Participant STT gate open/close decisions grouped by action and mode.",
    ),
    "readymeet_livekit_realtime_stt_gate_open_seconds_total": (
        "counter",
        "Cumulative seconds participant STT gates spent open, grouped by mode.",
    ),
    "readymeet_livekit_realtime_stt_stream_errors_total": (
        "counter",
        "Total number of STT stream failures grouped by reason.",
    ),
    "readymeet_livekit_realtime_stt_admission_denied_total": (
        "counter",
        "Total number of STT stream opens denied by the admission controller.",
    ),
    "readymeet_livekit_realtime_stt_prebuffer_flushed_seconds_total": (
        "counter",
        "Cumulative seconds of pre-roll audio flushed into newly opened STT streams.",
    ),
    "readymeet_livekit_realtime_stt_dropped_audio_seconds_total": (
        "counter",
        "Cumulative seconds of audio dropped because no STT stream could be opened.",
    ),
}


def _gate_mode_label(shadow: bool) -> str:
    return "shadow" if shadow else "enforced"


def _format_labels(labels: tuple[tuple[str, str], ...]) -> str:
    if not labels:
        return ""

    rendered = ",".join(f'{key}="{value}"' for key, value in labels)
    return f"{{{rendered}}}"


class RealtimeMetrics:
    def __init__(self) -> None:
        self._lock = Lock()
        self._counters: dict[str, dict[tuple[tuple[str, str], ...], float]] = defaultdict(dict)
        self._gauges: dict[str, dict[tuple[tuple[str, str], ...], float]] = defaultdict(dict)
        self._active_track_workers = 0
        self._open_stt_gates = 0
        self._peak_open_stt_gates = 0
        self._peak_pending_caption_finals = 0
        self.set_gauge("readymeet_livekit_realtime_service_ready", 0)
        self.set_gauge("readymeet_livekit_realtime_active_sessions", 0)
        self.set_gauge("readymeet_livekit_realtime_active_track_workers", 0)
        self.set_gauge("readymeet_livekit_realtime_stt_gates_open", 0)
        self.set_gauge("readymeet_livekit_realtime_stt_gates_open_peak", 0)
        self.set_gauge("readymeet_livekit_realtime_stt_streams_in_use", 0)
        self.set_gauge("readymeet_livekit_realtime_caption_pending_finals_peak", 0)

    def increment_counter(self, name: str, amount: float = 1, **labels: str) -> None:
        key = tuple(sorted((label, str(value)) for label, value in labels.items()))
        with self._lock:
            current = self._counters[name].get(key, 0.0)
            self._counters[name][key] = current + amount

    def set_gauge(self, name: str, value: float, **labels: str) -> None:
        key = tuple(sorted((label, str(value)) for label, value in labels.items()))
        with self._lock:
            self._gauges[name][key] = value

    def record_service_ready(self, ready: bool) -> None:
        self.set_gauge("readymeet_livekit_realtime_service_ready", 1 if ready else 0)

    def record_active_sessions(self, active_sessions: int) -> None:
        self.set_gauge("readymeet_livekit_realtime_active_sessions", active_sessions)

    def record_start_request(self, outcome: str) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_start_requests_total",
            outcome=outcome,
        )

    def record_stop_request(self, outcome: str) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_stop_requests_total",
            outcome=outcome,
        )

    def record_session_started(self) -> None:
        self.increment_counter("readymeet_livekit_realtime_sessions_started_total")

    def record_track_worker_started(self) -> None:
        with self._lock:
            self._active_track_workers += 1
            self._gauges["readymeet_livekit_realtime_active_track_workers"][tuple()] = (
                self._active_track_workers
            )
        self.increment_counter(
            "readymeet_livekit_realtime_track_workers_total",
            action="started",
        )

    def record_track_worker_stopped(self) -> None:
        with self._lock:
            self._active_track_workers = max(0, self._active_track_workers - 1)
            self._gauges["readymeet_livekit_realtime_active_track_workers"][tuple()] = (
                self._active_track_workers
            )
        self.increment_counter(
            "readymeet_livekit_realtime_track_workers_total",
            action="stopped",
        )

    def record_assistant_callback(self, *, event_type: str, outcome: str) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_assistant_callbacks_total",
            event_type=event_type,
            outcome=outcome,
        )

    def record_participant_suppression_update(self, *, suppressed: bool, updated: bool) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_participant_suppression_total",
            suppressed=str(suppressed).lower(),
            updated=str(updated).lower(),
        )

    def record_track_subscription_failure(self, *, reason: str) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_track_subscription_failures_total",
            reason=reason,
        )

    def record_caption_publish(self, *, outcome: str) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_caption_publish_total",
            outcome=outcome,
        )

    def record_caption_interim_coalesced(self) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_caption_interims_coalesced_total"
        )

    def record_caption_pending_finals(self, pending: int) -> None:
        with self._lock:
            self._peak_pending_caption_finals = max(
                self._peak_pending_caption_finals,
                max(0, pending),
            )
            self._gauges[
                "readymeet_livekit_realtime_caption_pending_finals_peak"
            ][tuple()] = self._peak_pending_caption_finals

    def record_stt_gate_opened(self, *, shadow: bool) -> None:
        with self._lock:
            self._open_stt_gates += 1
            self._peak_open_stt_gates = max(self._peak_open_stt_gates, self._open_stt_gates)
            self._gauges["readymeet_livekit_realtime_stt_gates_open"][tuple()] = (
                self._open_stt_gates
            )
            self._gauges["readymeet_livekit_realtime_stt_gates_open_peak"][tuple()] = (
                self._peak_open_stt_gates
            )
        self.increment_counter(
            "readymeet_livekit_realtime_stt_gate_events_total",
            action="opened",
            mode=_gate_mode_label(shadow),
        )

    def record_stt_gate_closed(self, *, shadow: bool, open_seconds: float) -> None:
        with self._lock:
            self._open_stt_gates = max(0, self._open_stt_gates - 1)
            self._gauges["readymeet_livekit_realtime_stt_gates_open"][tuple()] = (
                self._open_stt_gates
            )
        self.increment_counter(
            "readymeet_livekit_realtime_stt_gate_events_total",
            action="closed",
            mode=_gate_mode_label(shadow),
        )
        self.increment_counter(
            "readymeet_livekit_realtime_stt_gate_open_seconds_total",
            amount=max(0.0, open_seconds),
            mode=_gate_mode_label(shadow),
        )

    def record_stt_streams_in_use(self, in_use: int) -> None:
        self.set_gauge("readymeet_livekit_realtime_stt_streams_in_use", in_use)

    def record_stt_stream_error(self, *, reason: str) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_stt_stream_errors_total",
            reason=reason,
        )

    def record_stt_admission_denied(self) -> None:
        self.increment_counter("readymeet_livekit_realtime_stt_admission_denied_total")

    def record_stt_prebuffer_flush(self, *, seconds: float) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_stt_prebuffer_flushed_seconds_total",
            amount=max(0.0, seconds),
        )

    def record_stt_dropped_audio(self, *, seconds: float) -> None:
        self.increment_counter(
            "readymeet_livekit_realtime_stt_dropped_audio_seconds_total",
            amount=max(0.0, seconds),
        )

    def render_prometheus(self) -> str:
        lines: list[str] = []
        with self._lock:
            counters = {name: dict(samples) for name, samples in self._counters.items()}
            gauges = {name: dict(samples) for name, samples in self._gauges.items()}

        for name, (metric_type, help_text) in METRIC_METADATA.items():
            lines.append(f"# HELP {name} {help_text}")
            lines.append(f"# TYPE {name} {metric_type}")
            source = gauges if metric_type == "gauge" else counters
            for labels, value in sorted(source.get(name, {}).items()):
                rendered_value = int(value) if float(value).is_integer() else value
                lines.append(f"{name}{_format_labels(labels)} {rendered_value}")

        return "\n".join(lines) + "\n"
