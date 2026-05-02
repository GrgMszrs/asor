from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import UUID

from asor_core import AgentInvocation, Run, RunStatus, Task, TraceEvent, TraceEventKind
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from asor_api.config import Settings
from asor_api.runner_docker import DockerAgentRunner
from asor_api.store import Store, create_store

log = logging.getLogger(__name__)


class CreateTaskRequest(BaseModel):
    prompt: str
    model: str | None = None
    extensions: list[str] = []
    parent_run_id: UUID | None = None


class CreateTaskResponse(BaseModel):
    task_id: UUID
    run_id: UUID


def create_app() -> FastAPI:
    settings = Settings()
    runner = DockerAgentRunner(settings)
    store = create_store(settings.database_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await store.init()
        app.state.store = store
        yield

    app = FastAPI(title="asor", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def app_store() -> Store:
        store: Store = app.state.store
        return store

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/tasks", response_model=CreateTaskResponse)
    async def create_task(req: CreateTaskRequest) -> CreateTaskResponse:
        parent_run: Run | None = None
        if req.parent_run_id is not None:
            parent_run = await app_store().get_run(req.parent_run_id)
            if parent_run is None:
                raise HTTPException(404, "parent run not found")
            if parent_run.session_id is None:
                for event in reversed(await app_store().events_for(parent_run.id)):
                    session_id = event.payload.get("session_id")
                    if event.kind is TraceEventKind.init and isinstance(session_id, str):
                        parent_run.session_id = session_id
                        await app_store().update_run(parent_run)
                        break

        task = Task(prompt=req.prompt)
        invocation = AgentInvocation(model=req.model, extensions=req.extensions)
        run = Run(
            task_id=task.id,
            parent_run_id=parent_run.id if parent_run else None,
            invocation=invocation,
            session_id=parent_run.session_id if parent_run else None,
            status=RunStatus.running,
            started_at=datetime.now(UTC),
        )
        await app_store().add_task(task)
        await app_store().add_run(run)
        await app_store().append_event(
            TraceEvent(
                run_id=run.id,
                seq=0,
                kind=TraceEventKind.message,
                payload={"role": "user", "content": task.prompt, "source": "asor"},
            )
        )
        runner.launch(task, run)
        return CreateTaskResponse(task_id=task.id, run_id=run.id)

    @app.post("/runs/{run_id}/events", status_code=204)
    async def ingest_event(run_id: UUID, event: TraceEvent) -> None:
        if event.run_id != run_id:
            raise HTTPException(400, "run_id mismatch")
        await app_store().append_event(event)

        if event.kind is TraceEventKind.status:
            status = event.payload.get("status")
            run = await app_store().get_run(run_id)
            if run is not None:
                if status == "succeeded":
                    run.status = RunStatus.succeeded
                    run.finished_at = datetime.now(UTC)
                elif status == "failed":
                    run.status = RunStatus.failed
                    run.finished_at = datetime.now(UTC)
                    run.error = event.payload.get("stderr_tail")
                await app_store().update_run(run)
        elif event.kind is TraceEventKind.init:
            session_id = event.payload.get("session_id")
            if isinstance(session_id, str) and session_id:
                run = await app_store().get_run(run_id)
                if run is not None:
                    run.session_id = session_id
                    await app_store().update_run(run)
        elif event.kind is TraceEventKind.result:
            run = await app_store().get_run(run_id)
            if run is not None:
                run.final_text = event.payload.get("response") or run.final_text
                await app_store().update_run(run)
        elif event.kind is TraceEventKind.message and event.payload.get("role") == "assistant":
            content = event.payload.get("content")
            if isinstance(content, str) and content:
                run = await app_store().get_run(run_id)
                if run is not None:
                    if event.payload.get("delta") is True:
                        run.final_text = (run.final_text or "") + content
                    else:
                        run.final_text = content
                    await app_store().update_run(run)

    @app.get("/runs", response_model=list[Run])
    async def list_runs() -> list[Run]:
        return await app_store().list_runs()

    @app.get("/runs/{run_id}")
    async def get_run(run_id: UUID) -> Run:
        run = await app_store().get_run(run_id)
        if run is None:
            raise HTTPException(404, "run not found")
        return run

    @app.get("/runs/{run_id}/events.json", response_model=list[TraceEvent])
    async def list_events(run_id: UUID) -> list[TraceEvent]:
        if await app_store().get_run(run_id) is None:
            raise HTTPException(404, "run not found")
        return await app_store().events_for(run_id)

    @app.get("/runs/{run_id}/conversation.json", response_model=list[TraceEvent])
    async def list_conversation_events(run_id: UUID) -> list[TraceEvent]:
        if await app_store().get_run(run_id) is None:
            raise HTTPException(404, "run not found")
        return await app_store().conversation_events_for(run_id)

    @app.get("/runs/{run_id}/events")
    async def stream_events(run_id: UUID) -> EventSourceResponse:
        run = await app_store().get_run(run_id)
        if run is None:
            raise HTTPException(404, "run not found")

        terminal = {RunStatus.succeeded, RunStatus.failed, RunStatus.cancelled}

        async def gen() -> AsyncIterator[dict[str, str]]:
            queue: asyncio.Queue[TraceEvent] = app_store().subscribe(run_id)
            seen: set[int] = set()
            try:
                for past in await app_store().events_for(run_id):
                    seen.add(past.seq)
                    yield {"event": past.kind.value, "data": past.model_dump_json()}

                current = await app_store().get_run(run_id)
                if current is not None and current.status in terminal:
                    return

                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=30.0)
                    except TimeoutError:
                        yield {
                            "event": "ping",
                            "data": json.dumps({"at": datetime.now(UTC).isoformat()}),
                        }
                        continue
                    if event.seq in seen:
                        continue
                    seen.add(event.seq)
                    yield {"event": event.kind.value, "data": event.model_dump_json()}
                    if event.kind is TraceEventKind.status and event.payload.get("status") in {
                        "succeeded",
                        "failed",
                    }:
                        break
            finally:
                app_store().unsubscribe(run_id, queue)

        return EventSourceResponse(gen())

    return app


app = create_app()
