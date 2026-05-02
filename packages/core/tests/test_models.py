from asor_core import Run, RunStatus, Task, TraceEvent, TraceEventKind


def test_task_defaults() -> None:
    task = Task(prompt="hello")
    assert task.prompt == "hello"
    assert task.id is not None
    assert task.created_at is not None


def test_run_starts_pending() -> None:
    task = Task(prompt="hello")
    run = Run(task_id=task.id)
    assert run.status is RunStatus.pending


def test_trace_event_kind_roundtrip() -> None:
    task = Task(prompt="hi")
    run = Run(task_id=task.id)
    event = TraceEvent(run_id=run.id, seq=0, kind=TraceEventKind.init, payload={"model": "auto"})
    assert event.kind is TraceEventKind.init
    assert event.payload["model"] == "auto"
