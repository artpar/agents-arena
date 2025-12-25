"""FastAPI application with HTMX support."""

import asyncio
from pathlib import Path
from typing import Optional, List
import json
import logging
import yaml
import os

import anthropic

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Form, HTTPException, Body
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from ..arena.world import ArenaWorld
from ..agents.agent import Agent
from ..agents.loader import load_agents_from_directory, load_agent_config
from ..core.types import ScheduleMode
from ..core.events import Event
from ..core.message import Message

logger = logging.getLogger(__name__)

# Template directory
TEMPLATES_DIR = Path(__file__).parent.parent / "web" / "templates"


class ConnectionManager:
    """Manages WebSocket connections."""

    def __init__(self):
        self.connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.connections:
            try:
                await connection.send_text(message)
            except:
                pass


def create_app(world: Optional[ArenaWorld] = None) -> FastAPI:
    """Create the FastAPI application."""

    app = FastAPI(title="Agent Arena", version="0.1.0")
    templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
    manager = ConnectionManager()

    # Store world in app state
    if world is None:
        world = ArenaWorld(name="Agent Arena")
    app.state.world = world

    # Subscribe to world events for WebSocket broadcast
    async def on_message(event: Event):
        msg = event.data["message"]
        html = templates.get_template("partials/message.html").render({
            "message": msg,
            "request": None
        })
        await manager.broadcast(html)

    async def on_agent_thinking(event: Event):
        """Broadcast typing indicator when agent is thinking."""
        data = event.data
        # Send JSON message for typing indicator
        await manager.broadcast(json.dumps({
            "type": "typing",
            "agent_name": data["agent_name"],
            "thinking": data["thinking"]
        }))

    world.event_bus.subscribe("message", on_message)
    world.event_bus.subscribe("agent_thinking", on_agent_thinking)

    # Start event bus on app startup
    @app.on_event("startup")
    async def startup_event():
        await world.event_bus.start()
        logger.info("Event bus started")

    @app.on_event("shutdown")
    async def shutdown_event():
        await world.event_bus.stop()
        logger.info("Event bus stopped")

    # === HTML Routes ===

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request):
        """Main page."""
        return templates.TemplateResponse("index.html", {
            "request": request,
            "world": app.state.world,
            "agents": list(app.state.world.registry.all()),
            "status": app.state.world.get_status()
        })

    @app.get("/messages", response_class=HTMLResponse)
    async def get_messages(request: Request):
        """Get message history as HTML."""
        channel = app.state.world.get_channel(app.state.world.default_channel)
        messages = channel.get_recent_messages(50) if channel else []
        return templates.TemplateResponse("partials/messages.html", {
            "request": request,
            "messages": [m.to_dict() for m in messages]
        })

    @app.get("/agents-list", response_class=HTMLResponse)
    async def get_agents_list(request: Request):
        """Get agents list as HTML."""
        return templates.TemplateResponse("partials/agents.html", {
            "request": request,
            "agents": list(app.state.world.registry.all())
        })

    @app.get("/status-panel", response_class=HTMLResponse)
    async def get_status_panel(request: Request):
        """Get status panel as HTML."""
        return templates.TemplateResponse("partials/status.html", {
            "request": request,
            "status": app.state.world.get_status()
        })

    # === Actions ===

    @app.post("/send", response_class=HTMLResponse)
    async def send_message(request: Request, content: str = Form(...), sender: str = Form("Human")):
        """Send a message from human."""
        await app.state.world.inject_message(content=content, sender_name=sender)
        return ""  # HTMX will update via WebSocket

    @app.post("/start")
    async def start_simulation(request: Request, mode: str = "hybrid"):
        """Start the simulation."""
        if not app.state.world.running:
            app.state.world.mode = ScheduleMode(mode)
            app.state.world.running = True  # Set immediately for UI
            asyncio.create_task(app.state.world.start())
        # Return updated controls HTML
        status = {"running": True, "mode": app.state.world.mode.value}
        return templates.TemplateResponse("partials/controls.html", {"request": request, "status": status})

    @app.post("/stop")
    async def stop_simulation(request: Request):
        """Stop the simulation."""
        if app.state.world.running:
            await app.state.world.stop()
        # Return updated controls HTML
        status = {"running": app.state.world.running, "mode": app.state.world.mode.value}
        return templates.TemplateResponse("partials/controls.html", {"request": request, "status": status})

    @app.get("/api/topic")
    async def get_topic():
        """Get current room topic."""
        channel = app.state.world.get_channel(app.state.world.default_channel)
        return {"topic": channel.topic if channel else "", "name": channel.name if channel else ""}

    @app.post("/api/topic")
    async def set_topic(request: Request):
        """Set room topic."""
        data = await request.json()
        topic = data.get("topic", "")
        channel = app.state.world.get_channel(app.state.world.default_channel)
        if channel:
            channel.set_topic(topic)
            # Broadcast topic change as system message
            from ..core.message import Message, MessageType
            msg = Message(
                sender_id="system",
                sender_name="System",
                content=f"Topic changed to: {topic}" if topic else "Topic cleared",
                channel=channel.name,
                type=MessageType.SYSTEM
            )
            await app.state.world.broadcast(msg)
        return {"status": "updated", "topic": topic}

    @app.get("/topic-panel", response_class=HTMLResponse)
    async def get_topic_panel(request: Request):
        """Get topic panel as HTML."""
        channel = app.state.world.get_channel(app.state.world.default_channel)
        return templates.TemplateResponse("partials/topic.html", {
            "request": request,
            "topic": channel.topic if channel else "",
            "channel_name": channel.name if channel else "general"
        })

    # === Message Management ===

    @app.delete("/api/messages")
    async def clear_messages():
        """Clear all messages from the current channel."""
        channel = app.state.world.get_channel(app.state.world.default_channel)
        if channel:
            count = channel.clear_messages()
            return {"status": "cleared", "count": count}
        return {"status": "error", "message": "Channel not found"}

    # === Dynamic Rooms ===

    @app.get("/r/{room_name}", response_class=HTMLResponse)
    async def room_page(request: Request, room_name: str):
        """Dynamic room page - creates room if it doesn't exist.

        Query params are passed to description generation:
        - force=true: Regenerate description even if room exists
        - Any other params are included in the prompt (e.g., vibe=cozy, theme=startup)
        """
        # Normalize room name
        room_name = room_name.lower().replace(" ", "-")

        # Get query parameters
        query_params = dict(request.query_params)
        force_regenerate = query_params.pop("force", "").lower() == "true"

        # Check if room exists
        channel = app.state.world.get_channel(room_name)
        is_new_room = channel is None

        if is_new_room:
            # Create new room
            channel = app.state.world.create_channel(room_name, "")

        # Generate description if new room or force=true
        if is_new_room or force_regenerate:
            try:
                api_key = os.environ.get("ANTHROPIC_API_KEY")
                if api_key:
                    # Build prompt with query parameters
                    params_str = ""
                    if query_params:
                        params_list = [f"{k}={v}" for k, v in query_params.items()]
                        params_str = f"\n\nCustomization parameters: {', '.join(params_list)}"

                    client = anthropic.Anthropic(api_key=api_key)
                    response = client.messages.create(
                        model="claude-haiku-4-5-20251001",
                        max_tokens=256,
                        messages=[{
                            "role": "user",
                            "content": f"Generate a brief, engaging description (2-3 sentences) for a chat room called '{room_name}'. What would people discuss here? Be creative and specific. Just return the description, no quotes or labels.{params_str}"
                        }]
                    )
                    description = response.content[0].text.strip()
                    channel.description = description
                    channel.set_topic(description)
            except Exception as e:
                logger.error(f"Failed to generate room description: {e}")
                if is_new_room:
                    channel.set_topic(f"Welcome to #{room_name}")

        if is_new_room:
            # Add all agents to this room
            for agent in app.state.world.registry.all():
                channel.add_member(agent.id)

        # Switch to this room
        app.state.world.default_channel = room_name

        return templates.TemplateResponse("index.html", {
            "request": request,
            "world": app.state.world,
            "agents": list(app.state.world.registry.all()),
            "status": app.state.world.get_status(),
            "current_room": room_name
        })

    @app.get("/api/rooms")
    async def list_rooms():
        """List all available rooms."""
        return {
            "rooms": [ch.to_dict() for ch in app.state.world.channels.values()],
            "current": app.state.world.default_channel
        }

    @app.post("/api/rooms/{room_name}/switch")
    async def switch_room(room_name: str):
        """Switch to a different room."""
        channel = app.state.world.get_channel(room_name)
        if not channel:
            raise HTTPException(status_code=404, detail="Room not found")
        app.state.world.default_channel = room_name
        return {"status": "switched", "room": room_name}

    @app.post("/agents/add", response_class=HTMLResponse)
    async def add_agent_from_config(request: Request, config_path: str = Form(...)):
        """Add an agent from a config file."""
        try:
            path = Path(config_path)
            if not path.exists():
                path = Path("configs/agents") / f"{config_path}.yaml"

            config = load_agent_config(path)
            agent = Agent.from_config(config)
            await app.state.world.add_agent(agent)

            return templates.TemplateResponse("partials/agents.html", {
                "request": request,
                "agents": list(app.state.world.registry.all())
            })
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    @app.delete("/agents/{agent_id}")
    async def remove_agent(agent_id: str):
        """Remove an agent."""
        await app.state.world.remove_agent(agent_id)
        return {"status": "removed"}

    @app.post("/agents/{agent_id}/step", response_class=HTMLResponse)
    async def step_agent(request: Request, agent_id: str):
        """Step a single agent - have it respond to current context."""
        agent = app.state.world.registry.get(agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail="Agent not found")

        # Get channel and build context
        channel = app.state.world.get_channel(app.state.world.default_channel)
        if not channel:
            raise HTTPException(status_code=500, detail="No default channel")

        # Build context from recent messages
        context = channel.get_context_string(20)
        if not context:
            context = "(The conversation is just starting. Say hello!)"

        # Emit thinking event
        app.state.world.event_bus.emit(Event(
            type="agent_thinking",
            data={"agent_id": agent.id, "agent_name": agent.name, "thinking": True}
        ))

        # Have agent step
        response_text = await agent.step(context)

        # Emit thinking done event
        app.state.world.event_bus.emit(Event(
            type="agent_thinking",
            data={"agent_id": agent.id, "agent_name": agent.name, "thinking": False}
        ))

        if response_text:
            # Create and broadcast message
            message = Message(
                sender_id=agent.id,
                sender_name=agent.name,
                content=response_text,
                channel=channel.name
            )
            await app.state.world.broadcast(message)

        # Return updated agents list
        return templates.TemplateResponse("partials/agents.html", {
            "request": request,
            "agents": list(app.state.world.registry.all())
        })

    # === WebSocket ===

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket):
        """WebSocket for real-time updates."""
        await manager.connect(websocket)
        try:
            while True:
                data = await websocket.receive_text()
                # Handle incoming WebSocket messages if needed
                try:
                    msg = json.loads(data)
                    if msg.get("type") == "ping":
                        await websocket.send_text(json.dumps({"type": "pong"}))
                except json.JSONDecodeError:
                    pass
        except WebSocketDisconnect:
            manager.disconnect(websocket)

    # === API Routes ===

    @app.get("/api/status")
    async def api_status():
        """Get simulation status."""
        return app.state.world.get_status()

    @app.get("/api/agents")
    async def api_agents():
        """Get all agents."""
        return [a.to_dict() for a in app.state.world.registry.all()]

    @app.get("/api/messages")
    async def api_messages(limit: int = 50):
        """Get recent messages."""
        channel = app.state.world.get_channel(app.state.world.default_channel)
        if channel:
            return [m.to_dict() for m in channel.get_recent_messages(limit)]
        return []

    # === Persona Management ===

    @app.get("/personas", response_class=HTMLResponse)
    async def personas_page(request: Request):
        """Persona management page."""
        # Load existing persona configs
        configs_dir = Path("configs/agents")
        personas = []
        if configs_dir.exists():
            for yaml_file in configs_dir.glob("*.yaml"):
                try:
                    with open(yaml_file) as f:
                        config = yaml.safe_load(f)
                        config["_filename"] = yaml_file.stem
                        personas.append(config)
                except Exception as e:
                    logger.error(f"Failed to load {yaml_file}: {e}")

        return templates.TemplateResponse("personas.html", {
            "request": request,
            "personas": personas,
            "active_agents": [a.to_dict() for a in app.state.world.registry.all()]
        })

    @app.post("/api/personas")
    async def create_persona(request: Request):
        """Create a new persona and save to YAML."""
        data = await request.json()

        # Validate required fields
        if not data.get("name"):
            raise HTTPException(status_code=400, detail="Name is required")

        # Build persona config
        config = {
            "name": data["name"],
            "description": data.get("description", ""),
            "system_prompt": data.get("system_prompt", ""),
            "personality_traits": data.get("personality_traits", {}),
            "speaking_style": data.get("speaking_style", ""),
            "interests": data.get("interests", []),
            "response_tendency": float(data.get("response_tendency", 0.5)),
            "temperature": float(data.get("temperature", 0.7)),
            "model": data.get("model", "haiku"),
        }

        # Save to YAML file
        configs_dir = Path("configs/agents")
        configs_dir.mkdir(parents=True, exist_ok=True)

        filename = data["name"].lower().replace(" ", "_")
        filepath = configs_dir / f"{filename}.yaml"

        with open(filepath, "w") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)

        # Also add to running world
        try:
            agent = Agent.from_config(config)
            await app.state.world.add_agent(agent)
        except Exception as e:
            logger.warning(f"Persona saved but failed to add to running world: {e}")

        return {"status": "created", "filename": filename, "path": str(filepath)}

    @app.get("/api/personas")
    async def list_personas():
        """List all persona configs."""
        configs_dir = Path("configs/agents")
        personas = []
        if configs_dir.exists():
            for yaml_file in configs_dir.glob("*.yaml"):
                try:
                    with open(yaml_file) as f:
                        config = yaml.safe_load(f)
                        config["_filename"] = yaml_file.stem
                        personas.append(config)
                except Exception as e:
                    logger.error(f"Failed to load {yaml_file}: {e}")
        return personas

    @app.post("/api/personas/generate")
    async def generate_persona(request: Request):
        """Generate a new persona using LLM based on user prompt and existing personas."""
        data = await request.json()
        user_prompt = data.get("prompt", "")

        if not user_prompt:
            raise HTTPException(status_code=400, detail="Prompt is required")

        # Load existing personas for context
        configs_dir = Path("configs/agents")
        existing_personas = []
        if configs_dir.exists():
            for yaml_file in configs_dir.glob("*.yaml"):
                try:
                    with open(yaml_file) as f:
                        config = yaml.safe_load(f)
                        existing_personas.append({
                            "name": config.get("name"),
                            "description": config.get("description", "")[:100],
                            "personality_traits": config.get("personality_traits", {}),
                            "interests": config.get("interests", [])
                        })
                except Exception:
                    pass

        # Build the prompt for Claude
        system_prompt = """You are a persona designer for an AI chat simulation. Create unique, interesting personas that will have engaging conversations.

Given the user's description and the existing personas (to avoid overlap), generate a complete persona configuration.

IMPORTANT: Respond with ONLY valid JSON, no markdown formatting, no code blocks. The JSON must have this exact structure:
{
    "name": "SingleWordName",
    "description": "2-3 sentence description of who this persona is",
    "speaking_style": "How they speak - tone, patterns, quirks",
    "personality_traits": {
        "curiosity": 0.0-1.0,
        "assertiveness": 0.0-1.0,
        "humor": 0.0-1.0,
        "empathy": 0.0-1.0,
        "skepticism": 0.0-1.0,
        "creativity": 0.0-1.0
    },
    "interests": ["interest1", "interest2", "interest3"],
    "response_tendency": 0.0-1.0,
    "temperature": 0.5-0.9
}

Make the persona distinct, memorable, and different from existing ones."""

        existing_summary = "\n".join([
            f"- {p['name']}: {p['description']}" for p in existing_personas
        ]) if existing_personas else "None yet"

        user_message = f"""Create a persona based on this description:
"{user_prompt}"

Existing personas (create something different):
{existing_summary}

Generate the persona JSON:"""

        try:
            # Call Claude API
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not set")

            client = anthropic.Anthropic(api_key=api_key)
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1024,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}]
            )

            # Parse the response
            response_text = response.content[0].text.strip()

            # Try to extract JSON from the response
            try:
                # Handle potential markdown code blocks
                if "```" in response_text:
                    import re
                    json_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', response_text)
                    if json_match:
                        response_text = json_match.group(1)

                persona_data = json.loads(response_text)
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse LLM response: {response_text}")
                raise HTTPException(status_code=500, detail=f"Failed to parse generated persona: {str(e)}")

            # Add defaults
            persona_data.setdefault("model", "haiku")
            persona_data.setdefault("system_prompt", "")

            return persona_data

        except anthropic.APIError as e:
            logger.error(f"Anthropic API error: {e}")
            raise HTTPException(status_code=500, detail=f"LLM API error: {str(e)}")

    @app.post("/api/personas/generate-team")
    async def generate_team(request: Request):
        """Generate a team of personas from a single description."""
        data = await request.json()
        team_description = data.get("description", "")
        count = min(int(data.get("count", 5)), 15)  # Cap at 15

        if not team_description:
            raise HTTPException(status_code=400, detail="Team description is required")

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not set")

        # Load existing personas to avoid duplicates
        configs_dir = Path("configs/agents")
        existing_names = set()
        if configs_dir.exists():
            for yaml_file in configs_dir.glob("*.yaml"):
                try:
                    with open(yaml_file) as f:
                        config = yaml.safe_load(f)
                        existing_names.add(config.get("name", "").lower())
                except Exception:
                    pass

        system_prompt = f"""You are a team designer for an AI chat simulation. Generate a team of {count} personas based on the user's description.

Create a REALISTIC team composition - multiple people can share the same role (e.g., 2 baristas, 3 developers, 2 nurses). Not everyone needs a unique job title. What makes each persona distinct is their personality, background, and speaking style - not necessarily their role.

Each persona needs a unique NAME but can share roles/positions with others. Give them distinct personalities even if they do the same job.

IMPORTANT: Respond with ONLY a valid JSON array, no markdown, no code blocks. Each persona must have this structure:
[
  {{
    "name": "SingleWordName",
    "description": "2-3 sentence description of who this persona is and their role/position",
    "speaking_style": "How they speak - tone, patterns, quirks",
    "personality_traits": {{
      "curiosity": 0.0-1.0,
      "assertiveness": 0.0-1.0,
      "humor": 0.0-1.0,
      "empathy": 0.0-1.0,
      "skepticism": 0.0-1.0,
      "creativity": 0.0-1.0
    }},
    "interests": ["interest1", "interest2", "interest3"],
    "response_tendency": 0.0-1.0,
    "temperature": 0.5-0.9
  }}
]

Focus on realistic team dynamics - hierarchy, friendships, rivalries, mentorships between people who may share roles."""

        existing_list = ", ".join(existing_names) if existing_names else "None"
        user_message = f"""Create a team of {count} personas for: "{team_description}"

Existing persona names to avoid: {existing_list}

Generate the JSON array of {count} personas:"""

        try:
            client = anthropic.Anthropic(api_key=api_key)
            response = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=4096,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}]
            )

            response_text = response.content[0].text.strip()

            # Extract JSON from potential markdown
            if "```" in response_text:
                import re
                json_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', response_text)
                if json_match:
                    response_text = json_match.group(1)

            personas = json.loads(response_text)

            if not isinstance(personas, list):
                raise HTTPException(status_code=500, detail="Expected array of personas")

            # Save each persona
            configs_dir.mkdir(parents=True, exist_ok=True)
            saved = []

            for persona in personas:
                persona.setdefault("model", "haiku")
                persona.setdefault("system_prompt", "")

                filename = persona["name"].lower().replace(" ", "_")
                filepath = configs_dir / f"{filename}.yaml"

                # Skip if already exists
                if filepath.exists():
                    continue

                with open(filepath, "w") as f:
                    yaml.dump(persona, f, default_flow_style=False, allow_unicode=True)

                # Also add to running world
                try:
                    agent = Agent.from_config(persona)
                    await app.state.world.add_agent(agent)
                except Exception as e:
                    logger.warning(f"Persona {persona['name']} saved but failed to add to world: {e}")

                saved.append({"name": persona["name"], "filename": filename})

            return {"status": "created", "count": len(saved), "personas": saved}

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse team response: {response_text}")
            raise HTTPException(status_code=500, detail=f"Failed to parse generated team: {str(e)}")
        except anthropic.APIError as e:
            logger.error(f"Anthropic API error: {e}")
            raise HTTPException(status_code=500, detail=f"LLM API error: {str(e)}")

    @app.post("/api/personas/bulk-delete")
    async def bulk_delete_personas(request: Request):
        """Delete multiple personas at once."""
        data = await request.json()
        filenames = data.get("filenames", [])

        if not filenames:
            raise HTTPException(status_code=400, detail="No filenames provided")

        configs_dir = Path("configs/agents")
        deleted = []
        errors = []

        for filename in filenames:
            filepath = configs_dir / f"{filename}.yaml"
            if filepath.exists():
                try:
                    filepath.unlink()
                    deleted.append(filename)
                except Exception as e:
                    errors.append({"filename": filename, "error": str(e)})
            else:
                errors.append({"filename": filename, "error": "Not found"})

        return {"status": "deleted", "deleted": deleted, "errors": errors}

    @app.get("/api/personas/{filename}")
    async def get_persona(filename: str):
        """Get a specific persona config."""
        filepath = Path("configs/agents") / f"{filename}.yaml"
        if not filepath.exists():
            raise HTTPException(status_code=404, detail="Persona not found")

        with open(filepath) as f:
            config = yaml.safe_load(f)
            config["_filename"] = filename
        return config

    @app.put("/api/personas/{filename}")
    async def update_persona(filename: str, request: Request):
        """Update an existing persona."""
        filepath = Path("configs/agents") / f"{filename}.yaml"
        if not filepath.exists():
            raise HTTPException(status_code=404, detail="Persona not found")

        data = await request.json()

        # Build updated config
        config = {
            "name": data["name"],
            "description": data.get("description", ""),
            "system_prompt": data.get("system_prompt", ""),
            "personality_traits": data.get("personality_traits", {}),
            "speaking_style": data.get("speaking_style", ""),
            "interests": data.get("interests", []),
            "response_tendency": float(data.get("response_tendency", 0.5)),
            "temperature": float(data.get("temperature", 0.7)),
            "model": data.get("model", "haiku"),
        }

        with open(filepath, "w") as f:
            yaml.dump(config, f, default_flow_style=False, allow_unicode=True)

        return {"status": "updated", "filename": filename}

    @app.delete("/api/personas/{filename}")
    async def delete_persona(filename: str):
        """Delete a persona config."""
        filepath = Path("configs/agents") / f"{filename}.yaml"
        if not filepath.exists():
            raise HTTPException(status_code=404, detail="Persona not found")

        filepath.unlink()
        return {"status": "deleted", "filename": filename}

    return app
