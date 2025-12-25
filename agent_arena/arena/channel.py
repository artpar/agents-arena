"""Chat channel for agent communication."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Set, Optional
import uuid

from ..core.message import Message, MessageType


@dataclass
class Channel:
    """A chat channel where agents communicate."""

    name: str
    description: str = ""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    topic: str = ""
    created_at: datetime = field(default_factory=datetime.now)

    # Members (agent IDs)
    members: Set[str] = field(default_factory=set)

    # Message history
    messages: List[Message] = field(default_factory=list)
    max_history: int = 1000

    def add_member(self, agent_id: str) -> None:
        """Add a member to the channel."""
        self.members.add(agent_id)

    def remove_member(self, agent_id: str) -> None:
        """Remove a member from the channel."""
        self.members.discard(agent_id)

    def add_message(self, message: Message) -> None:
        """Add a message to the channel history."""
        self.messages.append(message)

        # Trim history if needed
        if len(self.messages) > self.max_history:
            self.messages = self.messages[-self.max_history:]

    def get_recent_messages(self, count: int = 50) -> List[Message]:
        """Get the most recent messages."""
        return self.messages[-count:]

    def get_context_string(self, count: int = 20) -> str:
        """Get recent messages formatted as context for agents."""
        recent = self.get_recent_messages(count)

        lines = []

        # Include topic/atmosphere at the top if set
        if self.topic:
            lines.append(f"=== Room Topic: {self.topic} ===")
            lines.append("")

        for msg in recent:
            lines.append(msg.format_irc())

        return "\n".join(lines)

    def set_topic(self, topic: str) -> None:
        """Set the channel topic."""
        self.topic = topic

    def clear_messages(self) -> int:
        """Clear all messages from the channel. Returns count of cleared messages."""
        count = len(self.messages)
        self.messages = []
        return count

    def to_dict(self) -> dict:
        """Serialize channel to dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "topic": self.topic,
            "members": list(self.members),
            "message_count": len(self.messages),
            "created_at": self.created_at.isoformat(),
        }
