# Agent Arena Architecture

## Overview

Agent Arena uses a **Values & Boundaries** architecture with an **Actor System** for concurrency. This design separates pure logic from side effects, making the system testable, predictable, and maintainable.

## Core Principles

### 1. Values & Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                      HTTP / WebSocket                       │
│                       (Boundary)                            │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                         API Layer                           │
│              Express routes → Actor Messages                │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                      Runtime Layer                          │
│       Actor System + Effect Executors (Boundaries)          │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                   Interpreters Layer                        │
│    Pure functions: (State, Message) → [NewState, Effect[]]  │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                      Values Layer                           │
│       Immutable data types (ChatMessage, AgentState)        │
└─────────────────────────────────────────────────────────────┘
```

**Key Insight**: Side effects (I/O) happen only at boundaries. The core logic is pure functions that take state + message and return new state + effects (data describing what to do).

### 2. Actor Model

Each entity (agent, room, director) is an actor with:
- **Mailbox**: Queue of incoming messages
- **State**: Immutable, replaced on each message
- **Interpreter**: Pure function `(state, msg) → [newState, effects]`

```
Message → Actor Mailbox → Interpreter → [NewState, Effects]
                                              │
                                              ▼
                                        Effect Executor
                                              │
                          ┌───────────────────┼───────────────────┐
                          ▼                   ▼                   ▼
                     Database            Anthropic            Broadcast
                     Boundary            Boundary             Boundary
```

### 3. Effect System

Effects are **data describing side effects**, not the side effects themselves:

```typescript
// Effect is DATA, not execution
const effect: Effect = dbSaveMessage(message);

// Executor performs actual I/O
await executor.execute(effect);
```

## Directory Structure

```
src/
├── values/           # Immutable data types
│   ├── ids.ts        # Branded ID types (RoomId, AgentId, etc.)
│   ├── message.ts    # ChatMessage type and helpers
│   ├── agent.ts      # AgentConfig, AgentState
│   ├── room.ts       # RoomConfig, RoomState
│   └── project.ts    # ProjectState, Task, Artifact
│
├── effects/          # Effect type definitions
│   ├── database.ts   # DB_SAVE_MESSAGE, DB_LOAD_MESSAGES, etc.
│   ├── anthropic.ts  # CALL_ANTHROPIC, CANCEL_API_CALL
│   ├── tools.ts      # EXECUTE_TOOL, READ_FILE, RUN_BASH
│   ├── broadcast.ts  # BROADCAST_TO_ROOM, SEND_TO_CLIENT
│   ├── actor.ts      # SEND_TO_ACTOR, SPAWN_AGENT_ACTOR
│   └── index.ts      # Unified Effect type
│
├── interpreters/     # Pure state machines
│   ├── agent.ts      # Agent behavior (responds to messages, uses tools)
│   ├── room.ts       # Room behavior (message routing, agent selection)
│   ├── director.ts   # Orchestrator (starts/stops simulation)
│   └── project.ts    # Project behavior (task assignment)
│
├── runtime/          # Boundary executors (actual I/O)
│   ├── database.ts   # SQLite operations
│   ├── anthropic.ts  # Claude API calls
│   ├── tools.ts      # File I/O, bash execution
│   ├── broadcast.ts  # WebSocket broadcasts
│   ├── actor.ts      # Actor message routing
│   └── executor.ts   # Unified effect executor
│
├── api/              # HTTP/WebSocket layer
│   └── app.ts        # Express routes, WebSocket handlers
│
├── tools/            # Tool implementations
│   ├── bash-tool.ts  # Shell command execution
│   ├── text-editor-tool.ts  # File editing
│   └── memory-tool.ts       # Agent memory
│
├── core/             # Legacy/shared utilities
│   ├── database.ts   # High-level DB functions
│   └── events.ts     # EventBus
│
├── server.ts         # Server creation and lifecycle
├── main.ts           # Entry point with startup
└── index.ts          # Module exports
```

## Data Flow

### 1. User Sends Message

```
HTTP POST /rooms/:id/messages
         │
         ▼
    API Layer: Create ChatMessage value
         │
         ▼
    Actor: Send ROOM_MESSAGE to room actor
         │
         ▼
    Room Interpreter: (state, msg) → [newState, effects]
         │
         ├── Effect: dbSaveMessage(message)
         ├── Effect: broadcastToRoom(roomId, messageAdded(...))
         └── Effect: sendToAgent(agentId, RESPOND_TO_MESSAGE)
         │
         ▼
    Effect Executors: Execute each effect
```

### 2. Agent Responds

```
    Agent receives RESPOND_TO_MESSAGE
         │
         ▼
    Agent Interpreter: Prepare API request
         │
         └── Effect: callAnthropic(request)
         │
         ▼
    Anthropic Executor: Call Claude API
         │
         ▼
    API Response routed back to agent
         │
         ▼
    Agent Interpreter: Process response
         │
         ├── If tool_use: Effect: executeTool(...)
         └── If text: Effect: sendToRoom(response)
