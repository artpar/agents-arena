"""Event system for decoupled communication."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Coroutine
import asyncio
import logging

logger = logging.getLogger(__name__)


@dataclass
class Event:
    """An event in the system."""
    type: str
    data: Any = None
    timestamp: datetime = field(default_factory=datetime.now)


class EventBus:
    """Async event bus for pub/sub communication."""

    def __init__(self):
        self._handlers: dict[str, list[Callable]] = {}
        self._queue: asyncio.Queue[Event] = asyncio.Queue()
        self._running = False
        self._task: asyncio.Task | None = None

    def subscribe(self, event_type: str, handler: Callable) -> None:
        """Subscribe to an event type."""
        if event_type not in self._handlers:
            self._handlers[event_type] = []
        self._handlers[event_type].append(handler)

    def unsubscribe(self, event_type: str, handler: Callable) -> None:
        """Unsubscribe from an event type."""
        if event_type in self._handlers:
            self._handlers[event_type].remove(handler)

    def emit(self, event: Event) -> None:
        """Emit an event (non-blocking)."""
        self._queue.put_nowait(event)

    async def start(self) -> None:
        """Start processing events."""
        self._running = True
        self._task = asyncio.create_task(self._process_events())

    async def stop(self) -> None:
        """Stop processing events."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _process_events(self) -> None:
        """Process events from the queue."""
        while self._running:
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=0.5)
                await self._dispatch(event)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

    async def _dispatch(self, event: Event) -> None:
        """Dispatch event to handlers."""
        handlers = self._handlers.get(event.type, [])
        handlers.extend(self._handlers.get("*", []))  # Wildcard handlers

        for handler in handlers:
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(event)
                else:
                    handler(event)
            except Exception as e:
                logger.error(f"Event handler error for {event.type}: {e}")
