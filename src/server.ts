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
import { agentsLoaded } from './interpreters/director.js';
import { AgentConfig, createAgentConfig } from './values/agent.js';
import {
  createChatMessage,
  ChatMessage
} from './values/message.js';
import { RoomId, AgentId, generateRoomId, generateAgentId } from './values/ids.js';
import {
  getAllAgents as getDbAgents,
  getAgent as getDbAgent,
  upsertAgent,
  deleteAgent as deleteDbAgent,
  AgentRow,
  getRoom,
  createRoom,
  updateRoomTopic
} from './core/database.js';

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
      // Auto-join clients to the 'general' room so they receive broadcasts
      moveClientToRoom(runtime.broadcast, clientId, 'general' as RoomId);
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
      agents: getAgents(runtime),
      current_room: 'general'
    });
  });

  app.get('/messages', (req: Request, res: Response) => {
    const roomId = (req.query.room as string) || 'general';
    const messages = getMessagesByRoom(runtime, roomId, 50);
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
    const roomId = (req.query.room as string) || 'general';
    // Get or create the room
    let room = getRoom(roomId);
    if (!room) {
      room = createRoom(roomId, roomId, `${roomId} discussion room`, '');
    }
    res.render('partials/topic.html', {
      topic: room?.topic || '',
      channel_name: roomId
    });
  });

  app.get('/project-panel', (req: Request, res: Response) => {
    // Get first active project for current room
    const projectStmt = runtime.database.db.prepare(`
      SELECT id, name, goal, room_id, phase FROM projects
      WHERE phase != 'done' ORDER BY updated_at DESC LIMIT 1
    `);
    const projectRow = projectStmt.get() as { id: string; name: string; goal: string; room_id: string; phase: string } | undefined;

    let project = null;
    if (projectRow) {
      const taskStmt = runtime.database.db.prepare(`
        SELECT id, title, status, assignee_name as assigneeName FROM tasks WHERE project_id = ?
      `);
      const tasks = taskStmt.all(projectRow.id);
      project = { ...projectRow, tasks };
    }

    res.render('partials/project.html', {
      project,
      agents: getAgents(runtime)
    });
  });

  // ============================================================================
  // ACTION ROUTES
  // ============================================================================

  app.post('/send', upload.array('files', 5), async (req: Request, res: Response) => {
    const { sender = 'Human', room = 'general' } = req.body;
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
      roomId: room as RoomId,
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

    const status = { running: true, mode, max_turns: maxTurns, current_round: 0 };
    // Render controls and status panel with OOB swap
    const controlsHtml = await new Promise<string>((resolve, reject) => {
      req.app.render('partials/controls.html', { status }, (err, html) => {
        if (err) reject(err);
        else resolve(html);
      });
    });
    const statusHtml = await new Promise<string>((resolve, reject) => {
      req.app.render('partials/status.html', { status }, (err, html) => {
        if (err) reject(err);
        else resolve(html);
      });
    });
    res.send(`${controlsHtml}<div id="status-panel" hx-swap-oob="innerHTML">${statusHtml}</div>`);
  });

  app.post('/stop', async (req: Request, res: Response) => {
    // Send stop command to director
    runtime.actors.send(directorAddress(), {
      type: 'STOP'
    });

    const status = { running: false, mode: 'hybrid', max_turns: 20, current_round: 0 };
    // Render controls and status panel with OOB swap
    const controlsHtml = await new Promise<string>((resolve, reject) => {
      req.app.render('partials/controls.html', { status }, (err, html) => {
        if (err) reject(err);
        else resolve(html);
      });
    });
    const statusHtml = await new Promise<string>((resolve, reject) => {
      req.app.render('partials/status.html', { status }, (err, html) => {
        if (err) reject(err);
        else resolve(html);
      });
    });
    res.send(`${controlsHtml}<div id="status-panel" hx-swap-oob="innerHTML">${statusHtml}</div>`);
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
    const agentId = req.params.agentId as AgentId;

    // Send stop command to director
    runtime.actors.send(directorAddress(), {
      type: 'STOP_AGENT',
      agentId
    });

    // Also delete from database
    deleteDbAgent(agentId);

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
    const roomId = roomName as RoomId;

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
    let room = getRoom('general');
    if (!room) {
      room = createRoom('general', 'general', 'General discussion room', '');
    }
    res.json({ topic: room?.topic || '', name: 'general' });
  });

  app.post('/api/topic', (req: Request, res: Response) => {
    const { topic = '' } = req.body;
    // Ensure room exists
    let room = getRoom('general');
    if (!room) {
      room = createRoom('general', 'general', 'General discussion room', topic);
    } else {
      updateRoomTopic('general', topic);
    }
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
      const projectStmt = runtime.database.db.prepare(`
        SELECT id, name, goal, room_id, phase, state, created_at, updated_at
        FROM projects
        ORDER BY updated_at DESC
      `);
      const taskStmt = runtime.database.db.prepare(`
        SELECT id, title, description, status, assignee_id, assignee_name
        FROM tasks WHERE project_id = ?
        ORDER BY created_at ASC
      `);

      const rows = projectStmt.all() as Array<{
        id: string;
        name: string;
        goal: string;
        room_id: string;
        phase: string;
        state: string;
        created_at: number;
        updated_at: number;
      }>;

      res.json(rows.map(row => {
        const tasks = taskStmt.all(row.id) as Array<{
          id: string;
          title: string;
          description: string;
          status: string;
          assignee_id: string | null;
          assignee_name: string | null;
        }>;

        return {
          id: row.id,
          name: row.name,
          goal: row.goal,
          room_id: row.room_id,
          phase: row.phase,
          state: JSON.parse(row.state || '{}'),
          tasks: tasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            status: t.status,
            assigneeId: t.assignee_id,
            assigneeName: t.assignee_name
          })),
          created_at: row.created_at,
          updated_at: row.updated_at
        };
      }));
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

  // Add task to project
  app.post('/api/projects/:projectId/tasks', (req: Request, res: Response) => {
    const { projectId } = req.params;
    const { title, description = '' } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title required' });
      return;
    }

    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stmt = runtime.database.db.prepare(`
      INSERT INTO tasks (id, project_id, title, description, task_data)
      VALUES (?, ?, ?, ?, '{}')
    `);
    stmt.run(taskId, projectId, title, description);

    res.json({ id: taskId, project_id: projectId, title, description, status: 'unassigned' });
  });

  // Assign task to agent
  app.post('/api/projects/:projectId/tasks/:taskId/assign', (req: Request, res: Response) => {
    const { taskId } = req.params;
    const { agentId, agentName } = req.body;

    if (!agentId) {
      res.status(400).json({ error: 'Agent ID required' });
      return;
    }

    const stmt = runtime.database.db.prepare(`
      UPDATE tasks SET assignee_id = ?, assignee_name = ?, status = 'assigned',
        updated_at = strftime('%s', 'now') * 1000
      WHERE id = ?
    `);
    const result = stmt.run(agentId, agentName || agentId, taskId);

    if (result.changes > 0) {
      res.json({ status: 'assigned', taskId, agentId });
    } else {
      res.status(404).json({ error: 'Task not found' });
    }
  });

  // Advance project phase
  app.post('/api/projects/:projectId/advance', (req: Request, res: Response) => {
    const { projectId } = req.params;

    const phases = ['planning', 'building', 'reviewing', 'done'];
    const project = runtime.database.db.prepare('SELECT phase FROM projects WHERE id = ?').get(projectId) as { phase: string } | undefined;

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const currentIndex = phases.indexOf(project.phase);
    const nextPhase = phases[Math.min(currentIndex + 1, phases.length - 1)];

    runtime.database.db.prepare(`
      UPDATE projects SET phase = ?, updated_at = strftime('%s', 'now') * 1000 WHERE id = ?
    `).run(nextPhase, projectId);

    res.json({ projectId, phase: nextPhase });
  });

  // ============================================================================
  // PERSONA MANAGEMENT API
  // ============================================================================

  // Helper to format DB agent row for template
  function formatPersona(row: AgentRow) {
    // Parse config blob as fallback for older records
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config || '{}');
    } catch {
      config = {};
    }

    return {
      _filename: row.id,  // Template uses _filename as identifier
      id: row.id,
      name: row.name || config.name as string || 'Unknown',
      description: row.description || config.description as string || '',
      system_prompt: row.system_prompt || config.system_prompt as string || '',
      personality_traits: JSON.parse(row.personality_traits || '{}') || config.personality_traits || {},
      speaking_style: row.speaking_style || config.speaking_style as string || '',
      interests: JSON.parse(row.interests || '[]') || config.interests || [],
      response_tendency: row.response_tendency ?? config.response_tendency as number ?? 0.5,
      temperature: row.temperature ?? config.temperature as number ?? 0.7,
      model: row.model || config.model as string || 'haiku',
      status: row.status || 'offline',
      message_count: row.message_count || 0,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  // Personas page
  app.get('/personas', (req: Request, res: Response) => {
    const personas = getDbAgents().map(formatPersona);
    res.render('personas.html', {
      personas,
      active_agents: getAgents(runtime)
    });
  });

  // List all personas
  app.get('/api/personas', (req: Request, res: Response) => {
    const personas = getDbAgents().map(formatPersona);
    res.json(personas);
  });

  // Get single persona
  app.get('/api/personas/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const agent = getDbAgent(id);
    if (agent) {
      res.json(formatPersona(agent));
    } else {
      res.status(404).json({ error: 'Persona not found' });
    }
  });

  // Create new persona
  app.post('/api/personas', (req: Request, res: Response) => {
    const data = req.body;
    const id = generateAgentId();

    const agent = upsertAgent({
      id,
      name: data.name,
      description: data.description || '',
      system_prompt: data.system_prompt || '',
      personality_traits: data.personality_traits || {},
      speaking_style: data.speaking_style || '',
      interests: data.interests || [],
      response_tendency: data.response_tendency ?? 0.5,
      temperature: data.temperature ?? 0.7,
      model: data.model || 'haiku'
    });

    res.json({ ...formatPersona(agent), status: 'created' });
  });

  // Update existing persona
  app.put('/api/personas/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const data = req.body;

    const existing = getDbAgent(id);
    if (!existing) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }

    const agent = upsertAgent({
      id,
      name: data.name || existing.name,
      description: data.description ?? existing.description,
      system_prompt: data.system_prompt ?? existing.system_prompt,
      personality_traits: data.personality_traits ?? JSON.parse(existing.personality_traits || '{}'),
      speaking_style: data.speaking_style ?? existing.speaking_style,
      interests: data.interests ?? JSON.parse(existing.interests || '[]'),
      response_tendency: data.response_tendency ?? existing.response_tendency,
      temperature: data.temperature ?? existing.temperature,
      model: data.model ?? existing.model
    });

    res.json({ ...formatPersona(agent), status: 'updated' });
  });

  // Delete single persona
  app.delete('/api/personas/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const existing = getDbAgent(id);

    if (!existing) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }

    deleteDbAgent(id);
    res.json({ status: 'deleted', id });
  });

  // Bulk delete personas
  app.post('/api/personas/bulk-delete', (req: Request, res: Response) => {
    const { filenames } = req.body as { filenames: string[] };
    const deleted: string[] = [];

    for (const id of filenames) {
      const existing = getDbAgent(id);
      if (existing) {
        deleteDbAgent(id);
        deleted.push(id);
      }
    }

    res.json({ status: 'deleted', deleted });
  });

  // Tool schemas for persona generation
  const personaTool = {
    name: 'create_persona',
    description: 'Create a persona with the given attributes',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'A creative name for the persona' },
        description: { type: 'string', description: 'Brief description (1-2 sentences)' },
        speaking_style: { type: 'string', description: 'How they communicate' },
        personality_traits: {
          type: 'object',
          properties: {
            curiosity: { type: 'number', minimum: 0, maximum: 1 },
            assertiveness: { type: 'number', minimum: 0, maximum: 1 },
            humor: { type: 'number', minimum: 0, maximum: 1 },
            empathy: { type: 'number', minimum: 0, maximum: 1 },
            skepticism: { type: 'number', minimum: 0, maximum: 1 },
            creativity: { type: 'number', minimum: 0, maximum: 1 }
          },
          required: ['curiosity', 'assertiveness', 'humor', 'empathy', 'skepticism', 'creativity']
        },
        interests: { type: 'array', items: { type: 'string' }, description: '3-5 interests/topics' },
        response_tendency: { type: 'number', minimum: 0, maximum: 1, description: '0=quiet, 1=talkative' },
        temperature: { type: 'number', minimum: 0, maximum: 1, description: 'Creativity level' },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] }
      },
      required: ['name', 'description', 'speaking_style', 'personality_traits', 'interests', 'response_tendency', 'temperature', 'model']
    }
  };

  // Generate persona using AI with tool calling
  app.post('/api/personas/generate', async (req: Request, res: Response) => {
    const { prompt } = req.body as { prompt: string };

    if (!prompt) {
      res.status(400).json({ detail: 'Prompt is required' });
      return;
    }

    try {
      const response = await runtime.anthropic.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: `Create a persona based on: ${prompt}` }
        ],
        tools: [personaTool],
        tool_choice: { type: 'tool', name: 'create_persona' }
      });

      const toolUse = response.content.find(c => c.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error('No tool response');
      }

      res.json(toolUse.input);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Generation failed';
      res.status(500).json({ detail: msg });
    }
  });

  // Tool schema for team generation
  const teamTool = {
    name: 'create_team',
    description: 'Create a team of personas',
    input_schema: {
      type: 'object' as const,
      properties: {
        personas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              speaking_style: { type: 'string' },
              personality_traits: {
                type: 'object',
                properties: {
                  curiosity: { type: 'number' },
                  assertiveness: { type: 'number' },
                  humor: { type: 'number' },
                  empathy: { type: 'number' },
                  skepticism: { type: 'number' },
                  creativity: { type: 'number' }
                }
              },
              interests: { type: 'array', items: { type: 'string' } },
              response_tendency: { type: 'number' },
              temperature: { type: 'number' },
              model: { type: 'string' }
            },
            required: ['name', 'description', 'speaking_style', 'personality_traits', 'interests']
          }
        }
      },
      required: ['personas']
    }
  };

  // Generate team of personas using tool calling
  app.post('/api/personas/generate-team', async (req: Request, res: Response) => {
    const { description, count = 5 } = req.body as { description: string; count?: number };

    if (!description) {
      res.status(400).json({ detail: 'Description is required' });
      return;
    }

    const teamCount = Math.min(Math.max(count, 2), 15);

    try {
      const response = await runtime.anthropic.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [
          { role: 'user', content: `Create ${teamCount} unique personas for a team: ${description}. Make each persona distinct with different personalities and roles.` }
        ],
        tools: [teamTool],
        tool_choice: { type: 'tool', name: 'create_team' }
      });

      const toolUse = response.content.find(c => c.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error('No tool response');
      }

      const { personas } = toolUse.input as { personas: Array<Record<string, unknown>> };

      // Save all personas to database
      const saved = [];
      for (const p of personas) {
        const id = generateAgentId();
        const agent = upsertAgent({
          id,
          name: String(p.name || 'Unknown'),
          description: String(p.description || ''),
          system_prompt: '',
          personality_traits: (p.personality_traits as Record<string, number>) || {},
          speaking_style: String(p.speaking_style || ''),
          interests: (p.interests as string[]) || [],
          response_tendency: Number(p.response_tendency) || 0.5,
          temperature: Number(p.temperature) || 0.7,
          model: String(p.model || 'haiku')
        });
        saved.push(formatPersona(agent));
      }

      res.json({ count: saved.length, personas: saved });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Team generation failed';
      res.status(500).json({ detail: msg });
    }
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

  // Load and spawn agents from database
  const dbAgents = getDbAgents();
  if (dbAgents.length > 0) {
    const agentConfigs: AgentConfig[] = dbAgents.map(row => {
      const config = JSON.parse(row.config_json || '{}');
      return createAgentConfig({
        id: row.id as AgentId,
        name: row.name,
        description: config.description || '',
        systemPrompt: config.systemPrompt || config.system_prompt || '',
        model: config.model || 'haiku',
        temperature: config.temperature || 0.7,
        tools: config.tools || [],
        personalityTraits: config.personalityTraits || config.personality_traits || {},
        speakingStyle: config.speakingStyle || config.speaking_style || '',
        interests: config.interests || [],
        responseTendency: config.responseTendency || config.response_tendency || 0.5,
        background: config.background || null,
        expertise: config.expertise || [],
        warStories: config.warStories || config.war_stories || [],
        strongOpinions: config.strongOpinions || config.strong_opinions || [],
        currentObsession: config.currentObsession || config.current_obsession || null,
        blindSpots: config.blindSpots || config.blind_spots || [],
        communicationQuirks: config.communicationQuirks || config.communication_quirks || [],
        needsBeforeContributing: config.needsBeforeContributing || config.needs_before_contributing || [],
        asksForInfoFrom: config.asksForInfoFrom || config.asks_for_info_from || {}
      });
    });
    runtime.actors.send(directorAddress(), agentsLoaded(agentConfigs));
    runtime.logger.info(`Loaded ${agentConfigs.length} agents from database`);
  }

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
  // Get agents from database
  const dbAgents = getDbAgents();

  // Get running actors to overlay status
  const actors = Object.values(runtime.actors.state.actors);
  const actorMap = new Map<string, { isProcessing: boolean; status?: string }>();

  for (const a of actors) {
    if (a.address.startsWith('agent:')) {
      const agentId = a.address.replace('agent:', '');
      const state = a.state as { status?: string } | undefined;
      actorMap.set(agentId, {
        isProcessing: a.isProcessing,
        status: state?.status
      });
    }
  }

  return dbAgents.map(agent => {
    const actorState = actorMap.get(agent.id);
    let status = agent.status || 'offline';

    if (actorState) {
      status = actorState.isProcessing ? 'thinking' : (actorState.status || 'idle');
    }

    return {
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      status
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

function getMessagesByRoom(runtime: RuntimeContext, roomId: string, limit: number): unknown[] {
  // Query database for messages in specific room
  const stmt = runtime.database.db.prepare(`
    SELECT id, room_id, sender_id, sender_name, content, type, timestamp, mentions, attachments
    FROM messages
    WHERE room_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const rows = stmt.all(roomId, limit) as Array<{
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
