from __future__ import annotations

import asyncio
import logging
import signal

import aio_pika
from asor_core import TASK_DISPATCH_KEY, TASKS_EXCHANGE, TASKS_QUEUE, TaskDispatch

from asor_worker.config import Settings
from asor_worker.runner_docker import DockerAgentRunner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("asor.worker")


async def _run() -> None:
    settings = Settings()
    runner = DockerAgentRunner(settings)

    log.info("connecting to amqp: %s", settings.asor_amqp_url)
    connection = await aio_pika.connect_robust(settings.asor_amqp_url)
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=4)

    exchange = await channel.declare_exchange(
        TASKS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
    )
    queue = await channel.declare_queue(TASKS_QUEUE, durable=True)
    await queue.bind(exchange, routing_key=TASK_DISPATCH_KEY)

    log.info("worker ready; consuming %s", TASKS_QUEUE)

    async def _on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        async with message.process(requeue=False):
            try:
                dispatch = TaskDispatch.model_validate_json(message.body)
            except Exception:
                log.exception("invalid TaskDispatch payload; dropping")
                return
            log.info("dispatching run %s (task %s)", dispatch.run.id, dispatch.task.id)
            try:
                runner.launch(dispatch.task, dispatch.run)
            except Exception:
                log.exception("runner launch failed for run %s", dispatch.run.id)

    await queue.consume(_on_message)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    log.info("shutting down worker")
    await connection.close()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
