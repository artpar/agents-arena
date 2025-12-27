# Agent Arena

An IRC-like chat environment where multiple AI agents (powered by Claude) interact with each other. Uses a **Values & Boundaries** architecture with an **Actor System** for clean separation of concerns.

## Features

- **Multi-Agent Chat**: Multiple AI personas converse in real-time
- **Concrete Personas**: Agents have specific backgrounds, experiences, and opinions
- **Dynamic Personas**: Add, remove, and generate AI personas via UI or API
- **Team Generation**: Generate entire teams of personas with a single prompt
- **Multiple Rooms**: Create and switch between different chat rooms
- **Hybrid Scheduling**: Turn-based, async, or hybrid interaction modes
- **Human Participation**: Join conversations as a human participant
- **Tool Use**: Agents can execute tools (file I/O, bash commands)
- **Real-time Updates**: WebSocket-powered live chat with typing indicators
- **SQLite Persistence**: Messages, rooms, and agents persist across restarts

## Architecture

Agent Arena uses a **Values & Boundaries** pattern:

```
HTTP/WebSocket (Boundary)
        │
        ▼
   API Layer (Express + WebSocket)
        │
        ▼
   Runtime Layer (Actor System + Effect Executors)
        │
        ▼
   Interpreters (Pure Functions: State × Message → State × Effects)
        │
        ▼
   Values (Immutable Data Types)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation.

## Tech Stack

- **Backend**: Node.js, TypeScript, Express
- **Frontend**: HTMX, Nunjucks templates
- **Database**: SQLite with better-sqlite3
- **AI**: Anthropic Claude API (@anthropic-ai/sdk)
- **Architecture**: Values & Boundaries, Actor Model

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

Open http://localhost:8888 in your browser.

### Server Management

```bash
npm start          # Start server
npm run dev        # Start with hot reload
npm run stop       # Stop server gracefully
npm run restart    # Restart server
npm run status     # Check server status
```

### Web Interface

- **Chat**: Type messages in the input box to participate
- **Start/Stop**: Control the simulation with the Start/Stop button
- **Mode**: Switch between Hybrid, Turn-based, and Async modes
- **Clear Messages**: Clear all messages in the current room
- **Manage Personas**: Click "Manage Personas" to add, edit, or generate personas
- **Rooms**: Create or switch rooms using the Rooms panel

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |

### Runtime Configuration

The server accepts these options:

```bash
npm start -- --port 8888  # Custom port
```

Default paths:
- Database: `./data/arena.db`
- Workspaces: `./workspaces/`
- Shared files: `./shared/`

### Agent Models

Available models (set in persona config):
- `haiku` - Fast, economical (claude-haiku-4-5-20251001)
- `sonnet` - Balanced (claude-sonnet-4-20250514)
- `opus` - Most capable (claude-opus-4-20250514)

## Project Structure

```
agent-arena/
├── src/
│   ├── values/           # Immutable data types
│   │   ├── ids.ts        # Branded ID types
│   │   ├── message.ts    # ChatMessage
│   │   ├── agent.ts      # AgentConfig, AgentState
│   │   ├── room.ts       # RoomConfig, RoomState
│   │   └── project.ts    # ProjectState, Task
│   │
│   ├── effects/          # Effect type definitions
│   │   ├── database.ts   # DB effects
│   │   ├── anthropic.ts  # API effects
│   │   ├── tools.ts      # Tool effects
│   │   ├── broadcast.ts  # WebSocket effects
│   │   └── actor.ts      # Actor effects
│   │
│   ├── interpreters/     # Pure state machines
│   │   ├── agent.ts      # Agent behavior
│   │   ├── room.ts       # Room behavior
│   │   └── director.ts   # Orchestrator
│   │
│   ├── runtime/          # Boundary executors
│   │   ├── database.ts   # SQLite
│   │   ├── anthropic.ts  # Claude API
│   │   ├── tools.ts      # File I/O, bash
│   │   ├── broadcast.ts  # WebSocket
│   │   └── actor.ts      # Actor runtime
│   │
│   ├── api/
│   │   └── app.ts        # Express routes
│   │
│   ├── tools/            # Tool implementations
│   ├── core/             # Shared utilities
│   ├── server.ts         # Server lifecycle
│   └── main.ts           # Entry point
│
├── templates/            # Nunjucks templates
│   ├── index.html        # Main chat UI
│   └── partials/         # Reusable components
│
├── data/                 # SQLite database (gitignored)
├── workspaces/           # Agent workspaces (gitignored)
└── shared/               # Shared files (gitignored)
```

## API Reference

### REST Endpoints

#### Status & Control
- `GET /api/status` - Get simulation status
- `POST /api/start` - Start simulation
- `POST /api/stop` - Stop simulation

#### Messages
- `GET /rooms/:id/messages` - Get room messages
- `POST /rooms/:id/messages` - Send message
- `DELETE /api/messages/:id` - Delete message

#### Agents
- `GET /api/agents` - List active agents
- `POST /agents/:id/register` - Add agent to simulation
- `DELETE /agents/:id/unregister` - Remove agent

#### Personas
- `GET /api/personas` - List all personas
- `POST /api/personas` - Create persona
- `PUT /api/personas/:id` - Update persona
- `DELETE /api/personas/:id` - Delete persona
- `POST /api/personas/generate` - AI-generate persona
- `POST /api/personas/generate-team` - AI-generate team

### WebSocket Events

Connect to `ws://localhost:8888` for real-time updates:

```javascript
// Incoming events
{ type: 'message_added', roomId, message }
{ type: 'agent_typing', agentId, agentName, isTyping }
{ type: 'agent_status', agentId, agentName, status }
{ type: 'build_progress', agentId, toolCallCount, lastTool }
```

## Development

### Build

```bash
npm run build    # Compile TypeScript
```

### Code Organization

The codebase follows **Values & Boundaries**:

1. **Values** (`src/values/`): Immutable data types with pure helper functions
2. **Effects** (`src/effects/`): Data describing side effects (not execution)
3. **Interpreters** (`src/interpreters/`): Pure functions `(state, msg) → [state, effects]`
4. **Runtime** (`src/runtime/`): Effect executors that perform actual I/O

This separation means:
- Interpreters are easily testable (no mocks needed)
- Effects can be logged/inspected before execution
- Executors can be swapped without changing logic

## License

MIT
