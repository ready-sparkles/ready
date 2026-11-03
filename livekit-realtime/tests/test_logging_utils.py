from __future__ import annotations

import logging
import sys
import unittest
from io import StringIO
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.logging_utils import JsonFormatter, configure_logging  # noqa: E402


class RailwayLoggingTests(unittest.TestCase):
    def test_provider_errors_do_not_store_private_text(self) -> None:
        secret = "PRIVATE transcript provider response"
        try:
            raise ValueError(secret)
        except ValueError:
            record = logging.LogRecord("readymeet", logging.ERROR, __file__, 1,
                                       "provider-failed", (), sys.exc_info())
        record.error = secret
        record.transcript = secret
        result = JsonFormatter().format(record)
        self.assertNotIn(secret, result)
        self.assertIn("ValueError", result)

    def test_routine_application_and_uvicorn_logs_stay_off_stderr(self) -> None:
        stdout = StringIO()
        stderr = StringIO()
        logger_names = ("", "uvicorn", "uvicorn.error", "uvicorn.access")
        original_state = {
            name: (
                list(logging.getLogger(name).handlers),
                logging.getLogger(name).level,
                logging.getLogger(name).propagate,
            )
            for name in logger_names
        }

        try:
            configure_logging(stdout=stdout, stderr=stderr)
            application_logger = logging.getLogger("readymeet.livekit_realtime.logging-test")
            uvicorn_logger = logging.getLogger("uvicorn.error")

            application_logger.info("healthy-session")
            uvicorn_logger.info("application-startup-complete")
            application_logger.warning("degraded-session")
            uvicorn_logger.error("server-failed")

            for handler in logging.getLogger().handlers:
                handler.flush()

            stdout_text = stdout.getvalue()
            stderr_text = stderr.getvalue()
            self.assertIn("healthy-session", stdout_text)
            self.assertIn("application-startup-complete", stdout_text)
            self.assertNotIn("degraded-session", stdout_text)
            self.assertNotIn("server-failed", stdout_text)
            self.assertIn("degraded-session", stderr_text)
            self.assertIn("server-failed", stderr_text)
            self.assertNotIn("healthy-session", stderr_text)
            self.assertNotIn("application-startup-complete", stderr_text)
        finally:
            for name, (handlers, level, propagate) in original_state.items():
                logger = logging.getLogger(name)
                logger.handlers = handlers
                logger.setLevel(level)
                logger.propagate = propagate


if __name__ == "__main__":
    unittest.main()
