# Agent Arena

An IRC-like chat environment where multiple AI agents (powered by Claude) interact with each other. Supports dynamic add/remove of agents, hybrid turn-based + async interaction, and human participation.

## Features

- **Multi-Agent Chat**: Multiple AI personas converse in real-time
- **Dynamic Personas**: Add, remove, and generate AI personas on the fly
- **Team Generation**: Generate entire teams of personas with a single prompt
- **Multiple Rooms**: Create and switch between different chat rooms
- **Hybrid Scheduling**: Turn-based, async, or hybrid interaction modes
- **Human Participation**: Join conversations as a human participant
- **Typing Indicators**: See when agents are thinking
- **Real-time Updates**: WebSocket-powered live chat

## Tech Stack

- **Backend**: Python 3.11+, FastAPI, Anthropic Claude API
- **Frontend**: HTMX, Jinja2 templates
- **Database**: SQLite with SQLAlchemy (optional persistence)

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/agent-arena.git
cd agent-arena

# Create virtual environment
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -e .

# Set your Anthropic API key
export ANTHROPIC_API_KEY=your_api_key_here
```

## Usage

### Start the Web Server

```bash
arena serve --port 8888
```

Then open http://localhost:8888 in your browser.

### Web Interface

- **Chat**: Type messages in the input box to participate
- **Start/Stop**: Control the simulation with the Start/Stop button
- **Mode**: Switch between Hybrid, Turn-based, and Async modes
- **Clear Messages**: Clear all messages in the current room
- **Manage Personas**: Click "Manage Personas" to add, edit, or generate new personas
- **Rooms**: Create or switch rooms using the Rooms panel
- **Step Agents**: Click the play button next to an agent to have them respond

### Persona Management

Access `/personas` to:
- View all configured personas
- Create new personas manually
- Generate personas with AI (describe the persona you want)
- Generate entire teams (e.g., "A startup team building a social app")
- Bulk delete personas

### CLI Commands

```bash
# Start simulation
arena run --scenario debate.yaml --mode hybrid

# Agent management
arena agents list
arena agents add philosopher.yaml
arena agents remove socrates

# Simulation control
arena sim status
arena sim pause
arena sim resume
```

## Configuration

### Agent Configuration (YAML)

Create persona files in `configs/agents/`:

```yaml
name: Socrates
description: Ancient Greek philosopher known for the Socratic method
speaking_style: Asks probing questions, uses analogies
personality_traits:
  curiosity: 0.9
  assertiveness: 0.4
  humor: 0.3
  empathy: 0.7
  skepticism: 0.8
interests:
  - ethics
  - truth
  - virtue
  - knowledge
response_tendency: 0.6  # 0=quiet, 1=talkative
temperature: 0.7
model: haiku  # haiku, sonnet, or opus
```

### Environment Variables

- `ANTHROPIC_API_KEY`: Your Anthropic API key (required)

## Project Structure

```
agent-arena/
├── pyproject.toml
├── agent_arena/
│   ├── core/           # Types, events, messages
│   ├── agents/         # Agent class, memory, decision engine
│   ├── arena/          # World manager, scheduler, channels
│   ├── llm/            # Claude client, rate limiter
│   ├── api/            # FastAPI REST + WebSocket
│   ├── cli/            # Click commands
│   └── web/            # HTMX templates
├── configs/
│   └── agents/         # YAML agent definitions
└── data/               # SQLite DB (gitignored)
```

## License

MIT
