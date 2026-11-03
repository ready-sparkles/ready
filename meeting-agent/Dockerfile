FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/home/app \
    XDG_CACHE_HOME=/home/app/.cache \
    TIKTOKEN_CACHE_DIR=/app/.cache/tiktoken

WORKDIR /app

COPY requirements.txt ./
RUN python -m venv .venv \
    && .venv/bin/python -m pip install --upgrade pip \
    && .venv/bin/python -m pip install -r requirements.txt \
    && .venv/bin/python -c "import tiktoken; tiktoken.get_encoding('o200k_base')"

COPY meeting_agent ./meeting_agent
COPY run.py ./

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app \
    && install -d -o app -g app /home/app/.cache \
    && chown -R app:app /app/.cache/tiktoken

USER app:app

CMD [".venv/bin/python", "run.py", "start"]