```

### 3. Tool Execution

```
    Agent requests tool execution
         │
         ▼
    Tool Executor: Execute tool (file I/O, bash, etc.)
         │
         ▼
    Results routed back to agent
         │
         ▼
    Agent Interpreter: Build tool_result message
         │
         └── Effect: callAnthropic(request with tool_result)
         │
         ▼
    (Loop until final text response)
```

## Actor Types

### Director Actor
- **Address**: `director:main`
- **Responsibility**: Orchestrates simulation, starts/stops agents
- **Messages**: START_SIMULATION, STOP_SIMULATION, STEP

### Room Actor
- **Address**: `room:{roomId}`
- **Responsibility**: Message routing, agent selection
- **Messages**: ROOM_MESSAGE, AGENT_RESPONSE, JOIN_ROOM, LEAVE_ROOM

### Agent Actor
- **Address**: `agent:{agentId}`
- **Responsibility**: AI responses, tool usage
- **Messages**: RESPOND_TO_MESSAGE, API_RESPONSE, TOOL_RESULT

### Project Actor
- **Address**: `project:{projectId}`
- **Responsibility**: Task management, build coordination
- **Messages**: ASSIGN_TASK, TASK_COMPLETED, TASK_FAILED

## Effect Categories

| Category | Effects | Executor |
|----------|---------|----------|
| **Database** | `DB_SAVE_MESSAGE`, `DB_LOAD_MESSAGES`, `DB_LOG_EVENT` | SQLite |
| **Anthropic** | `CALL_ANTHROPIC`, `CANCEL_API_CALL` | Claude API |
| **Tools** | `EXECUTE_TOOL`, `READ_FILE`, `WRITE_FILE`, `RUN_BASH` | File I/O |
| **Broadcast** | `BROADCAST_TO_ROOM`, `BROADCAST_TO_ALL` | WebSocket |
| **Actor** | `SEND_TO_ACTOR`, `SPAWN_AGENT_ACTOR`, `STOP_ACTOR` | Actor Runtime |

## Database Schema

```sql
-- Messages
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'chat',
  timestamp INTEGER NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  attachments TEXT NOT NULL DEFAULT '[]'
);

-- Agents (personas)
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,  -- JSON blob
  description TEXT,
  system_prompt TEXT,
  personality_traits TEXT DEFAULT '{}',
  temperature REAL DEFAULT 0.7,
  model TEXT DEFAULT 'claude-haiku-4-5-20251001',
  status TEXT DEFAULT 'offline',
  message_count INTEGER DEFAULT 0
);

-- Event Log (tool_use, tool_result, etc.)
CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Rooms, Projects, Tasks (additional tables)
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |

### Runtime Configuration

```typescript
const config = createRuntimeConfig({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  databasePath: './data/arena.db',
  workspacePath: './workspaces',      // Agent workspace
  sharedWorkspacePath: './shared',    // Shared files
  maxToolExecutionTime: 30000,        // 30s timeout
  enableLogging: true
});
```

### Agent Configuration

Agents are configured via the Persona Manager UI or API:

```json
{
  "name": "Maya Chen",
  "description": "Senior PM with 12 years experience...",
  "system_prompt": "You are Maya Chen, a product manager...",
  "personality_traits": {
    "analytical": 0.9,
    "collaborative": 0.8
  },
  "temperature": 0.7,
  "model": "haiku",
  "response_tendency": 0.6
}
```

## Key Design Decisions

### Why Values & Boundaries?

1. **Testability**: Pure interpreters can be tested without mocks
2. **Predictability**: Same input always produces same output
3. **Debugging**: Effects are data, can be logged/inspected
4. **Flexibility**: Swap executors without changing logic

### Why Actor Model?

1. **Concurrency**: Each actor processes messages independently
2. **Isolation**: Actor state is private, no shared mutable state
3. **Scalability**: Add more actors without changing architecture
4. **Fault Tolerance**: Actors can be restarted independently

### Why Separate UI from Agent Loop?

1. **Single Source of Truth**: Database is the authority
2. **Decoupling**: UI changes don't affect agent logic
3. **Persistence**: Tool events survive restarts
4. **Flexibility**: Multiple UIs can read the same data

## API Endpoints

### HTML Routes
- `GET /` - Main chat interface
- `GET /personas` - Persona management UI

### REST API
- `GET /api/status` - Simulation status
- `POST /api/start` - Start simulation
- `POST /api/stop` - Stop simulation
- `GET /api/rooms` - List rooms
- `GET /rooms/:id/messages` - Get room messages
- `POST /rooms/:id/messages` - Send message
- `GET /api/agents` - List active agents
- `POST /agents/:id/register` - Add agent to simulation
- `DELETE /agents/:id/unregister` - Remove agent
- `GET /api/personas` - List all personas
- `POST /api/personas` - Create persona
- `PUT /api/personas/:id` - Update persona
- `DELETE /api/personas/:id` - Delete persona

### WebSocket Events
- `message_added` - New message in room
- `agent_typing` - Agent thinking indicator
- `agent_status` - Agent status change
- `build_progress` - Tool execution progress
