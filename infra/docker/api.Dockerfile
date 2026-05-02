FROM python:3.11-slim

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY pyproject.toml uv.lock* ./
COPY packages/core /app/packages/core
COPY apps/api /app/apps/api

ENV UV_HTTP_TIMEOUT=180

RUN uv sync --package asor-api --no-dev

ENV PATH="/app/.venv/bin:${PATH}"

EXPOSE 8000

CMD ["uvicorn", "asor_api.app:app", "--host", "0.0.0.0", "--port", "8000"]
