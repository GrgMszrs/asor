"""In-memory store for v0.1. Postgres-backed impl lands in Phase 2."""

from __future__ import annotations

import asyncio
from collections import defaultdict
from uuid import UUID

from asor_core import Run, Task, TraceEvent


class MemoryStore:
    def __init__(self) -> None:
        self._tasks: dict[UUID, Task] = {}
        self._runs: dict[UUID, Run] = {}
        self._events: dict[UUID, list[TraceEvent]] = defaultdict(list)
        self._subscribers: dict[UUID, list[asyncio.Queue[TraceEvent]]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def add_task(self, task: Task) -> None:
        async with self._lock:
            self._tasks[task.id] = task

    async def add_run(self, run: Run) -> None:
        async with self._lock:
            self._runs[run.id] = run

    async def update_run(self, run: Run) -> None:
        async with self._lock:
            self._runs[run.id] = run

    async def get_run(self, run_id: UUID) -> Run | None:
        return self._runs.get(run_id)

    async def list_runs(self) -> list[Run]:
        return list(self._runs.values())

    async def append_event(self, event: TraceEvent) -> None:
        async with self._lock:
            self._events[event.run_id].append(event)
            subs = list(self._subscribers[event.run_id])
        for queue in subs:
            await queue.put(event)

    async def events_for(self, run_id: UUID) -> list[TraceEvent]:
        return list(self._events.get(run_id, []))

    def subscribe(self, run_id: UUID) -> asyncio.Queue[TraceEvent]:
        queue: asyncio.Queue[TraceEvent] = asyncio.Queue()
        self._subscribers[run_id].append(queue)
        return queue

    def unsubscribe(self, run_id: UUID, queue: asyncio.Queue[TraceEvent]) -> None:
        if queue in self._subscribers[run_id]:
            self._subscribers[run_id].remove(queue)


store = MemoryStore()
