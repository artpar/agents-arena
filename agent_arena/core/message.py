"""Message handling for the chat system."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List
import uuid
import re

from .types import MessageType


@dataclass
class Message:
    """A message in the chat."""
    sender_id: str
    sender_name: str
    content: str
    channel: str = "general"

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    type: MessageType = MessageType.CHAT
    timestamp: datetime = field(default_factory=datetime.now)
    reply_to: Optional[str] = None
    mentions: List[str] = field(default_factory=list)

    def __post_init__(self):
        # Extract @mentions from content
        if not self.mentions:
            self.mentions = self._extract_mentions()

    def _extract_mentions(self) -> List[str]:
        """Extract @mentions from message content."""
        return re.findall(r'@(\w+)', self.content)

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "id": self.id,
            "sender_id": self.sender_id,
            "sender_name": self.sender_name,
            "content": self.content,
            "channel": self.channel,
            "type": self.type.value,
            "timestamp": self.timestamp.isoformat(),
            "reply_to": self.reply_to,
            "mentions": self.mentions,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Message":
        """Create from dictionary."""
        return cls(
            id=data["id"],
            sender_id=data["sender_id"],
            sender_name=data["sender_name"],
            content=data["content"],
            channel=data.get("channel", "general"),
            type=MessageType(data.get("type", "chat")),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            reply_to=data.get("reply_to"),
            mentions=data.get("mentions", []),
        )

    def format_irc(self) -> str:
        """Format message IRC-style."""
        time_str = self.timestamp.strftime("%H:%M:%S")
        if self.type == MessageType.ACTION:
            return f"[{time_str}] * {self.sender_name} {self.content}"
        elif self.type == MessageType.SYSTEM:
            return f"[{time_str}] *** {self.content}"
        elif self.type == MessageType.JOIN:
            return f"[{time_str}] --> {self.content}"
        elif self.type == MessageType.LEAVE:
            return f"[{time_str}] <-- {self.content}"
        else:
            return f"[{time_str}] <{self.sender_name}> {self.content}"
