"""Main CLI entry point for Agent Arena."""

import asyncio
import signal
from pathlib import Path
from typing import Optional
import sys

import click
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from dotenv import load_dotenv

from ..arena.world import ArenaWorld
from ..agents.agent import Agent
from ..agents.loader import load_agents_from_directory, load_agent_config
from ..core.types import ScheduleMode
from ..core.events import Event

console = Console()

# Load environment variables
load_dotenv()


class SimulationRunner:
    """Runs and displays the simulation."""

    def __init__(self, world: ArenaWorld, human_name: str = "Human"):
        self.world = world
        self.human_name = human_name
        self._stop_event = asyncio.Event()

    async def run(self):
        """Run the simulation with live display."""
        # Subscribe to events
        self.world.event_bus.subscribe("message", self._on_message)
        self.world.event_bus.subscribe("agent_joined", self._on_agent_joined)
        self.world.event_bus.subscribe("agent_left", self._on_agent_left)

        # Start simulation
        await self.world.start()

        console.print(Panel(
            f"[bold green]Simulation started![/]\n"
            f"Mode: {self.world.mode.value}\n"
            f"Agents: {', '.join(self.world.registry.names())}\n\n"
            f"[dim]Type messages to chat. Press Ctrl+C to stop.[/]",
            title="Agent Arena"
        ))

        try:
            await self._input_loop()
        except asyncio.CancelledError:
            pass
        finally:
            await self.world.stop()
            console.print("\n[yellow]Simulation stopped.[/]")

    async def _input_loop(self):
        """Handle human input."""
        loop = asyncio.get_event_loop()

        while self.world.running:
            try:
                # Read input in executor to avoid blocking
                user_input = await loop.run_in_executor(
                    None,
                    lambda: input()
                )

                if user_input.strip():
                    # Handle commands
                    if user_input.startswith("/"):
                        await self._handle_command(user_input)
                    else:
                        # Send as message
                        await self.world.inject_message(
                            content=user_input,
                            sender_name=self.human_name
                        )

            except EOFError:
                break
            except KeyboardInterrupt:
                break

    async def _handle_command(self, cmd: str):
        """Handle slash commands."""
        parts = cmd.split()
        command = parts[0].lower()

        if command == "/quit" or command == "/q":
            self.world.running = False

        elif command == "/status":
            self._show_status()

        elif command == "/agents":
            self._show_agents()

        elif command == "/add" and len(parts) > 1:
            await self._add_agent(parts[1])

        elif command == "/remove" and len(parts) > 1:
            await self._remove_agent(parts[1])

        elif command == "/topic" and len(parts) > 1:
            topic = " ".join(parts[1:])
            channel = self.world.get_channel(self.world.default_channel)
            channel.set_topic(topic)
            await self.world.inject_message(
                f"Topic changed to: {topic}",
                sender_name="System"
            )

        elif command == "/help":
            console.print("""
[bold]Commands:[/]
  /quit, /q     - Stop simulation
  /status       - Show simulation status
  /agents       - List agents
  /add <file>   - Add agent from config file
  /remove <name> - Remove agent by name
  /topic <text> - Set channel topic
  /help         - Show this help
            """)
        else:
            console.print(f"[red]Unknown command: {command}[/]")

    def _on_message(self, event: Event):
        """Handle message events."""
        msg = event.data["message"]
        sender = msg["sender_name"]
        content = msg["content"]
        msg_type = msg.get("type", "chat")

        if msg_type == "join":
            console.print(f"[green]--> {sender} has joined[/]")
        elif msg_type == "leave":
            console.print(f"[red]<-- {sender} has left[/]")
        elif msg_type == "system":
            console.print(f"[yellow]*** {content}[/]")
        else:
            # Color-code by sender
            if sender == self.human_name:
                console.print(f"[cyan]<{sender}>[/] {content}")
            else:
                console.print(f"[magenta]<{sender}>[/] {content}")

    def _on_agent_joined(self, event: Event):
        """Handle agent join events."""
        pass  # Handled by message event

    def _on_agent_left(self, event: Event):
        """Handle agent leave events."""
        pass  # Handled by message event

    def _show_status(self):
        """Show simulation status."""
        status = self.world.get_status()
        table = Table(title="Simulation Status")
        table.add_column("Property", style="cyan")
        table.add_column("Value", style="green")

        table.add_row("Name", status["name"])
        table.add_row("Running", str(status["running"]))
        table.add_row("Mode", status["mode"])
        table.add_row("Round", str(status["current_round"]))
        table.add_row("Agents", str(status["agents"]["count"]))

        console.print(table)

    def _show_agents(self):
        """Show agents list."""
        table = Table(title="Agents")
        table.add_column("Name", style="cyan")
        table.add_column("Status", style="green")
        table.add_column("Messages", style="yellow")

        for agent in self.world.registry.all():
            table.add_row(
                agent.name,
                agent.status.value,
                str(agent.message_count)
            )

        console.print(table)

    async def _add_agent(self, config_path: str):
        """Add an agent from config file."""
        try:
            path = Path(config_path)
            if not path.exists():
                # Try configs/agents directory
                path = Path("configs/agents") / f"{config_path}.yaml"

            config = load_agent_config(path)
            agent = Agent.from_config(config)
            await self.world.add_agent(agent)
            console.print(f"[green]Added agent: {agent.name}[/]")
        except Exception as e:
            console.print(f"[red]Error adding agent: {e}[/]")

    async def _remove_agent(self, name: str):
        """Remove an agent by name."""
        agent = self.world.registry.get_by_name(name)
        if agent:
            await self.world.remove_agent(agent.id)
            console.print(f"[yellow]Removed agent: {name}[/]")
        else:
            console.print(f"[red]Agent not found: {name}[/]")


