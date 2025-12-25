"""Agent registry for managing agents in the arena."""

from typing import Dict, List, Optional, Iterator
import logging

from ..agents.agent import Agent

logger = logging.getLogger(__name__)


class AgentRegistry:
    """Registry for managing agents."""

    def __init__(self):
        self._agents: Dict[str, Agent] = {}
        self._by_name: Dict[str, str] = {}  # name -> id mapping

    def register(self, agent: Agent) -> None:
        """Register an agent."""
        if agent.id in self._agents:
            raise ValueError(f"Agent {agent.id} already registered")

        self._agents[agent.id] = agent
        self._by_name[agent.name.lower()] = agent.id
        logger.info(f"Registered agent: {agent.name} ({agent.id})")

    def unregister(self, agent_id: str) -> Optional[Agent]:
        """Unregister an agent by ID."""
        agent = self._agents.pop(agent_id, None)
        if agent:
            self._by_name.pop(agent.name.lower(), None)
            logger.info(f"Unregistered agent: {agent.name}")
        return agent

    def get(self, agent_id: str) -> Optional[Agent]:
        """Get an agent by ID."""
        return self._agents.get(agent_id)

    def get_by_name(self, name: str) -> Optional[Agent]:
        """Get an agent by name (case-insensitive)."""
        agent_id = self._by_name.get(name.lower())
        return self._agents.get(agent_id) if agent_id else None

    def all(self) -> List[Agent]:
        """Get all registered agents."""
        return list(self._agents.values())

    def names(self) -> List[str]:
        """Get all agent names."""
        return [a.name for a in self._agents.values()]

    def count(self) -> int:
        """Get number of registered agents."""
        return len(self._agents)

    def __iter__(self) -> Iterator[Agent]:
        """Iterate over agents."""
        return iter(self._agents.values())

    def __len__(self) -> int:
        """Get number of agents."""
        return len(self._agents)

    def __contains__(self, agent_id: str) -> bool:
        """Check if agent is registered."""
        return agent_id in self._agents
