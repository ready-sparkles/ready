import re
import unittest
from pathlib import Path

# Anonymization placeholders such as "Personbd" belong in test fixtures only.
# Runtime prompts and tool descriptions are read by the model and must use real words.
PLACEHOLDER_NAME = re.compile(r"\bPerson[a-z]{2}\b")
ALLOWED_WORDS = {"Personal"}
REPO_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_DIRS = (
    REPO_ROOT / "meeting-agent" / "meeting_agent",
    REPO_ROOT / "livekit-realtime" / "app",
)


class RuntimePromptPlaceholderTests(unittest.TestCase):
    def test_runtime_sources_contain_no_anonymization_placeholders(self) -> None:
        offenders = []
        for directory in RUNTIME_DIRS:
            for path in sorted(directory.rglob("*.py")):
                for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                    for match in PLACEHOLDER_NAME.findall(line):
                        if match not in ALLOWED_WORDS:
                            offenders.append(f"{path.relative_to(REPO_ROOT)}:{line_number}: {match}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
