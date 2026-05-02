from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import UUID

from asor_core import AgentInvocation, Run, RunStatus, Task, TraceEvent, TraceEventKind
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from asor_api.config import Settings
from asor_api.runner_docker import DockerAgentRunner
from asor_api.store import store

log = logging.getLogger(__name__)


class CreateTaskRequest(BaseModel):
    prompt: str
    model: str | None = None
    extensions: list[str] = []


class CreateTaskResponse(BaseModel):
    task_id: UUID
    run_id: UUID


def create_app() -> FastAPI:
    settings = Settings()
    runner = DockerAgentRunner(settings)
    app = FastAPI(title="asor", version="0.1.0")

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/tasks", response_model=CreateTaskResponse)
    async def create_task(req: CreateTaskRequest) -> CreateTaskResponse:
        task = Task(prompt=req.prompt)
        invocation = AgentInvocation(model=req.model, extensions=req.extensions)
        run = Run(
            task_id=task.id,
            invocation=invocation,
            status=RunStatus.running,
            started_at=datetime.now(UTC),
        )
        await store.add_task(task)
        await store.add_run(run)
        runner.launch(task, run)
        return CreateTaskResponse(task_id=task.id, run_id=run.id)

    @app.post("/runs/{run_id}/events", status_code=204)
    async def ingest_event(run_id: UUID, event: TraceEvent) -> None:
        if event.run_id != run_id:
            raise HTTPException(400, "run_id mismatch")
        await store.append_event(event)

        if event.kind is TraceEventKind.status:
            status = event.payload.get("status")
            run = await store.get_run(run_id)
            if run is not None:
                if status == "succeeded":
                    run.status = RunStatus.succeeded
                    run.finished_at = datetime.now(UTC)
                elif status == "failed":
                    run.status = RunStatus.failed
                    run.finished_at = datetime.now(UTC)
                    run.error = event.payload.get("stderr_tail")
                await store.update_run(run)
        elif event.kind is TraceEventKind.result:
            run = await store.get_run(run_id)
            if run is not None:
                run.final_text = event.payload.get("response") or run.final_text
                await store.update_run(run)

    @app.get("/runs", response_model=list[Run])
    async def list_runs() -> list[Run]:
        return await store.list_runs()

    @app.get("/runs/{run_id}")
    async def get_run(run_id: UUID) -> Run:
        run = await store.get_run(run_id)
        if run is None:
            raise HTTPException(404, "run not found")
        return run

    @app.get("/runs/{run_id}/events.json", response_model=list[TraceEvent])
    async def list_events(run_id: UUID) -> list[TraceEvent]:
        if await store.get_run(run_id) is None:
            raise HTTPException(404, "run not found")
        return await store.events_for(run_id)

    @app.get("/runs/{run_id}/events")
    async def stream_events(run_id: UUID) -> EventSourceResponse:
        run = await store.get_run(run_id)
        if run is None:
            raise HTTPException(404, "run not found")

        terminal = {RunStatus.succeeded, RunStatus.failed, RunStatus.cancelled}

        async def gen() -> AsyncIterator[dict[str, str]]:
            for past in await store.events_for(run_id):
                yield {"event": past.kind.value, "data": past.model_dump_json()}

            current = await store.get_run(run_id)
            if current is not None and current.status in terminal:
                return

            queue: asyncio.Queue[TraceEvent] = store.subscribe(run_id)
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    except TimeoutError:
                        yield {
                            "event": "ping",
                            "data": json.dumps({"at": datetime.now(UTC).isoformat()}),
                        }
                        continue
                    yield {"event": event.kind.value, "data": event.model_dump_json()}
                    if event.kind is TraceEventKind.status and event.payload.get("status") in {
                        "succeeded",
                        "failed",
                    }:
                        break
            finally:
                store.unsubscribe(run_id, queue)

        return EventSourceResponse(gen())

    return app


app = create_app()
