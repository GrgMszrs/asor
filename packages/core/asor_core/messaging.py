from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel

from asor_core.models import Run, Task

TASKS_EXCHANGE = "asor.tasks"
EVENTS_EXCHANGE = "asor.events"
TASKS_QUEUE = "asor.tasks.dispatch"
EVENTS_QUEUE = "asor.events.api"
TASK_DISPATCH_KEY = "task.dispatch"
EVENTS_BINDING_KEY = "run.#"


def event_routing_key(run_id: UUID | str, kind: str) -> str:
    return f"run.{run_id}.{kind}"


class TaskDispatch(BaseModel):
    task: Task
    run: Run
