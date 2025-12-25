"""Arena World - main orchestrator for agent interactions."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Callable, Any
import asyncio
import random
import logging

from ..core.types import AgentStatus, ScheduleMode
from ..core.events import Event, EventBus
from ..core.message import Message, MessageType
from ..agents.agent import Agent
from .registry import AgentRegistry
from .channel import Channel

logger = logging.getLogger(__name__)


@dataclass
class ArenaWorld:
    """
    Main orchestrator for the agent simulation.

    Manages agents, channels, message flow, and scheduling.
    """

    name: str = "Agent Arena"

    # Components
    registry: AgentRegistry = field(default_factory=AgentRegistry)
    channels: Dict[str, Channel] = field(default_factory=dict)
    event_bus: EventBus = field(default_factory=EventBus)

    # Scheduling
    mode: ScheduleMode = ScheduleMode.HYBRID
    round_interval: float = 5.0  # Seconds between rounds
    max_speakers_per_round: int = 3

    # State
    running: bool = False
    current_round: int = 0
    start_time: Optional[datetime] = None

    # Default channel
    default_channel: str = "general"

    # Task handles
    _scheduler_task: Optional[asyncio.Task] = field(default=None, repr=False)

    def __post_init__(self):
        """Initialize default channel."""
        if self.default_channel not in self.channels:
            self.channels[self.default_channel] = Channel(
                name=self.default_channel,
                description="General discussion"
            )

    # === Agent Management ===

    async def add_agent(self, agent: Agent, channels: List[str] = None) -> None:
        """Add an agent to the arena."""
        # Register
        self.registry.register(agent)

        # Connect the agent's SDK client
        await agent.connect()

        # Join channels
        channel_names = channels or [self.default_channel]
        for channel_name in channel_names:
            if channel_name in self.channels:
                self.channels[channel_name].add_member(agent.id)

        # Emit join event
        self.event_bus.emit(Event(
            type="agent_joined",
            data={"agent_id": agent.id, "agent_name": agent.name}
        ))

        # Broadcast join message
        join_msg = Message(
            sender_id="system",
            sender_name="System",
            content=f"{agent.name} has joined the chat",
            channel=self.default_channel,
            type=MessageType.JOIN
        )
        await self.broadcast(join_msg)

        logger.info(f"Agent {agent.name} joined the arena")

    async def remove_agent(self, agent_id: str) -> Optional[Agent]:
        """Remove an agent from the arena."""
        agent = self.registry.get(agent_id)
        if not agent:
            return None

        # Broadcast leave message
        leave_msg = Message(
            sender_id="system",
            sender_name="System",
            content=f"{agent.name} has left the chat",
            channel=self.default_channel,
            type=MessageType.LEAVE
        )
        await self.broadcast(leave_msg)

        # Leave all channels
        for channel in self.channels.values():
            channel.remove_member(agent_id)

        # Disconnect agent
        await agent.disconnect()

        # Unregister
        self.registry.unregister(agent_id)

        # Emit leave event
        self.event_bus.emit(Event(
            type="agent_left",
            data={"agent_id": agent_id, "agent_name": agent.name}
        ))

        logger.info(f"Agent {agent.name} left the arena")
        return agent

    # === Channel Management ===

    def create_channel(self, name: str, description: str = "") -> Channel:
        """Create a new channel."""
        channel = Channel(name=name, description=description)
        self.channels[name] = channel
        return channel

    def get_channel(self, name: str) -> Optional[Channel]:
        """Get a channel by name."""
        return self.channels.get(name)

    # === Messaging ===

    async def broadcast(self, message: Message) -> None:
        """Broadcast a message to a channel."""
        channel = self.channels.get(message.channel)
        if not channel:
            logger.warning(f"Channel {message.channel} not found")
            return

        # Add to channel history
        channel.add_message(message)

        # Emit message event
        self.event_bus.emit(Event(
            type="message",
            data={
                "channel": message.channel,
                "message": message.to_dict()
            }
        ))

        logger.debug(f"[{message.channel}] <{message.sender_name}> {message.content}")

    async def inject_message(self, content: str, sender_name: str = "Human",
                             channel: str = None) -> Message:
        """Inject a message from a human or external source."""
        message = Message(
            sender_id="human",
            sender_name=sender_name,
            content=content,
            channel=channel or self.default_channel
        )
        await self.broadcast(message)
        return message

    # === Simulation Control ===

    async def start(self) -> None:
        """Start the simulation."""
        if self.running:
            return

        self.running = True
        self.start_time = datetime.now()

        # Start event bus
        await self.event_bus.start()

        # Start scheduler
        self._scheduler_task = asyncio.create_task(self._run_scheduler())

        self.event_bus.emit(Event(
            type="simulation_started",
            data={"mode": self.mode.value}
        ))

        logger.info(f"Simulation started in {self.mode.value} mode")

    async def stop(self) -> None:
        """Stop the simulation."""
        if not self.running:
            return

        self.running = False

        # Stop scheduler
        if self._scheduler_task:
            self._scheduler_task.cancel()
            try:
                await self._scheduler_task
            except asyncio.CancelledError:
                pass

        # Stop event bus
        await self.event_bus.stop()

        self.event_bus.emit(Event(
            type="simulation_stopped",
            data={"rounds": self.current_round}
        ))

        logger.info("Simulation stopped")

    async def _run_scheduler(self) -> None:
        """Main scheduler loop."""
        while self.running:
            try:
                if self.mode == ScheduleMode.TURN_BASED:
                    await self._run_round()
                    await asyncio.sleep(self.round_interval)

                elif self.mode == ScheduleMode.ASYNC:
                    await self._check_async_responses()
                    await asyncio.sleep(1.0)

                else:  # HYBRID
                    await self._run_hybrid_step()
                    await asyncio.sleep(1.0)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Scheduler error: {e}")
                await asyncio.sleep(1.0)

    async def _run_round(self) -> None:
        """Execute a turn-based round."""
        self.current_round += 1

        self.event_bus.emit(Event(
            type="round_started",
            data={"round": self.current_round}
        ))

        # Get agents who want to speak
        speakers = await self._select_speakers()

        # Have each speaker respond
        for agent in speakers[:self.max_speakers_per_round]:
            await self._agent_respond(agent)

        self.event_bus.emit(Event(
            type="round_ended",
            data={"round": self.current_round, "speakers": len(speakers)}
        ))

    async def _check_async_responses(self) -> None:
        """Check if any agents want to respond asynchronously."""
        channel = self.channels[self.default_channel]
        recent = channel.get_recent_messages(1)

        if not recent:
            return

        last_message = recent[-1]

        # Check for direct mentions
        for agent in self.registry.all():
            if agent.status != AgentStatus.IDLE:
                continue

            if agent.name.lower() in [m.lower() for m in last_message.mentions]:
                await self._agent_respond(agent)

    async def _run_hybrid_step(self) -> None:
        """Run one step of hybrid scheduling."""
        channel = self.channels[self.default_channel]
        recent = channel.get_recent_messages(1)

        # Check for urgent responses (mentions)
        if recent:
            last_message = recent[-1]
            for agent in self.registry.all():
                if agent.status != AgentStatus.IDLE:
                    continue
                if agent.name.lower() in [m.lower() for m in last_message.mentions]:
                    await self._agent_respond(agent)
                    return

        # Periodic round check
        if not hasattr(self, '_last_round_time'):
            self._last_round_time = datetime.now()

        elapsed = (datetime.now() - self._last_round_time).total_seconds()
        if elapsed >= self.round_interval:
            await self._run_round()
            self._last_round_time = datetime.now()

    async def _select_speakers(self) -> List[Agent]:
        """Select agents who will speak this round."""
        channel = self.channels[self.default_channel]
        recent = channel.get_recent_messages(1)

        if not recent:
            # No messages yet - pick a random agent to start
            agents = self.registry.all()
            if agents:
                return [random.choice(agents)]
            return []

        last_message = recent[-1]
        candidates = []

        for agent in self.registry.all():
            if agent.status != AgentStatus.IDLE:
                continue
            if agent.id == last_message.sender_id:
                continue  # Skip the last speaker

            probability = agent.should_respond(last_message, self.registry.names())
            if random.random() < probability:
                candidates.append((probability, agent))

        # Sort by probability and return top speakers
        candidates.sort(key=lambda x: x[0], reverse=True)
        return [agent for _, agent in candidates]

    async def _agent_respond(self, agent: Agent) -> Optional[Message]:
        """Have an agent generate and send a response."""
        channel = self.channels[self.default_channel]

        # Build context from recent messages
        context = f"""Current conversation in #{channel.name}:

