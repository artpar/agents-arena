"""Arena components for orchestrating agent interactions."""

from .registry import AgentRegistry
from .channel import Channel
from .world import ArenaWorld

__all__ = [
    "AgentRegistry",
    "Channel",
    "ArenaWorld",
]
