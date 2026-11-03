from __future__ import annotations

import sys


def main() -> None:
    if sys.version_info < (3, 10):
        raise SystemExit(
            "ReadyMeet meeting-agent requires Python 3.10+ because LiveKit Agents Python "
            "provider-tool support and current SDK releases do not run on Python %s.%s."
            % (sys.version_info.major, sys.version_info.minor)
        )

    from meeting_agent.worker import main as worker_main

    worker_main()


if __name__ == "__main__":
    main()