{channel.get_context_string(20)}

Participants: {', '.join(self.registry.names())}

Now respond naturally as {agent.name}. Keep it brief (1-2 sentences).
IMPORTANT: Just write your response directly. Do NOT include your name, timestamps, or angle brackets."""

        # Emit thinking event
        self.event_bus.emit(Event(
            type="agent_thinking",
            data={"agent_id": agent.id, "agent_name": agent.name, "thinking": True}
        ))

        # Get response from agent
        response_text = await agent.respond(context)

        # Emit thinking done event
        self.event_bus.emit(Event(
            type="agent_thinking",
            data={"agent_id": agent.id, "agent_name": agent.name, "thinking": False}
        ))

        if not response_text:
            return None

        # Create and broadcast message
        message = Message(
            sender_id=agent.id,
            sender_name=agent.name,
            content=response_text,
            channel=channel.name
        )
        await self.broadcast(message)

        return message

    # === Status ===

    def get_status(self) -> dict:
        """Get current simulation status."""
        return {
            "name": self.name,
            "running": self.running,
            "mode": self.mode.value,
            "current_round": self.current_round,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "agents": {
                "count": self.registry.count(),
                "names": self.registry.names()
            },
            "channels": {
                name: ch.to_dict() for name, ch in self.channels.items()
            }
        }
