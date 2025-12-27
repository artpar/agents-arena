/**
 * Server Factory
 *
 * Creates and configures the HTTP/WebSocket server using the
 * Values & Boundaries architecture.
 *
 * ARCHITECTURE:
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    HTTP / WebSocket                         │
 * │                          │                                   │
 * │      ┌──────────────────┴──────────────────┐                │
 * │      │            Express App              │                │
 * │      │  Routes → Messages → Actor Runtime  │                │
 * │      └──────────────────┬──────────────────┘                │
 * │                          │                                   │
 * │      ┌──────────────────┴──────────────────┐                │
 * │      │          RuntimeContext             │                │
 * │      │  - Database   - Anthropic           │                │
 * │      │  - Tools      - Broadcast           │                │
 * │      │  - Actors                           │                │
 * │      └─────────────────────────────────────┘                │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 */

import express, { Request, Response } from 'express';
import { createServer as createHttpServer, Server } from 'http';
import { WebSocketServer } from 'ws';
import nunjucks from 'nunjucks';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

import {
  RuntimeContext,
  createRuntimeContext,
  createRuntimeConfig,
  setupWebSocketHandlers,
  addClient,
  moveClientToRoom
} from './runtime/index.js';
import {
  directorAddress,
  roomAddress,
  agentAddress
} from './effects/actor.js';
import { respondToMessage } from './interpreters/room.js';
import {
  createChatMessage,
  ChatMessage
} from './values/message.js';
import { RoomId, AgentId, generateRoomId, generateAgentId } from './values/ids.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const UPLOADS_DIR = join(__dirname, '..', 'uploads');

