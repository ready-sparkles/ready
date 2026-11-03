#!/bin/sh

set -eu

supports_required_version() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

if [ -x ".venv/bin/python3" ] && supports_required_version ".venv/bin/python3"; then
  exec ".venv/bin/python3" "$@"
fi

for candidate in python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && supports_required_version "$candidate"; then
    exec "$candidate" "$@"
  fi
done

echo "ReadyMeet meeting-agent requires Python 3.10+" >&2
exit 1
