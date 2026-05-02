from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(UTC)


class RunStatus(StrEnum):
    pending = "pending"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


class TraceEventKind(StrEnum):
    """Gemini CLI stream-json event kinds, plus an asor-internal `status` kind."""

    init = "init"
    message = "message"
    tool_use = "tool_use"
    tool_result = "tool_result"
    error = "error"
    result = "result"
    status = "status"


class Task(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    prompt: str
    created_at: datetime = Field(default_factory=_utcnow)


class AgentInvocation(BaseModel):
    """Hint to the runner about which subagent to favor; Gemini CLI may still pick others."""

    subagent: str | None = None
    extensions: list[str] = Field(default_factory=list)
    model: str | None = None


class Run(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    task_id: UUID
    parent_run_id: UUID | None = None
    status: RunStatus = RunStatus.pending
    invocation: AgentInvocation = Field(default_factory=AgentInvocation)
    session_id: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    final_text: str | None = None
    error: str | None = None


class TraceEvent(BaseModel):
    """A single event emitted during a run. Wraps Gemini CLI JSONL events plus asor metadata."""

    run_id: UUID
    seq: int
    kind: TraceEventKind
    payload: dict[str, Any] = Field(default_factory=dict)
    at: datetime = Field(default_factory=_utcnow)
