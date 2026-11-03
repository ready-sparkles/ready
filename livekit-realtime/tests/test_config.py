from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.config import _load_env  # noqa: E402


class LiveKitRealtimeConfigTests(unittest.TestCase):
    def test_env_files_load_from_the_workspace_root_then_the_service(self) -> None:
        with patch("app.config.load_dotenv") as load_dotenv:
            _load_env()

        root_dir = SERVICE_ROOT
        for parent in SERVICE_ROOT.parents:
            if (parent / "pnpm-workspace.yaml").exists():
                root_dir = parent
                break

        self.assertNotEqual(root_dir, SERVICE_ROOT)
        self.assertEqual(
            [call.args[0] for call in load_dotenv.call_args_list],
            [root_dir / ".env", SERVICE_ROOT / ".env"],
        )
        self.assertEqual(load_dotenv.call_args_list[1].kwargs, {"override": True})


if __name__ == "__main__":
    unittest.main()
