#!/usr/bin/env python3
"""asor agent-runner entrypoint.

Reads a task spec from env vars, invokes Gemini CLI in headless streaming-JSON mode,
and POSTs each JSONL event to the orchestrator's callback URL.

Auth: Vertex AI via ADC. The runner expects the host's ADC json mounted at
GOOGLE_APPLICATION_CREDENTIALS, plus GOOGLE_GENAI_USE_VERTEXAI=true,
GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION. GEMINI_API_KEY / GOOGLE_API_KEY
must NOT be set — they take precedence over ADC.

Env vars:
  ASOR_RUN_ID                    UUID of the run (required)
  ASOR_PROMPT                    Prompt text to feed Gemini CLI (required)
  ASOR_CALLBACK_URL              URL to POST events to (required)
  ASOR_MODEL                     Optional model alias (auto, pro, flash, flash-lite)
  ASOR_EXTENSIONS                Optional comma-separated extension names
  GOOGLE_GENAI_USE_VERTEXAI      Required: "true"
  GOOGLE_CLOUD_PROJECT           Required: GCP project id
  GOOGLE_CLOUD_LOCATION          Required: e.g. "us-central1"
  GOOGLE_APPLICATION_CREDENTIALS Required: path to ADC json inside the container
"""

from __future__ import annotations

import json
import os
import pty
import queue
import shutil
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime

import httpx


def _env(name: str, *, required: bool = True, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        print(f"[asor-runner] missing required env var {name}", file=sys.stderr)
        sys.exit(2)
    return value or ""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _post_event(
    client: httpx.Client, callback_url: str, run_id: str, seq: int, payload: dict
) -> None:
    kind = payload.get("type") or "message"
    body = {
        "run_id": run_id,
        "seq": seq,
        "kind": kind,
        "payload": payload,
        "at": _now_iso(),
    }
    try:
        client.post(callback_url, json=body, timeout=10.0)
    except httpx.HTTPError as exc:
        print(f"[asor-runner] callback failed seq={seq}: {exc}", file=sys.stderr)


def _reader_fd(fd: int, lines: queue.Queue[str]) -> None:
    with os.fdopen(fd, "r", encoding="utf-8", errors="replace") as pipe:
        for line in pipe:
            lines.put(line)


def _ensure_checkpointing_enabled() -> bool:
    gemini_dir = os.path.expanduser("~/.gemini")
    settings_path = os.path.join(gemini_dir, "settings.json")
    os.makedirs(gemini_dir, exist_ok=True)
    settings: dict = {}
    if os.path.exists(settings_path):
        try:
            with open(settings_path, encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    settings = loaded
        except (OSError, json.JSONDecodeError):
            settings = {}
    general = settings.setdefault("general", {})
    checkpointing = general.setdefault("checkpointing", {})
    enabled = shutil.which("git") is not None
    checkpointing["enabled"] = enabled
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
    return enabled


def main() -> int:
    run_id = _env("ASOR_RUN_ID")
    prompt = _env("ASOR_PROMPT")
    callback_url = _env("ASOR_CALLBACK_URL")
    # The model alias `auto` resolves to a preview model that isn't available in
    # every Vertex region (e.g. europe-west4 / global). The orchestrator passes
    # an explicit model in ASOR_MODEL — fall back to `flash` if it doesn't.
    model = _env("ASOR_MODEL", required=False, default="flash")
    if model == "auto":
        model = "flash"
    extensions = _env("ASOR_EXTENSIONS", required=False, default="")
    timeout_seconds = int(_env("ASOR_RUNNER_TIMEOUT_SECONDS", required=False, default="180"))
    resume_session_id = _env("ASOR_RESUME_SESSION_ID", required=False, default="")
    checkpointing_enabled = _ensure_checkpointing_enabled()

    # Sanity-check Vertex/ADC auth so we fail loudly with a clear status event
    # instead of letting Gemini CLI bail with a cryptic prompt.
    for required_auth in (
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
    ):
        if not os.environ.get(required_auth):
            print(f"[asor-runner] missing auth env var {required_auth}", file=sys.stderr)
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        # Strip them — they would otherwise override ADC.
        os.environ.pop("GEMINI_API_KEY", None)
        os.environ.pop("GOOGLE_API_KEY", None)

    cmd = [
        "stdbuf",
        "-oL",
        "-eL",
        "gemini",
    ]
    if resume_session_id:
        cmd.extend(["--resume", resume_session_id])
    cmd.extend(
        [
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--approval-mode",
            "yolo",
            "--skip-trust",
            "--model",
            model,
        ]
    )
    if extensions:
        cmd.extend(["--extensions", extensions])

    print(f"[asor-runner] launching: {' '.join(cmd[:6])} ...", file=sys.stderr)

    seq = 1
    with httpx.Client() as client:
        _post_event(
            client,
            callback_url,
            run_id,
            seq,
            {
                "type": "status",
                "status": "started",
                "model": model,
                "resumed_session_id": resume_session_id or None,
                "checkpointing_enabled": checkpointing_enabled,
            },
        )
        seq += 1

        master_fd, slave_fd = pty.openpty()
        proc = subprocess.Popen(
            cmd,
            stdout=slave_fd,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        os.close(slave_fd)
        lines: queue.Queue[str] = queue.Queue()
        reader = threading.Thread(target=_reader_fd, args=(master_fd, lines), daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout_seconds

        while True:
            if proc.poll() is not None and lines.empty():
                break
            if time.monotonic() > deadline:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                stderr_tail = (proc.stderr.read() if proc.stderr else "")[-2000:]
                timeout_status = {
                    "type": "status",
                    "status": "failed",
                    "exit_code": proc.returncode,
                    "stderr_tail": (
                        f"Gemini CLI timed out after {timeout_seconds}s without completing.\n"
                        + stderr_tail
                    )[-2000:],
                }
                _post_event(client, callback_url, run_id, seq, timeout_status)
                return 1
            try:
                line = lines.get(timeout=1)
            except queue.Empty:
                continue
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                payload = {"type": "message", "raw": line}
            _post_event(client, callback_url, run_id, seq, payload)
            seq += 1

        rc = proc.wait()
        stderr_tail = (proc.stderr.read() if proc.stderr else "")[-2000:]
        terminal = {
            "type": "status",
            "status": "succeeded" if rc == 0 else "failed",
            "exit_code": rc,
        }
        if rc != 0 and stderr_tail:
            terminal["stderr_tail"] = stderr_tail
        _post_event(client, callback_url, run_id, seq, terminal)

    return 0 if rc == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