// Ensure uploads directory exists
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueId = uuidv4();
    const ext = extname(file.originalname);
    cb(null, `${uniqueId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'text/plain', 'text/markdown'
    ];
    cb(null, allowedTypes.includes(file.mimetype));
  }
});

// ============================================================================
// SERVER CONFIGURATION
// ============================================================================

export interface ServerConfig {
  port: number;
  anthropicApiKey: string;
  databasePath: string;
  workspacePath?: string;
  sharedWorkspacePath?: string;
}

export interface ServerInstance {
  server: Server;
  runtime: RuntimeContext;
  shutdown: () => Promise<void>;
}

// ============================================================================
// SERVER FACTORY
// ============================================================================

/**
 * Create and configure the server.
 */
export async function createServer(config: ServerConfig): Promise<ServerInstance> {
  // Create runtime context
  const runtimeConfig = createRuntimeConfig({
    anthropicApiKey: config.anthropicApiKey,
    databasePath: config.databasePath,
    workspacePath: config.workspacePath ?? './workspaces',
    sharedWorkspacePath: config.sharedWorkspacePath ?? './shared',
    enableLogging: true
  });

  const runtime = createRuntimeContext(runtimeConfig);

  // Create Express app
  const app = express();
  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server });

  // Configure Nunjucks
  const nunjucksEnv = nunjucks.configure(TEMPLATES_DIR, {
    autoescape: true,
    express: app,
    watch: false
  });

  nunjucksEnv.addFilter('slice', (str: string | undefined, start: number, end?: number) => {
    return typeof str === 'string' ? str.slice(start, end) : '';
  });

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/uploads', express.static(UPLOADS_DIR));

  // ============================================================================
  // WEBSOCKET SETUP
  // ============================================================================

  setupWebSocketHandlers(
    wss,
    runtime.broadcast,
    runtime.logger,
    (clientId) => {
      runtime.logger.info('Client connected', { clientId });
    },
    (clientId) => {
      runtime.logger.info('Client disconnected', { clientId });
    },
    (clientId, message) => {
      handleClientMessage(runtime, clientId, message);
    }
  );

  // ============================================================================
  // HTML ROUTES
  // ============================================================================

  app.get('/', (req: Request, res: Response) => {
    const status = getStatus(runtime);
    res.render('index.html', {
      status,
      agents: getAgents(runtime)
    });
  });

  app.get('/messages', (req: Request, res: Response) => {
    const messages = getMessages(runtime, 50);
    res.render('partials/messages.html', { messages });
  });

  app.get('/agents-list', (req: Request, res: Response) => {
    res.render('partials/agents.html', {
      agents: getAgents(runtime)
    });
  });

  app.get('/status-panel', (req: Request, res: Response) => {
    res.render('partials/status.html', {
      status: getStatus(runtime)
    });
  });

  app.get('/topic-panel', (req: Request, res: Response) => {
    res.render('partials/topic.html', {
      topic: '',
      channel_name: 'general'
    });
  });

  app.get('/project-panel', (req: Request, res: Response) => {
    res.render('partials/project.html', {
      project: null,
      agents: getAgents(runtime)
    });
  });

  // ============================================================================
  // ACTION ROUTES
  // ============================================================================

  app.post('/send', upload.array('files', 5), async (req: Request, res: Response) => {
    const { sender = 'Human' } = req.body;
    const messageContent = req.body.content?.trim();
    const files = req.files as Express.Multer.File[] | undefined;

    // Build attachments
    const attachments = (files || []).map(file => ({
      id: file.filename.split('.')[0],
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      url: `/uploads/${file.filename}`
    }));

    if (!messageContent && attachments.length === 0) {
      res.status(400).json({ error: 'Message content required' });
      return;
    }

    // Create message and send to director
    const message = createChatMessage({
      senderId: 'human' as AgentId,
      senderName: sender,
      content: messageContent || '[Attachment]',
      roomId: 'general' as RoomId,
      attachments: attachments.length > 0 ? attachments : undefined
    });

    // Send to director for routing
    runtime.actors.send(directorAddress(), {
      type: 'INJECT_MESSAGE',
      message
    });

    res.send('');
  });

  app.post('/start', async (req: Request, res: Response) => {
    const mode = req.body.mode || 'hybrid';
    const maxTurns = parseInt(req.body.maxTurns) || 20;

    // Send start command to director
    runtime.actors.send(directorAddress(), {
      type: 'START',
      mode,
      maxTurns
    });

    const status = { running: true, mode, max_turns: maxTurns };
    res.render('partials/controls.html', { status });
  });

  app.post('/stop', async (req: Request, res: Response) => {
    // Send stop command to director
    runtime.actors.send(directorAddress(), {
      type: 'STOP'
    });

    const status = { running: false, mode: 'hybrid', max_turns: 20 };
    res.render('partials/controls.html', { status });
  });

  // ============================================================================
  // API ROUTES
  // ============================================================================

  app.get('/api/status', (req: Request, res: Response) => {
    res.json(getStatus(runtime));
  });

  app.get('/api/agents', (req: Request, res: Response) => {
    res.json(getAgents(runtime));
  });

  app.get('/api/messages', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(getMessages(runtime, limit));
  });

  // Delete a message by ID
  app.delete('/api/messages/:messageId', (req: Request, res: Response) => {
    const { messageId } = req.params;
    try {
      const stmt = runtime.database.db.prepare('DELETE FROM messages WHERE id = ?');
      const result = stmt.run(messageId);
      if (result.changes > 0) {
        // Notify connected clients via WebSocket
        for (const client of runtime.broadcast.clients.values()) {
          if (client.ws.readyState === 1) { // OPEN
            client.ws.send(JSON.stringify({
              type: 'message_deleted',
              messageId
            }));
          }
        }
        res.json({ status: 'deleted', messageId });
      } else {
        res.status(404).json({ error: 'Message not found' });
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete message' });
    }
  });

  app.post('/agents/add', async (req: Request, res: Response) => {
    const config = req.body;
    // Accept both 'name' and 'config_path' (from form)
    const agentName = config.name || config.config_path;
    if (!agentName) {
      res.status(400).json({ error: 'Agent name required' });
      return;
    }

    // Send spawn command to director
    runtime.actors.send(directorAddress(), {
      type: 'SPAWN_AGENT',
      config: {
        id: generateAgentId(),
        name: agentName,
        description: config.description || '',
        systemPrompt: config.system_prompt || '',
        model: config.model || 'haiku',
        temperature: parseFloat(config.temperature) || 0.7,
        responseTendency: parseFloat(config.response_tendency) || 0.5,
        personalityTraits: config.personality_traits || {},
        speakingStyle: config.speaking_style || '',
        interests: config.interests || []
      }
    });

    res.render('partials/agents.html', {
      agents: getAgents(runtime)
    });
  });

  app.delete('/agents/:agentId', async (req: Request, res: Response) => {
    // Send stop command to director
    runtime.actors.send(directorAddress(), {
      type: 'STOP_AGENT',
      agentId: req.params.agentId as AgentId
    });

    res.json({ status: 'removed' });
  });

  // Trigger agent to respond to latest message in room
  app.post('/agents/:agentId/step', async (req: Request, res: Response) => {
    const agentId = req.params.agentId as AgentId;
    const roomId = (req.body.roomId || 'general') as RoomId;

    // Get recent messages from database for context
    const stmt = runtime.database.db.prepare(`
      SELECT id, room_id, sender_id, sender_name, content, type, timestamp, mentions, attachments
      FROM messages
      WHERE room_id = ?
      ORDER BY timestamp DESC
      LIMIT 20
    `);
    const rows = stmt.all(roomId) as Array<{
      id: string;
      room_id: string;
      sender_id: string;
      sender_name: string;
      content: string;
      type: string;
      timestamp: number;
      mentions: string;
      attachments: string;
    }>;

    if (rows.length === 0) {
      res.status(400).json({ error: 'No messages in room to respond to' });
      return;
    }

    // Convert to ChatMessage format (oldest first for context)
    const contextMessages: ChatMessage[] = rows.reverse().map(row => createChatMessage({
      id: row.id,
      roomId: row.room_id as RoomId,
      senderId: row.sender_id,
      senderName: row.sender_name,
      content: row.content,
      type: row.type as 'chat' | 'join' | 'leave' | 'system',
      timestamp: row.timestamp
    }));

    const triggerMessage = contextMessages[contextMessages.length - 1];

    // Send RESPOND_TO_MESSAGE directly to the agent
    runtime.actors.send(agentAddress(agentId), respondToMessage(
      roomId,
      contextMessages,
      triggerMessage
    ));

    res.json({ status: 'stepped', agentId, roomId });
  });

  // Room switching
  app.get('/r/:roomName', async (req: Request, res: Response) => {
    const roomName = req.params.roomName.toLowerCase().replace(/ /g, '-');
    const roomId = `room_${roomName}` as RoomId;

    // Send room creation/join to director
    runtime.actors.send(directorAddress(), {
      type: 'JOIN_ROOM',
      roomId,
      roomName
    });

    res.render('index.html', {
      status: getStatus(runtime),
      agents: getAgents(runtime),
      current_room: roomName
    });
  });

  app.get('/api/rooms', (req: Request, res: Response) => {
    res.json(getRooms(runtime));
  });

  // Topic API
  app.get('/api/topic', (req: Request, res: Response) => {
    res.json({ topic: '', name: 'general' });
  });

  app.post('/api/topic', (req: Request, res: Response) => {
    const { topic = '' } = req.body;
    res.json({ status: 'updated', topic });
  });

  // Delete messages
  app.delete('/api/messages', (req: Request, res: Response) => {
    runtime.database.db.exec('DELETE FROM messages');
    res.json({ status: 'cleared' });
  });

  // Artifacts API (stub)
  app.get('/api/artifacts', (req: Request, res: Response) => {
    res.json([]);
  });

  // Projects API
  app.get('/api/projects', (req: Request, res: Response) => {
    try {
      const stmt = runtime.database.db.prepare(`
        SELECT id, name, goal, room_id, phase, state, created_at, updated_at
        FROM projects
        ORDER BY updated_at DESC
      `);
      const rows = stmt.all() as Array<{
        id: string;
        name: string;
        goal: string;
        room_id: string;
        phase: string;
        state: string;
        created_at: number;
        updated_at: number;
      }>;
      res.json(rows.map(row => ({
        id: row.id,
        name: row.name,
        goal: row.goal,
        room_id: row.room_id,
        phase: row.phase,
        state: JSON.parse(row.state || '{}'),
        created_at: row.created_at,
        updated_at: row.updated_at
      })));
    } catch {
      res.json([]);
    }
  });

  app.post('/api/projects', (req: Request, res: Response) => {
    const { name, goal, roomId = 'general' } = req.body;
    if (!name || !goal) {
      res.status(400).json({ error: 'Name and goal required' });
      return;
    }

    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stmt = runtime.database.db.prepare(`
      INSERT INTO projects (id, name, goal, room_id, phase, state)
      VALUES (?, ?, ?, ?, 'planning', '{}')
    `);
    stmt.run(projectId, name, goal, roomId);

    res.json({ id: projectId, name, goal, room_id: roomId, phase: 'planning' });
  });

  app.delete('/api/projects/:projectId', (req: Request, res: Response) => {
    const { projectId } = req.params;
    const stmt = runtime.database.db.prepare('DELETE FROM projects WHERE id = ?');
    const result = stmt.run(projectId);
    if (result.changes > 0) {
      res.json({ status: 'deleted', projectId });
    } else {
      res.status(404).json({ error: 'Project not found' });
    }
  });

  // Personas page
  app.get('/personas', (req: Request, res: Response) => {
    res.render('personas.html', {
      personas: getAgents(runtime),
      active_agents: getAgents(runtime)
    });
  });

  app.get('/api/personas', (req: Request, res: Response) => {
    res.json(getAgents(runtime));
  });

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  // Start runtime
  await runtime.start();

  // Create default room
  runtime.actors.send(directorAddress(), {
    type: 'CREATE_ROOM',
    config: {
      id: 'general' as RoomId,
      name: 'general',
      description: 'General discussion',
      topic: ''
    }
  });

  // Start listening
  server.listen(config.port, '0.0.0.0');

  const shutdown = async (): Promise<void> => {
    runtime.logger.info('Shutting down server...');

    // Stop runtime (actors, database, etc.)
    await runtime.stop();

    // Close WebSocket server
    wss.close();

    // Close HTTP server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    runtime.logger.info('Server shutdown complete');
  };

  return { server, runtime, shutdown };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function handleClientMessage(
  runtime: RuntimeContext,
  clientId: string,
  message: unknown
): void {
  if (typeof message !== 'object' || message === null) return;

  const msg = message as Record<string, unknown>;

  if (msg.type === 'ping') {
    // Handled by WebSocket handler
    return;
  }

  if (msg.type === 'join_room' && typeof msg.roomId === 'string') {
    moveClientToRoom(runtime.broadcast, clientId, msg.roomId as RoomId);
  }
}

function getStatus(runtime: RuntimeContext): Record<string, unknown> {
  const director = runtime.actors.getActor(directorAddress());
  const state = director?.state as { running?: boolean; mode?: string; maxTurns?: number; currentTurn?: number } | undefined;

  return {
    running: state?.running ?? false,
    mode: state?.mode ?? 'hybrid',
    max_turns: state?.maxTurns ?? 20,
    current_round: state?.currentTurn ?? 0,
    actor_count: runtime.actors.getActorCount()
  };
}

function getAgents(runtime: RuntimeContext): unknown[] {
  const actors = Object.values(runtime.actors.state.actors);
  return actors
    .filter(a => a.address.startsWith('agent:'))
    .map(a => {
      const state = a.state as {
        config?: { name?: string; description?: string };
        status?: string;
      } | undefined;
      return {
        id: a.address.replace('agent:', ''),
        name: state?.config?.name ?? 'Unknown',
        description: state?.config?.description ?? '',
        status: a.isProcessing ? 'thinking' : (state?.status ?? 'idle')
      };
    });
}

function getMessages(runtime: RuntimeContext, limit: number): unknown[] {
  // Query database directly for messages
  const stmt = runtime.database.db.prepare(`
    SELECT id, room_id, sender_id, sender_name, content, type, timestamp, mentions, attachments
    FROM messages
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const rows = stmt.all(limit) as Array<{
    id: string;
    room_id: string;
    sender_id: string;
    sender_name: string;
    content: string;
    type: string;
    timestamp: number;
    mentions: string;
    attachments: string;
  }>;

  return rows.reverse().map(row => ({
    id: row.id,
    room_id: row.room_id,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    content: row.content,
    type: row.type,
    timestamp: row.timestamp,
    mentions: JSON.parse(row.mentions || '[]'),
    attachments: JSON.parse(row.attachments || '[]')
  }));
}

function getRooms(runtime: RuntimeContext): { rooms: unknown[]; current: string } {
  const actors = Object.values(runtime.actors.state.actors);

  // Get message counts per room from database
  const countStmt = runtime.database.db.prepare(`
    SELECT room_id, COUNT(*) as count FROM messages GROUP BY room_id
  `);
  const counts = countStmt.all() as Array<{ room_id: string; count: number }>;
  const countMap = new Map(counts.map(c => [c.room_id, c.count]));

  const rooms = actors
    .filter(a => a.address.startsWith('room:'))
    .map(a => {
      const roomId = a.address.replace('room:', '');
      const state = a.state as { config?: { name?: string; description?: string } } | undefined;
      return {
        id: roomId,
        name: state?.config?.name ?? 'unknown',
        description: state?.config?.description ?? '',
        message_count: countMap.get(roomId) ?? 0
      };
    });

  return {
    rooms,
    current: 'general'
  };
}
