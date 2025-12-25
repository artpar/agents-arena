"""Agent class using raw Anthropic API for reliable web server compatibility."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List
import uuid
import asyncio
import logging
import os

import anthropic

from ..core.types import AgentStatus, AgentConfig
from ..core.message import Message

logger = logging.getLogger(__name__)


@dataclass
class Agent:
    """
    An AI agent in the arena using raw Anthropic API.

    Each agent has:
    - Its own conversation history
    - Custom personality via system prompt
    - Manual step control
    """

    name: str
    description: str = ""
    system_prompt: str = ""

    # Personality
    personality_traits: dict[str, float] = field(default_factory=dict)
    speaking_style: str = ""
    interests: List[str] = field(default_factory=list)

    # Behavior
    response_tendency: float = 0.5
    temperature: float = 0.7
    model: str = "claude-haiku-4-5-20251001"
    tools: List[str] = field(default_factory=list)

    # Identity
    id: str = field(default_factory=lambda: str(uuid.uuid4()))

    # Runtime state
    status: AgentStatus = AgentStatus.OFFLINE
    last_spoke_at: Optional[datetime] = None
    message_count: int = 0

    # Conversation history for this agent
    conversation_history: List[dict] = field(default_factory=list)

    # Anthropic client
    _client: Optional[anthropic.AsyncAnthropic] = field(default=None, repr=False)

    def __post_init__(self):
        """Build the full system prompt."""
        if not self.system_prompt:
            self.system_prompt = self._build_default_prompt()

    def _build_default_prompt(self) -> str:
        """Build a default system prompt from personality traits."""
        traits_str = ", ".join(
            f"{k}: {v:.1f}" for k, v in self.personality_traits.items()
        ) if self.personality_traits else "balanced"

        interests_str = ", ".join(self.interests) if self.interests else "general topics"

        return f"""You are {self.name}, an AI participant in a group chat with other AI agents and humans.

{self.description}

Your personality traits: {traits_str}
Your speaking style: {self.speaking_style or 'natural and conversational'}
Your interests: {interests_str}

IMPORTANT RULES:
1. Stay in character as {self.name}
2. To address another participant, use @TheirName
3. Keep responses concise (1-3 sentences typically, like IRC chat)
4. You can disagree, ask questions, build on ideas, or change topics
5. Don't repeat yourself or others unnecessarily
6. If you truly have nothing meaningful to add, respond with just "[PASS]"
7. Be authentic to your personality - don't just agree with everyone
8. Just write your response directly - no timestamps or formatting
"""

    async def connect(self) -> None:
        """Initialize the Anthropic client."""
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable not set")

        self._client = anthropic.AsyncAnthropic(api_key=api_key)
        self.status = AgentStatus.IDLE
        self.conversation_history = []
        logger.info(f"Agent {self.name} connected")

    async def disconnect(self) -> None:
        """Disconnect the agent."""
        self._client = None
        self.status = AgentStatus.OFFLINE
        self.conversation_history = []
        logger.info(f"Agent {self.name} disconnected")

    async def step(self, chat_context: str) -> Optional[str]:
        """
        Execute one step - generate a response to the current chat context.

        This is the manual step function for individual agent control.
        """
        if not self._client:
            raise RuntimeError(f"Agent {self.name} is not connected")

        self.status = AgentStatus.THINKING
        logger.info(f"Agent {self.name} thinking...")

        try:
            # Build the message
            user_message = f"""Current conversation:

{chat_context}

Now respond as {self.name}. Keep it brief (1-2 sentences). Just your response, nothing else."""

            # Add to conversation history
            self.conversation_history.append({
                "role": "user",
                "content": user_message
            })

            # Keep history manageable (last 20 exchanges)
            if len(self.conversation_history) > 40:
                self.conversation_history = self.conversation_history[-40:]

            # Call Anthropic API
            response = await self._client.messages.create(
                model=self.model,
                max_tokens=10000,
                system=self.system_prompt,
                messages=self.conversation_history,
                temperature=self.temperature
            )

            # Extract response text
            response_text = response.content[0].text.strip()

            # Add assistant response to history
            self.conversation_history.append({
                "role": "assistant",
                "content": response_text
            })

            # Check for [PASS]
            if response_text == "[PASS]":
                self.status = AgentStatus.IDLE
                return None

            self.status = AgentStatus.SPEAKING
            self.last_spoke_at = datetime.now()
            self.message_count += 1

            logger.info(f"Agent {self.name} responded: {response_text[:50]}...")
            return response_text

        except Exception as e:
            logger.error(f"Agent {self.name} error: {e}")
            self.status = AgentStatus.IDLE
            return None
        finally:
            self.status = AgentStatus.IDLE

    # Alias for compatibility
    async def respond(self, context: str, timeout: float = 60.0) -> Optional[str]:
        """Generate a response (alias for step)."""
        return await self.step(context)

    def should_respond(self, message: Message, all_agents: List[str]) -> float:
        """Calculate probability that this agent should respond."""
        base_prob = self.response_tendency * 0.3

        # Direct mention - high priority
        if self.name.lower() in [m.lower() for m in message.mentions]:
            return min(0.95, base_prob + 0.6)

        # Question - medium boost
        if "?" in message.content:
            base_prob += 0.15

        # Topic matches interests
        content_lower = message.content.lower()
        for interest in self.interests:
            if interest.lower() in content_lower:
                base_prob += 0.1
                break

        # Recently spoke - reduce
        if self.last_spoke_at:
            seconds_ago = (datetime.now() - self.last_spoke_at).total_seconds()
            if seconds_ago < 10:
                base_prob *= 0.3
            elif seconds_ago < 30:
                base_prob *= 0.6

        return min(0.8, base_prob)

    @classmethod
    def from_config(cls, config: AgentConfig) -> "Agent":
        """Create an agent from a config dict."""
        # Map short model names to full IDs
        model_map = {
            "haiku": "claude-haiku-4-5-20251001",
            "sonnet": "claude-sonnet-4-20250514",
            "opus": "claude-opus-4-20250514",
        }
        model = config.get("model", "claude-haiku-4-5-20251001")
        model = model_map.get(model, model)

        return cls(
            id=config.get("id", str(uuid.uuid4())),
            name=config["name"],
            description=config.get("description", ""),
            system_prompt=config.get("system_prompt", ""),
            personality_traits=config.get("personality_traits", {}),
            speaking_style=config.get("speaking_style", ""),
            interests=config.get("interests", []),
            response_tendency=config.get("response_tendency", 0.5),
            temperature=config.get("temperature", 0.7),
            model=model,
            tools=config.get("tools", []),
        )

    def to_dict(self) -> dict:
        """Serialize agent to dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "personality_traits": self.personality_traits,
            "speaking_style": self.speaking_style,
            "interests": self.interests,
            "response_tendency": self.response_tendency,
            "temperature": self.temperature,
            "model": self.model,
            "status": self.status.value,
            "message_count": self.message_count,
            "last_spoke_at": self.last_spoke_at.isoformat() if self.last_spoke_at else None,
        }
