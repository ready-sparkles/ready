"""Exercise the actual debug logger without importing network/voice SDKs."""
from __future__ import annotations

import ast
import asyncio
import logging
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from typing import Any, Dict, Optional


class PrivateLoggingTests(unittest.TestCase):
    def test_debug_event_keeps_no_transcript_query_or_error_payload(self):
        source_path = Path(__file__).resolve().parents[1] / "meeting_agent" / "worker.py"
        module = ast.parse(source_path.read_text())
        logger_function = next(node for node in module.body
                               if isinstance(node, ast.AsyncFunctionDef) and node.name == "log_assistant_debug")
        stream = StringIO()
        logger = logging.Logger("private-logging-test", logging.INFO)
        logger.addHandler(logging.StreamHandler(stream))
        with tempfile.TemporaryDirectory() as directory:
            debug_path = Path(directory) / "debug.log"
            namespace = {"LOGGER": logger, "Optional": Optional, "Dict": Dict, "Any": Any,
                         "SETTINGS": type("Settings", (), {"debug_log_path": str(debug_path)})()}
            exec(compile(ast.Module(body=[logger_function], type_ignores=[]), str(source_path), "exec"), namespace)
            sentinel = "PRIVATE-transcript-query-provider-output"
            asyncio.run(namespace["log_assistant_debug"]("user-input-transcribed", {
                "transcript": sentinel, "query": sentinel, "error": sentinel,
                "finalTranscript": sentinel, "nested": {"content": sentinel}}))
            self.assertNotIn(sentinel, stream.getvalue())
            self.assertIn("user-input-transcribed", stream.getvalue())
            self.assertFalse(debug_path.exists())


if __name__ == "__main__":
    unittest.main()
