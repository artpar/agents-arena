"""Load agent configurations from YAML files."""

from pathlib import Path
from typing import List
import yaml
import logging

from ..core.types import AgentConfig
from .agent import Agent

logger = logging.getLogger(__name__)


def load_agent_config(path: Path | str) -> AgentConfig:
    """Load an agent configuration from a YAML file."""
    path = Path(path)

    if not path.exists():
        raise FileNotFoundError(f"Agent config not found: {path}")

    with open(path, "r") as f:
        config = yaml.safe_load(f)

    # Set ID from filename if not specified
    if "id" not in config:
        config["id"] = path.stem

    return config


def load_agents_from_directory(directory: Path | str) -> List[Agent]:
    """Load all agent configurations from a directory."""
    directory = Path(directory)
    agents = []

    if not directory.exists():
        logger.warning(f"Agent directory not found: {directory}")
        return agents

    for yaml_file in directory.glob("*.yaml"):
        try:
            config = load_agent_config(yaml_file)
            agent = Agent.from_config(config)
            agents.append(agent)
            logger.info(f"Loaded agent: {agent.name} from {yaml_file}")
        except Exception as e:
            logger.error(f"Failed to load agent from {yaml_file}: {e}")

    return agents


def create_agent_from_dict(data: dict) -> Agent:
    """Create an agent from a dictionary (e.g., from API request)."""
    return Agent.from_config(data)
