"""Core type definitions for Agent Arena."""

from enum import Enum
from typing import TypedDict, Optional, List


class AgentStatus(Enum):
    """Status of an agent in the arena."""
    IDLE = "idle"
    THINKING = "thinking"
    SPEAKING = "speaking"
    OFFLINE = "offline"


class MessageType(Enum):
    """Types of messages in the chat."""
    CHAT = "chat"
    SYSTEM = "system"
    ACTION = "action"  # /me style
    JOIN = "join"
    LEAVE = "leave"


class ScheduleMode(Enum):
    """How agents are scheduled to speak."""
    TURN_BASED = "turn_based"  # Round-robin, one at a time
    ASYNC = "async"            # Agents speak whenever they want
    HYBRID = "hybrid"          # Rounds + async for mentions


class PersonalityTrait(TypedDict):
    """A personality trait with a value."""
    name: str
    value: float  # 0.0 to 1.0


class AgentConfig(TypedDict, total=False):
    """Configuration for an agent."""
    id: str
    name: str
    description: str
    system_prompt: str
    personality_traits: dict[str, float]
    speaking_style: str
    interests: List[str]
    response_tendency: float  # 0.0 (quiet) to 1.0 (talkative)
    temperature: float
    model: str  # sonnet, opus, haiku
    tools: List[str]  # Tools this agent can use
