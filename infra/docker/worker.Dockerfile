FROM python:3.11-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY pyproject.toml uv.lock* ./
COPY packages/core /app/packages/core
COPY apps/worker /app/apps/worker

ENV UV_HTTP_TIMEOUT=180

RUN uv sync --package asor-worker --no-dev --no-install-workspace

ENV PATH="/app/.venv/bin:${PATH}"
ENV PYTHONPATH="/app/apps/worker:/app/packages/core"

CMD ["python", "-m", "asor_worker.main"]
