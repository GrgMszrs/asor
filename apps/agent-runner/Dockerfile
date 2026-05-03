FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @google/gemini-cli@latest

WORKDIR /workspace

COPY entrypoint.py /usr/local/bin/asor-runner
RUN chmod +x /usr/local/bin/asor-runner \
    && python3 -m venv /opt/runner-venv \
    && /opt/runner-venv/bin/pip install --no-cache-dir pika==1.3.*

ENV PATH="/opt/runner-venv/bin:${PATH}"

ENTRYPOINT ["python3", "/usr/local/bin/asor-runner"]
