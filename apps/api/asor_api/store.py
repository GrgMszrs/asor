"""Run/task/event stores.

The API keeps SSE subscribers in process, but durable state belongs in Postgres
when DATABASE_URL is configured.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, Protocol
from uuid import UUID

import psycopg
from asor_core import AgentInvocation, Run, RunStatus, Task, TraceEvent, TraceEventKind
from psycopg.types.json import Jsonb


class Store(Protocol):
    async def init(self) -> None: ...
    async def add_task(self, task: Task) -> None: ...
    async def add_run(self, run: Run) -> None: ...
    async def update_run(self, run: Run) -> None: ...
    async def get_run(self, run_id: UUID) -> Run | None: ...
    async def list_runs(self) -> list[Run]: ...
    async def append_event(self, event: TraceEvent) -> None: ...
    async def events_for(self, run_id: UUID) -> list[TraceEvent]: ...
    async def conversation_events_for(self, run_id: UUID) -> list[TraceEvent]: ...
    def subscribe(self, run_id: UUID) -> asyncio.Queue[TraceEvent]: ...
    def unsubscribe(self, run_id: UUID, queue: asyncio.Queue[TraceEvent]) -> None: ...


class SubscriberMixin:
    def __init__(self) -> None:
        self._subscribers: dict[UUID, list[asyncio.Queue[TraceEvent]]] = defaultdict(list)

    def subscribe(self, run_id: UUID) -> asyncio.Queue[TraceEvent]:
        queue: asyncio.Queue[TraceEvent] = asyncio.Queue()
        self._subscribers[run_id].append(queue)
        return queue

    def unsubscribe(self, run_id: UUID, queue: asyncio.Queue[TraceEvent]) -> None:
        if queue in self._subscribers[run_id]:
            self._subscribers[run_id].remove(queue)

    async def _publish(self, event: TraceEvent) -> None:
        for queue in list(self._subscribers[event.run_id]):
            await queue.put(event)


class MemoryStore(SubscriberMixin):
    def __init__(self) -> None:
        super().__init__()
        self._tasks: dict[UUID, Task] = {}
        self._runs: dict[UUID, Run] = {}
        self._events: dict[UUID, list[TraceEvent]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def init(self) -> None:
        return None

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
            existing = self._events[event.run_id]
            if any(e.seq == event.seq for e in existing):
                return
            existing.append(event)
            existing.sort(key=lambda e: e.seq)
        await self._publish(event)

    async def events_for(self, run_id: UUID) -> list[TraceEvent]:
        return list(self._events.get(run_id, []))

    async def conversation_events_for(self, run_id: UUID) -> list[TraceEvent]:
        chain: list[UUID] = []
        current = await self.get_run(run_id)
        while current is not None:
            chain.append(current.id)
            if current.parent_run_id is None:
                break
            current = await self.get_run(current.parent_run_id)
        events: list[TraceEvent] = []
        for chained_run_id in reversed(chain):
            events.extend(await self.events_for(chained_run_id))
        return events


class PostgresStore(SubscriberMixin):
    def __init__(self, database_url: str) -> None:
        super().__init__()
        self._database_url = database_url.replace("postgresql+psycopg://", "postgresql://", 1)

    async def init(self) -> None:
        async with await self._connect() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS tasks (
                    id uuid PRIMARY KEY,
                    prompt text NOT NULL,
                    created_at timestamptz NOT NULL
                )
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS runs (
                    id uuid PRIMARY KEY,
                    task_id uuid NOT NULL REFERENCES tasks(id),
                    parent_run_id uuid REFERENCES runs(id),
                    status text NOT NULL,
                    invocation jsonb NOT NULL,
                    session_id text,
                    started_at timestamptz,
                    finished_at timestamptz,
                    final_text text,
                    error text
                )
                """
            )
            await conn.execute("ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_run_id uuid")
            await conn.execute("ALTER TABLE runs ADD COLUMN IF NOT EXISTS session_id text")
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    seq integer NOT NULL,
                    kind text NOT NULL,
                    payload jsonb NOT NULL,
                    at timestamptz NOT NULL,
                    PRIMARY KEY (run_id, seq)
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC)"
            )

    async def _connect(self) -> psycopg.AsyncConnection[Any]:
        return await psycopg.AsyncConnection.connect(self._database_url)

    async def add_task(self, task: Task) -> None:
        async with await self._connect() as conn:
            await conn.execute(
                """
                INSERT INTO tasks (id, prompt, created_at)
                VALUES (%s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET prompt = EXCLUDED.prompt, created_at = EXCLUDED.created_at
                """,
                (task.id, task.prompt, task.created_at),
            )

    async def add_run(self, run: Run) -> None:
        async with await self._connect() as conn:
            await conn.execute(
                """
                INSERT INTO runs (
                    id, task_id, parent_run_id, status, invocation, session_id,
                    started_at, finished_at, final_text, error
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE
                SET task_id = EXCLUDED.task_id,
                    parent_run_id = EXCLUDED.parent_run_id,
                    status = EXCLUDED.status,
                    invocation = EXCLUDED.invocation,
                    session_id = EXCLUDED.session_id,
                    started_at = EXCLUDED.started_at,
                    finished_at = EXCLUDED.finished_at,
                    final_text = EXCLUDED.final_text,
                    error = EXCLUDED.error
                """,
                (
                    run.id,
                    run.task_id,
                    run.parent_run_id,
                    run.status.value,
                    Jsonb(run.invocation.model_dump(mode="json")),
                    run.session_id,
                    run.started_at,
                    run.finished_at,
                    run.final_text,
                    run.error,
                ),
            )

    async def update_run(self, run: Run) -> None:
        async with await self._connect() as conn:
            await conn.execute(
                """
                UPDATE runs
                SET status = %s,
                    invocation = %s,
                    session_id = %s,
                    started_at = %s,
                    finished_at = %s,
                    final_text = %s,
                    error = %s
                WHERE id = %s
                """,
                (
                    run.status.value,
                    Jsonb(run.invocation.model_dump(mode="json")),
                    run.session_id,
                    run.started_at,
                    run.finished_at,
                    run.final_text,
                    run.error,
                    run.id,
                ),
            )

    async def get_run(self, run_id: UUID) -> Run | None:
        async with await self._connect() as conn:
            row = await (
                await conn.execute(
                    """
                    SELECT id, task_id, parent_run_id, status, invocation, session_id,
                           started_at, finished_at,
                           final_text, error
                    FROM runs
                    WHERE id = %s
                    """,
                    (run_id,),
                )
            ).fetchone()
        return self._run_from_row(row) if row else None

    async def list_runs(self) -> list[Run]:
        async with await self._connect() as conn:
            rows = await (
                await conn.execute(
                    """
                    SELECT id, task_id, parent_run_id, status, invocation, session_id,
                           started_at, finished_at,
                           final_text, error
                    FROM runs
                    ORDER BY started_at DESC NULLS LAST
                    """
                )
            ).fetchall()
        return [self._run_from_row(row) for row in rows]

    async def append_event(self, event: TraceEvent) -> None:
        async with await self._connect() as conn:
            result = await conn.execute(
                """
                INSERT INTO events (run_id, seq, kind, payload, at)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (run_id, seq) DO NOTHING
                """,
                (
                    event.run_id,
                    event.seq,
                    event.kind.value,
                    Jsonb(event.payload),
                    event.at,
                ),
            )
        if result.rowcount:
            await self._publish(event)

    async def events_for(self, run_id: UUID) -> list[TraceEvent]:
        async with await self._connect() as conn:
            rows = await (
                await conn.execute(
                    """
                    SELECT run_id, seq, kind, payload, at
                    FROM events
                    WHERE run_id = %s
                    ORDER BY seq ASC
                    """,
                    (run_id,),
                )
            ).fetchall()
        return [
            TraceEvent(
                run_id=row[0],
                seq=row[1],
                kind=TraceEventKind(row[2]),
                payload=row[3],
                at=row[4],
            )
            for row in rows
        ]

    async def conversation_events_for(self, run_id: UUID) -> list[TraceEvent]:
        chain: list[UUID] = []
        current = await self.get_run(run_id)
        while current is not None:
            chain.append(current.id)
            if current.parent_run_id is None:
                break
            current = await self.get_run(current.parent_run_id)

        events: list[TraceEvent] = []
        for chained_run_id in reversed(chain):
            events.extend(await self.events_for(chained_run_id))
        return events

    def _run_from_row(self, row: tuple[Any, ...]) -> Run:
        return Run(
            id=row[0],
            task_id=row[1],
            parent_run_id=row[2],
            status=RunStatus(row[3]),
            invocation=AgentInvocation.model_validate(row[4]),
            session_id=row[5],
            started_at=row[6],
            finished_at=row[7],
            final_text=row[8],
            error=row[9],
        )


def create_store(database_url: str) -> Store:
    if database_url:
        return PostgresStore(database_url)
    return MemoryStore()
