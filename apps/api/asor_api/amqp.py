from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

import aio_pika
from aio_pika.abc import AbstractChannel, AbstractRobustConnection
from asor_core import (
    EVENTS_BINDING_KEY,
    EVENTS_EXCHANGE,
    EVENTS_QUEUE,
    TASK_DISPATCH_KEY,
    TASKS_EXCHANGE,
    TaskDispatch,
)

log = logging.getLogger(__name__)

EventHandler = Callable[[bytes], Awaitable[None]]


class AmqpClient:
    def __init__(self, url: str) -> None:
        self._url = url
        self._conn: AbstractRobustConnection | None = None
        self._chan: AbstractChannel | None = None
        self._tasks_ex: aio_pika.abc.AbstractExchange | None = None

    async def connect(self) -> None:
        self._conn = await aio_pika.connect_robust(self._url)
        channel = await self._conn.channel()
        self._chan = channel
        await channel.set_qos(prefetch_count=32)
        self._tasks_ex = await channel.declare_exchange(
            TASKS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
        )
        await channel.declare_exchange(EVENTS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True)
        log.info("amqp connected: %s", self._url)

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()

    async def publish_task(self, dispatch: TaskDispatch) -> None:
        assert self._tasks_ex is not None, "amqp not connected"
        await self._tasks_ex.publish(
            aio_pika.Message(
                body=dispatch.model_dump_json().encode("utf-8"),
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            ),
            routing_key=TASK_DISPATCH_KEY,
        )

    async def consume_events(self, handler: EventHandler) -> None:
        assert self._chan is not None, "amqp not connected"
        events_ex = await self._chan.declare_exchange(
            EVENTS_EXCHANGE, aio_pika.ExchangeType.TOPIC, durable=True
        )
        queue = await self._chan.declare_queue(EVENTS_QUEUE, durable=True)
        await queue.bind(events_ex, routing_key=EVENTS_BINDING_KEY)

        async def _on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
            async with message.process(requeue=False):
                try:
                    await handler(message.body)
                except Exception:
                    log.exception("event handler failed; dropping message")

        await queue.consume(_on_message)
        log.info("amqp consuming events from %s", EVENTS_QUEUE)