@click.group()
@click.version_option(version="0.1.0")
def cli():
    """Agent Arena - AI Agent Society Emulator"""
    pass


@cli.command()
@click.option("--agents", "-a", default="configs/agents",
              help="Directory containing agent configs")
@click.option("--mode", "-m", type=click.Choice(["turn_based", "async", "hybrid"]),
              default="hybrid", help="Scheduling mode")
@click.option("--interval", "-i", default=5.0,
              help="Seconds between rounds (for turn_based/hybrid)")
@click.option("--name", "-n", default="Human",
              help="Your name in the chat")
def run(agents: str, mode: str, interval: float, name: str):
    """Start a simulation with agents from a directory."""

    async def _run():
        # Create world
        world = ArenaWorld(
            name="Agent Arena",
            mode=ScheduleMode(mode),
            round_interval=interval
        )

        # Load agents
        agents_path = Path(agents)
        if agents_path.exists():
            loaded_agents = load_agents_from_directory(agents_path)
            for agent in loaded_agents:
                await world.add_agent(agent)

            if not loaded_agents:
                console.print("[yellow]No agents found. Add some with /add[/]")
        else:
            console.print(f"[yellow]Agents directory not found: {agents}[/]")

        # Run simulation
        runner = SimulationRunner(world, human_name=name)
        await runner.run()

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        console.print("\n[yellow]Goodbye![/]")


@cli.command()
@click.argument("config_file")
def add(config_file: str):
    """Show info about an agent config file."""
    try:
        config = load_agent_config(Path(config_file))
        agent = Agent.from_config(config)

        table = Table(title=f"Agent: {agent.name}")
        table.add_column("Property", style="cyan")
        table.add_column("Value", style="green")

        table.add_row("Name", agent.name)
        table.add_row("Description", agent.description[:100] + "..." if len(agent.description) > 100 else agent.description)
        table.add_row("Model", agent.model)
        table.add_row("Temperature", str(agent.temperature))
        table.add_row("Response Tendency", str(agent.response_tendency))
        table.add_row("Interests", ", ".join(agent.interests))
        table.add_row("Tools", ", ".join(agent.tools))

        console.print(table)
    except Exception as e:
        console.print(f"[red]Error: {e}[/]")


@cli.command("list")
@click.option("--dir", "-d", default="configs/agents",
              help="Directory to list agents from")
def list_agents(dir: str):
    """List available agent configs."""
    path = Path(dir)
    if not path.exists():
        console.print(f"[red]Directory not found: {dir}[/]")
        return

    table = Table(title="Available Agents")
    table.add_column("File", style="cyan")
    table.add_column("Name", style="green")
    table.add_column("Description", style="dim")

    for yaml_file in path.glob("*.yaml"):
        try:
            config = load_agent_config(yaml_file)
            desc = config.get("description", "")[:50]
            if len(config.get("description", "")) > 50:
                desc += "..."
            table.add_row(yaml_file.name, config["name"], desc)
        except Exception as e:
            table.add_row(yaml_file.name, "[error]", str(e)[:50])

    console.print(table)


@cli.command()
@click.option("--host", "-h", default="0.0.0.0", help="Host to bind to")
@click.option("--port", "-p", default=8000, help="Port to bind to")
@click.option("--agents", "-a", default="configs/agents",
              help="Directory containing agent configs")
@click.option("--mode", "-m", type=click.Choice(["turn_based", "async", "hybrid"]),
              default="hybrid", help="Scheduling mode")
def serve(host: str, port: int, agents: str, mode: str):
    """Start the web interface."""
    import uvicorn
    from ..api.app import create_app

    async def _setup():
        # Create world
        world = ArenaWorld(
            name="Agent Arena",
            mode=ScheduleMode(mode)
        )

        # Load agents
        agents_path = Path(agents)
        if agents_path.exists():
            loaded_agents = load_agents_from_directory(agents_path)
            for agent in loaded_agents:
                await world.add_agent(agent)

        return world

    # Run setup
    world = asyncio.run(_setup())

    # Create app
    app = create_app(world)

    console.print(Panel(
        f"[bold green]Agent Arena Web Interface[/]\n\n"
        f"URL: http://{host}:{port}\n"
        f"Agents: {', '.join(world.registry.names())}\n"
        f"Mode: {mode}\n\n"
        f"[dim]Press Ctrl+C to stop.[/]",
        title="Starting Server"
    ))

    # Run server
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    cli()
