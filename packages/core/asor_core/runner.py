from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from asor_core.models import AgentInvocation, Task, TraceEvent


class RunnerSpec:
    """Inputs needed to launch one Gemini CLI run."""

    def __init__(
        self,
        task: Task,
        invocation: AgentInvocation,
        api_base_url: str,
        callback_url: str,
    ) -> None:
        self.task = task
        self.invocation = invocation
        self.api_base_url = api_base_url
        self.callback_url = callback_url


class AgentRunner(Protocol):
    """Launches a Gemini CLI process and streams its events back as TraceEvents.

    Two impls are planned:
    - DockerAgentRunner (local dev): `docker run` of apps/agent-runner.
    - CloudRunAgentRunner (prod):    Cloud Run job invocation.
    """

    async def run(self, spec: RunnerSpec) -> AsyncIterator[TraceEvent]: ...
