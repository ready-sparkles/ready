from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from typing import TextIO


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }

        if record.exc_info:
            payload["exceptionType"] = record.exc_info[0].__name__ if record.exc_info[0] else "Exception"

        for key, value in record.__dict__.items():
            if key.startswith("_") or key in {
                "args",
                "created",
                "exc_info",
                "exc_text",
                "filename",
                "funcName",
                "levelname",
                "levelno",
                "lineno",
                "module",
                "msecs",
                "message",
                "msg",
                "name",
                "pathname",
                "process",
                "processName",
                "relativeCreated",
                "stack_info",
                "thread",
                "threadName",
            }:
                continue

            # Provider errors can contain transcript fragments or request bodies.
            if key.lower() in {"error", "exception", "transcript", "finaltranscript", "query", "content", "payload", "result", "text"}:
                payload[key] = "[private content omitted]"
            else:
                payload[key] = value

        return json.dumps(payload, default=str)


class _BelowWarningFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno < logging.WARNING


def build_railway_log_handlers(
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> list[logging.Handler]:
    formatter = JsonFormatter()
    stdout_handler = logging.StreamHandler(stdout if stdout is not None else sys.stdout)
    stdout_handler.setLevel(logging.INFO)
    stdout_handler.addFilter(_BelowWarningFilter())
    stdout_handler.setFormatter(formatter)

    stderr_handler = logging.StreamHandler(stderr if stderr is not None else sys.stderr)
    stderr_handler.setLevel(logging.WARNING)
    stderr_handler.setFormatter(formatter)
    return [stdout_handler, stderr_handler]


def configure_logging(
    *,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> None:
    handlers = build_railway_log_handlers(stdout=stdout, stderr=stderr)

    root = logging.getLogger()
    root.handlers.clear()
    root.handlers.extend(handlers)
    root.setLevel(logging.INFO)

    # Uvicorn installs stderr handlers before importing the application. Route
    # its loggers through the root handlers so routine lifecycle and access
    # messages are not misclassified as errors by Railway.
    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(logger_name)
        logger.handlers.clear()
        logger.setLevel(logging.NOTSET)
        logger.propagate = True


def sanitize_for_logs(value: str, *, keep: int = 6) -> str:
    if len(value) <= keep:
        return "***"
    return f"{value[:keep]}***"
