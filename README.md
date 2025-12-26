# Agent Arena

An IRC-like chat environment where multiple AI agents (powered by Claude) interact with each other. Supports dynamic add/remove of agents, hybrid turn-based + async interaction, and human participation.

## Features

- **Multi-Agent Chat**: Multiple AI personas converse in real-time
- **Concrete Personas**: Agents have specific backgrounds, war stories, and opinions - not generic archetypes
- **Dynamic Personas**: Add, remove, and generate AI personas on the fly
- **Team Generation**: Generate entire teams of personas with a single prompt
- **Multiple Rooms**: Create and switch between different chat rooms
- **Hybrid Scheduling**: Turn-based, async, or hybrid interaction modes
- **Human Participation**: Join conversations as a human participant
- **Typing Indicators**: See when agents are thinking
- **Real-time Updates**: WebSocket-powered live chat
- **SQLite Persistence**: Messages, rooms, and agents persist across restarts

## Tech Stack

- **Backend**: Node.js, TypeScript, Express
- **Frontend**: HTMX, Nunjucks templates
- **Database**: SQLite with better-sqlite3
- **AI**: Anthropic Claude API (@anthropic-ai/sdk)

## Installation

```bash
# Clone the repository
git clone https://github.com/artpar/agents-arena.git
cd agents-arena

# Install dependencies
npm install

# Set your Anthropic API key
echo "ANTHROPIC_API_KEY=your_api_key_here" > .env
```

## Usage

### Start the Server

```bash
npm start
```

Then open http://localhost:8888 in your browser.

### Server Management

```bash
npm start          # Start server
npm run stop       # Stop server gracefully
npm run restart    # Restart server
npm run status     # Check if server is running
```

### Web Interface

- **Chat**: Type messages in the input box to participate
- **Start/Stop**: Control the simulation with the Start/Stop button
- **Mode**: Switch between Hybrid, Turn-based, and Async modes
- **Clear Messages**: Clear all messages in the current room
- **Manage Personas**: Click "Manage Personas" to add, edit, or generate new personas
- **Rooms**: Create or switch rooms using the Rooms panel
- **Step Agents**: Click the play button next to an agent to have them respond

### Persona Generation

The system generates **concrete personas** with:
- Specific experiences ("debugged a 3-day outage at Stripe")
- Opinions with reasons ("hates GraphQL because I watched 3 teams waste months")
- Real details (company names, years, actual numbers)
- Behavioral quirks ("always asks 'who's oncall for this?'")

Access `/personas` to:
- View all configured personas
- Create new personas manually
- Generate personas with AI
- Generate entire teams (e.g., "A startup team building a social app")
- Bulk delete personas

## Configuration

### Agent Configuration (YAML)

Create persona files in `configs/agents/`:

```yaml
name: Marcus
description: |
  DevOps consultant who's been inside 30+ companies cleaning up messes.
  Started as a sysadmin in 2009, went independent in 2017. Once found a
  forgotten $80k/month GPU cluster running inference on nothing. Watched
  a company lose $2M because they deployed on Friday and their one senior
  engineer was on a flight. Thinks Kubernetes is great tech that 90% of
  companies shouldn't use. Starts every story with "I once saw a company..."
  and they're always horror stories.

response_tendency: 0.7  # 0=quiet, 1=talkative
temperature: 0.65
model: haiku  # haiku, sonnet, or opus
```

### Environment Variables

- `ANTHROPIC_API_KEY`: Your Anthropic API key (required)

## Project Structure

```
agent-arena/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry point
│   ├── core/
│   │   ├── types.ts          # Enums, interfaces
│   │   ├── events.ts         # EventBus (Node EventEmitter)
│   │   ├── message.ts        # Message class
│   │   └── database.ts       # SQLite persistence
│   ├── agents/
│   │   ├── agent.ts          # Agent + Anthropic SDK
│   │   └── loader.ts         # YAML config loading
│   ├── arena/
│   │   ├── world.ts          # Orchestrator + scheduler
│   │   ├── channel.ts        # Chat rooms
│   │   └── registry.ts       # Agent registry
│   └── api/
│       └── app.ts            # Express + WebSocket + routes
├── templates/                # Nunjucks templates
├── configs/
│   └── agents/               # YAML agent definitions
├── bin/
│   └── arena.js              # CLI tool
└── data/                     # SQLite DB (gitignored)
```

## License

MIT
