/**
 * Express application with HTMX support.
 * Replaces FastAPI with Express, Jinja2 with Nunjucks, WebSocket with ws.
 */

import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import nunjucks from 'nunjucks';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

import { ArenaWorld } from '../arena/world.js';
import { Agent } from '../agents/agent.js';
import { ScheduleMode, MessageType, Attachment } from '../core/types.js';
import { Message } from '../core/message.js';
import { Event } from '../core/events.js';
import * as db from '../core/database.js';
import * as actorIntegration from '../actors/actor-integration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Template directory
const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');
const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads');

// Ensure uploads directory exists
if (!existsSync(UPLOADS_DIR)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueId = uuidv4();
    const ext = extname(file.originalname);
    cb(null, `${uniqueId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    // Allow images and common file types
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'text/plain', 'text/markdown'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  }
});


/**
 * WebSocket connection manager.
 */
class ConnectionManager {
  connections: Set<WebSocket> = new Set();

  connect(ws: WebSocket): void {
    this.connections.add(ws);
  }

  disconnect(ws: WebSocket): void {
    this.connections.delete(ws);
  }

  broadcast(message: string): void {
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch (err) {
          // Ignore send errors
        }
      }
    }
  }
}

/**
 * Create and configure the Express application.
 */
export function createApp(world?: ArenaWorld) {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const manager = new ConnectionManager();

  // Initialize world
  if (!world) {
    world = new ArenaWorld('Agent Arena');
  }

  // Configure Nunjucks (Jinja2-compatible)
  const nunjucksEnv = nunjucks.configure(TEMPLATES_DIR, {
    autoescape: true,
    express: app,
    watch: false  // Disabled to avoid chokidar dependency
  });

  // Add custom slice filter for string slicing (Jinja2 uses [:8] syntax, Nunjucks needs filter)
  nunjucksEnv.addFilter('slice', function(str: string | undefined, start: number, end?: number) {
    if (typeof str === 'string') {
      return str.slice(start, end);
    }
    return '';
  });

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/uploads', express.static(UPLOADS_DIR));

  // Subscribe to world events for WebSocket broadcast
  world.eventBus.subscribe('message', (event: Event) => {
    const msg = event.data as { message: Record<string, unknown> };
    const html = nunjucks.render('partials/message.html', {
      message: msg.message
    });
    manager.broadcast(html);
  });

  world.eventBus.subscribe('agent_thinking', (event: Event) => {
    const data = event.data as { agent_name: string; thinking: boolean };
    manager.broadcast(JSON.stringify({
      type: 'typing',
      agent_name: data.agent_name,
      thinking: data.thinking
    }));
  });

  // Note: Tool events (tool_use, tool_result) are stored in database.
  // The UI fetches them via the /messages endpoint which merges messages with tool events.

  // === HTML Routes ===

  app.get('/', (req: Request, res: Response) => {
    res.render('index.html', {
      world,
      agents: world!.registry.all(),
      status: world!.getStatus()
    });
  });

  app.get('/messages', (req: Request, res: Response) => {
    const channel = world!.getChannel(world!.defaultChannel);
    const roomId = channel?.id;
    const messages = channel ? channel.getRecentMessages(50).map(m => ({
      type: 'message',
      timestamp: m.timestamp.toISOString(),
      ...m.toDict()
    })) : [];

    // Get tool events for this room
    const toolEvents = db.getEventLog(undefined, undefined, 200)
      .filter(e => {
        if (e.event_type !== 'tool_use' && e.event_type !== 'tool_result') return false;
        const data = JSON.parse(e.event_data);
        return data.room_id === roomId;
      })
      .map(e => {
        const data = JSON.parse(e.event_data);
        return {
          type: e.event_type,
          timestamp: e.created_at,
          agent_name: data.agent_name,
          tool_name: data.tool_name,
          tool_input: data.tool_input,
          is_error: data.is_error,
          result_length: data.result_length
        };
      });

    // Merge and sort by timestamp
    const timeline = [...messages, ...toolEvents]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-100);

    res.render('partials/messages.html', { messages: timeline });
  });

  app.get('/agents-list', (req: Request, res: Response) => {
    res.render('partials/agents.html', {
      agents: world!.registry.all()
    });
  });

  app.get('/status-panel', (req: Request, res: Response) => {
    res.render('partials/status.html', {
      status: world!.getStatus()
    });
  });

  app.get('/topic-panel', (req: Request, res: Response) => {
    const channel = world!.getChannel(world!.defaultChannel);
    res.render('partials/topic.html', {
      topic: channel?.topic || '',
      channel_name: channel?.name || 'general'
    });
  });

  app.get('/project-panel', async (req: Request, res: Response) => {
    const projects = actorIntegration.listProjects();
    let project = null;

    if (projects.length > 0) {
      // Get the most recent project's status
      const projectId = projects[projects.length - 1];
      const status = await actorIntegration.getProjectStatus(projectId);
      if (status) {
        project = {
          id: projectId,
          name: projectId.replace('proj-', 'Project '),
          goal: 'Work in progress',
          phase: status.phase,
          tasks: status.tasks,
          turnCount: status.turnCount
        };
      }
    }

    res.render('partials/project.html', {
      project,
      agents: world!.registry.all()
    });
  });

  // === Actions ===

  app.post('/send', upload.array('files', 5), async (req: Request, res: Response) => {
    const { sender = 'Human' } = req.body;
    const messageContent = req.body.content?.trim();
    const files = req.files as Express.Multer.File[] | undefined;

    // Build attachments array from uploaded files
    const attachments: Attachment[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        attachments.push({
          id: file.filename.split('.')[0], // UUID part
          filename: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          url: `/uploads/${file.filename}`
        });
      }
    }

    // Reject empty messages at the boundary
    if (!messageContent && attachments.length === 0) {
      res.status(400).json({ error: 'Message content required' });
      return;
    }

    await world!.injectMessage(messageContent || '[Attachment]', sender, undefined, attachments.length > 0 ? attachments : undefined);
    res.send(''); // HTMX will update via WebSocket
  });

  app.post('/start', async (req: Request, res: Response) => {
    const mode = req.body.mode || 'hybrid';
    const maxTurns = parseInt(req.body.maxTurns) || 20;
    if (!world!.running) {
      world!.mode = mode as ScheduleMode;
      world!.maxTurns = maxTurns;
      world!.currentRound = 0; // Reset round count
      world!.start();
    }
    const status = { running: true, mode: world!.mode, max_turns: world!.maxTurns };
    res.render('partials/controls.html', { status });
  });

  app.post('/stop', async (req: Request, res: Response) => {
    if (world!.running) {
      world!.stop();
    }
    const status = { running: world!.running, mode: world!.mode, max_turns: world!.maxTurns };
    res.render('partials/controls.html', { status });
  });

  // === Topic API ===

  app.get('/api/topic', (req: Request, res: Response) => {
    const channel = world!.getChannel(world!.defaultChannel);
    res.json({
      topic: channel?.topic || '',
      name: channel?.name || ''
    });
  });

  app.post('/api/topic', async (req: Request, res: Response) => {
    const { topic = '' } = req.body;
    const channel = world!.getChannel(world!.defaultChannel);
    if (channel) {
      channel.setTopic(topic);
      // Broadcast topic change as system message
      const msg = new Message(
        'system',
        'System',
        topic ? `Topic changed to: ${topic}` : 'Topic cleared',
        channel.name,
        MessageType.SYSTEM
      );
      await world!.broadcast(msg);
    }
    res.json({ status: 'updated', topic });
  });

  // === Message Management ===

  app.delete('/api/messages', (req: Request, res: Response) => {
    const channel = world!.getChannel(world!.defaultChannel);
    if (channel) {
      const messageCount = channel.clearMessages();
      // Both events and artifacts use the room UUID
      const eventCount = db.clearEventsByRoom(channel.id);
      const artifactCount = db.clearArtifactsByRoom(channel.id);
      res.json({
        status: 'cleared',
        messages: messageCount,
        events: eventCount,
        artifacts: artifactCount
      });
    } else {
      res.status(404).json({ status: 'error', message: 'Channel not found' });
    }
  });

  // === Dynamic Rooms ===

  app.get('/r/:roomName', async (req: Request, res: Response) => {
    let roomName = req.params.roomName.toLowerCase().replace(/ /g, '-');
    const queryParams = { ...req.query };
    const forceRegenerate = String(queryParams.force || '').toLowerCase() === 'true';
    delete queryParams.force;

    let channel = world!.getChannel(roomName);
    const isNewRoom = !channel;

    if (isNewRoom) {
      channel = world!.createChannel(roomName, '');
    }

    // Generate description if new room or force=true
    if (isNewRoom || forceRegenerate) {
      try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (apiKey) {
          let paramsStr = '';
          const paramsList = Object.entries(queryParams).map(([k, v]) => `${k}=${v}`);
          if (paramsList.length > 0) {
            paramsStr = `\n\nCustomization parameters: ${paramsList.join(', ')}`;
          }

          const client = new Anthropic({ apiKey });
          const response = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 256,
            messages: [{
              role: 'user',
              content: `Generate a brief, engaging description (2-3 sentences) for a chat room called '${roomName}'. What would people discuss here? Be creative and specific. Just return the description, no quotes or labels.${paramsStr}`
            }]
          });

          const description = (response.content[0] as { type: 'text'; text: string }).text.trim();
          channel!.description = description;
          channel!.setTopic(description);
        }
      } catch (err) {
        console.error('Failed to generate room description:', err);
        if (isNewRoom) {
          channel!.setTopic(`Welcome to #${roomName}`);
        }
      }
    }

    if (isNewRoom) {
      // Add all agents to this room
      for (const agent of world!.registry.all()) {
        channel!.addMember(agent.id);
      }
    }

    // Switch to this room
    world!.defaultChannel = roomName;

    res.render('index.html', {
      world,
      agents: world!.registry.all(),
      status: world!.getStatus(),
      current_room: roomName
    });
  });

  app.get('/api/rooms', (req: Request, res: Response) => {
    const rooms = Array.from(world!.channels.values()).map(ch => ch.toDict());
    res.json({
      rooms,
      current: world!.defaultChannel
    });
  });

  app.post('/api/rooms/:roomName/switch', (req: Request, res: Response) => {
    const { roomName } = req.params;
    const channel = world!.getChannel(roomName);
    if (!channel) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    world!.defaultChannel = roomName;
    res.json({ status: 'switched', room: roomName });
  });

  // === Agent Management ===

  app.post('/agents/add', async (req: Request, res: Response) => {
    try {
      // Accept both form data (config_path) and JSON (name)
      const configPath = req.body.config_path;
      const config = configPath ? { name: configPath } : req.body;

      if (!config.name) {
        res.status(400).json({ error: 'Agent name is required' });
        return;
      }

      // Check if agent already exists in registry
      const existingAgent = world?.registry.getByName(config.name);
      if (existingAgent) {
        res.status(400).json({ error: `Agent "${config.name}" is already active` });
        return;
      }

      // Try to load from database if only name provided
      if (configPath) {
        const dbAgent = db.getAgentByName(config.name);
        if (dbAgent) {
          const agent = Agent.fromConfig(dbAgent);
          await world!.addAgent(agent);
          res.render('partials/agents.html', {
            agents: world!.registry.all()
          });
          return;
        }
        res.status(404).json({ error: `Persona "${config.name}" not found. Create it in the Personas page first.` });
        return;
      }

      // Generate ID if not provided (for JSON config)
      if (!config.id) {
        config.id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }

      const agent = Agent.fromConfig(config);
      await world!.addAgent(agent);

      res.render('partials/agents.html', {
        agents: world!.registry.all()
      });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.delete('/agents/:agentId', async (req: Request, res: Response) => {
    await world!.removeAgent(req.params.agentId);
    res.json({ status: 'removed' });
  });

  app.post('/agents/:agentId/step', async (req: Request, res: Response) => {
    const agent = world!.registry.get(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const channel = world!.getChannel(world!.defaultChannel);
    if (!channel) {
      res.status(500).json({ error: 'No default channel' });
      return;
    }

    let context = channel.getContextString(20);
    if (!context) {
      context = '(The conversation is just starting. Say hello!)';
    }

    // Emit thinking event
    world!.eventBus.emitEvent('agent_thinking', {
      agent_id: agent.id,
      agent_name: agent.name,
      thinking: true
    });

    // Have agent step (pass roomId for tool context)
    const responseText = await agent.step(context, channel.id);

    // Emit thinking done event
    world!.eventBus.emitEvent('agent_thinking', {
      agent_id: agent.id,
      agent_name: agent.name,
      thinking: false
    });

    if (responseText) {
      const message = new Message(
        agent.id,
        agent.name,
        responseText,
        channel.name
      );
      await world!.broadcast(message);
      res.json({
        status: 'ok',
        agent: agent.name,
        message: responseText.slice(0, 100) + (responseText.length > 100 ? '...' : '')
      });
    } else {
      res.json({
        status: 'error',
        agent: agent.name,
        message: 'Agent failed to respond'
      });
    }
  });

  // === API Routes ===

  app.get('/api/status', (req: Request, res: Response) => {
    res.json(world!.getStatus());
  });

  app.get('/api/agents', (req: Request, res: Response) => {
    res.json(world!.registry.all().map(a => a.toDict()));
  });

  app.get('/api/messages', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const channel = world!.getChannel(world!.defaultChannel);
    if (channel) {
      res.json(channel.getRecentMessages(limit).map(m => m.toDict()));
    } else {
      res.json([]);
    }
  });

  // Combined timeline with messages AND tool events
  app.get('/api/timeline', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const roomName = req.query.room as string || world!.defaultChannel;
    const channel = world!.getChannel(roomName);

    if (!channel) {
      res.json([]);
      return;
    }

    // Get messages
    const messages = channel.getRecentMessages(limit).map(m => ({
      type: 'message',
      timestamp: m.timestamp.toISOString(),
      data: m.toDict()
    }));

    // Get tool events from event_log
    const toolEvents = db.getEventLog(undefined, undefined, limit * 2)
      .filter(e => e.event_type === 'tool_use' || e.event_type === 'tool_result')
      .map(e => {
        const data = JSON.parse(e.event_data);
        return {
          type: e.event_type,
          timestamp: e.created_at,
          data: {
            agent_name: data.agent_name,
            tool_name: data.tool_name,
            input: data.tool_input,
            result: data.result_length ? `(${data.result_length} chars)` : undefined,
            is_error: data.is_error
          }
        };
      });

    // Merge and sort by timestamp
    const timeline = [...messages, ...toolEvents]
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-limit);

    res.json(timeline);
  });

  app.delete('/api/messages/:messageId', (req: Request, res: Response) => {
    const { messageId } = req.params;
    const deleted = db.deleteMessage(messageId);

    // Also remove from in-memory channel
    const channel = world!.getChannel(world!.defaultChannel);
    if (channel) {
      channel.removeMessage(messageId);
    }

    if (deleted) {
      res.json({ status: 'ok', deleted: messageId });
    } else {
      res.status(404).json({ error: 'Message not found' });
    }
  });

  // === Database History API ===

  app.get('/api/sessions', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 20;
    res.json(db.getRecentSessions(limit));
  });

  app.get('/api/sessions/:sessionId', (req: Request, res: Response) => {
    const session = db.getSession(req.params.sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  });

  app.get('/api/events', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 100;
    const sessionId = req.query.session as string | undefined;
    const eventType = req.query.type as string | undefined;
    res.json(db.getEventLog(sessionId, eventType, limit));
  });

  // === Artifacts API ===

  app.get('/api/artifacts', (req: Request, res: Response) => {
    const roomName = req.query.room as string;
    const agentId = req.query.agent as string | undefined;

    if (!roomName) {
      res.status(400).json({ error: 'room parameter required' });
      return;
    }

    // Look up room by name to get ID
    const room = db.getRoom(roomName);
    if (!room) {
      res.json([]); // No room, no artifacts
      return;
    }
    const roomId = room.id;

    if (agentId) {
      res.json(db.listArtifacts(roomId, agentId));
    } else {
      // Get all artifacts for room (all agents + shared)
      const allAgents = db.getAllAgents();
      const artifacts: db.ArtifactRow[] = [];
      for (const agent of allAgents) {
        artifacts.push(...db.listArtifacts(roomId, agent.id));
      }
      // Also get shared artifacts
      artifacts.push(...db.listArtifacts(roomId, '_shared_'));
      res.json(artifacts);
    }
  });

  app.get('/api/artifacts/:roomId/:agentId/*', (req: Request, res: Response) => {
    const { roomId, agentId } = req.params;
    const path = '/' + req.params[0]; // The wildcard part

    const artifact = db.getArtifact(roomId, agentId, path);
    if (!artifact) {
      res.status(404).json({ error: 'Artifact not found' });
      return;
    }
    res.json(artifact);
  });

  app.get('/api/history/messages', (req: Request, res: Response) => {
    const roomId = req.query.room as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    if (!roomId) {
      res.status(400).json({ error: 'room parameter required' });
      return;
    }

    const messages = db.getMessages(roomId, limit, offset);
    res.json(messages.map(m => ({
      ...m,
      mentions: JSON.parse(m.mentions)
    })));
  });

  app.get('/api/history/search', (req: Request, res: Response) => {
    const query = req.query.q as string;
    const roomId = req.query.room as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;

    if (!query) {
      res.status(400).json({ error: 'q parameter required' });
      return;
    }

    const messages = db.searchMessages(query, roomId, limit);
    res.json(messages.map(m => ({
      ...m,
      mentions: JSON.parse(m.mentions)
    })));
  });

  // === Project API (Actor-based) ===

  app.post('/api/projects', async (req: Request, res: Response) => {
    const { name, goal, roomId = 'general' } = req.body;

    if (!name || !goal) {
      res.status(400).json({ error: 'name and goal are required' });
      return;
    }

    try {
      const { projectId } = await actorIntegration.createProject({
        name,
        goal,
        roomId
      });
      res.json({ status: 'created', projectId });
    } catch (err) {
      res.status(500).json({ error: `Failed to create project: ${err}` });
    }
  });

  app.get('/api/projects', (req: Request, res: Response) => {
    const projects = actorIntegration.listProjects();
    res.json({ projects });
  });

  app.get('/api/projects/:projectId', async (req: Request, res: Response) => {
    const { projectId } = req.params;

    const status = await actorIntegration.getProjectStatus(projectId);
    if (!status) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json(status);
  });

  app.post('/api/projects/:projectId/tasks', (req: Request, res: Response) => {
    const { projectId } = req.params;
    const { title, description, priority } = req.body;

    if (!title || !description) {
      res.status(400).json({ error: 'title and description are required' });
      return;
    }

    actorIntegration.addTask(projectId, title, description, priority);
    res.json({ status: 'added' });
  });

  app.post('/api/projects/:projectId/tasks/:taskId/assign', (req: Request, res: Response) => {
    const { projectId, taskId } = req.params;
    const { agentId, agentName } = req.body;

    if (!agentId || !agentName) {
      res.status(400).json({ error: 'agentId and agentName are required' });
      return;
    }

    actorIntegration.assignTask(projectId, taskId, agentId, agentName);
    res.json({ status: 'assigned' });
  });

  app.post('/api/projects/:projectId/advance', (req: Request, res: Response) => {
    const { projectId } = req.params;

    actorIntegration.advancePhase(projectId);
    res.json({ status: 'advancing' });
  });

  // === Actor-based Agent Step ===

  app.post('/api/actors/agents/:agentId/step', async (req: Request, res: Response) => {
    const { agentId } = req.params;
    const { roomId = 'general' } = req.body;

    try {
      const response = await actorIntegration.triggerAgentResponse(agentId, roomId);
      if (response) {
        res.json({ status: 'ok', response: response.slice(0, 200) + (response.length > 200 ? '...' : '') });
      } else {
        res.status(500).json({ error: 'Agent did not respond' });
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to trigger agent: ${err}` });
    }
  });

  // === Lifecycle Management ===

  app.post('/api/shutdown', (req: Request, res: Response) => {
    res.json({ status: 'shutting_down' });

    // Graceful shutdown
    setTimeout(async () => {
      console.log('\nGraceful shutdown requested via API...');
      world!.stop();
      await actorIntegration.shutdownActorSystem();
      db.closeDatabase();
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    }, 100);
  });

  // === Persona Management ===

  app.get('/personas', (req: Request, res: Response) => {
    const agents = world!.registry.all();
    res.render('personas.html', {
      personas: agents.map(a => a.toDict()),
      active_agents: agents.map(a => a.toDict())
    });
  });

  app.get('/api/personas', (req: Request, res: Response) => {
    // Return all agents from registry with full data
    const agents = world?.registry.all() || [];
    res.json(agents.map(a => a.toDict()));
  });

  app.post('/api/personas', async (req: Request, res: Response) => {
    const data = req.body;
    if (!data.name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    // Check if already exists
    if (world?.registry.getByName(data.name)) {
      res.status(400).json({ error: 'Agent with this name already exists' });
      return;
    }

    const config = {
      name: data.name,
      description: data.description || '',
      system_prompt: data.system_prompt || '',
      personality_traits: data.personality_traits || {},
      speaking_style: data.speaking_style || '',
      interests: data.interests || [],
      response_tendency: parseFloat(data.response_tendency) || 0.5,
      temperature: parseFloat(data.temperature) || 0.7,
      model: data.model || 'haiku'
    };

    try {
      const agent = Agent.fromConfig(config);
      await world!.addAgent(agent);
      res.json({ status: 'created', id: agent.id, name: agent.name });
    } catch (err) {
      res.status(500).json({ error: `Failed to create agent: ${err}` });
    }
  });

  app.post('/api/personas/generate', async (req: Request, res: Response) => {
    const { prompt: userPrompt } = req.body;
    if (!userPrompt) {
      res.status(400).json({ error: 'Prompt is required' });
      return;
    }

    const existingAgents = world?.registry.all() || [];
    const existingSummary = existingAgents.map(a =>
      `- ${a.name}: ${a.description.slice(0, 100)}`
    ).join('\n') || 'None yet';

    const systemPrompt = `Create a realistic team member using BELBIN TEAM ROLES with personality depth AND clear expertise dependencies.

Choose ONE of these 9 Belbin behavioral archetypes:

ACTION-ORIENTED:
• SHAPER: Drives forward, challenges the team, thrives on pressure. May be abrasive.
• IMPLEMENTER: Turns ideas into action, reliable, disciplined. May be inflexible.
• COMPLETER-FINISHER: Quality control, catches errors, perfectionist. May slow things down.

PEOPLE-ORIENTED:
• COORDINATOR: Clarifies goals, delegates, big picture. May seem controlling.
• TEAMWORKER: Supports others, harmonizes, diplomatic. May avoid hard decisions.
• RESOURCE INVESTIGATOR: Brings external ideas, networks, enthusiastic. May lose focus.

THINKING-ORIENTED:
• PLANT: Creative problem-solver, novel ideas. May ignore practical constraints.
• MONITOR-EVALUATOR: Analyzes options, strategic, objective. May seem cold or critical.
• SPECIALIST: Deep domain expertise, dedicated. May miss broader context.

═══════════════════════════════════════════════════════════════
EXPERTISE & DEPENDENCIES - CRITICAL
═══════════════════════════════════════════════════════════════

Every persona MUST define:
1. EXPERTISE - What they know deeply and can provide to others
2. NEEDS_BEFORE_CONTRIBUTING - What info they need before they can do their job
3. ASKS_FOR_INFO_FROM - Which ROLES provide each piece of info they need

EXAMPLES:

ARCHITECT (PLANT):
- expertise: ["system design", "API architecture", "scalability patterns", "technical tradeoffs"]
- needs: ["product requirements", "security constraints", "timeline expectations"]
- asks: { "product requirements": "PM", "security constraints": "Security", "timeline": "EM" }

PM/COORDINATOR:
- expertise: ["product requirements", "user needs", "prioritization", "scope definition"]
- needs: ["technical feasibility", "effort estimates", "risk assessment"]
- asks: { "technical feasibility": "Architect", "effort estimates": "Engineers", "risk assessment": "Security" }

SECURITY ENGINEER (MONITOR-EVALUATOR):
- expertise: ["security constraints", "threat modeling", "compliance", "risk assessment"]
- needs: ["architecture overview", "data flow", "external integrations"]
- asks: { "architecture overview": "Architect", "data flow": "Backend", "external integrations": "Architect" }

QA/COMPLETER-FINISHER:
- expertise: ["test planning", "edge cases", "quality standards", "regression risks"]
- needs: ["feature specs", "acceptance criteria", "architecture decisions"]
- asks: { "feature specs": "PM", "acceptance criteria": "PM", "architecture decisions": "Architect" }

BACKEND ENGINEER (IMPLEMENTER):
- expertise: ["implementation details", "effort estimates", "technical constraints", "API contracts"]
- needs: ["requirements", "architecture", "security guidelines"]
- asks: { "requirements": "PM", "architecture": "Architect", "security guidelines": "Security" }

═══════════════════════════════════════════════════════════════

This creates NATURAL conversation flow:
- David (Architect): "@Maya I need the product requirements before I can design. What's the MVP scope?"
- Maya (PM): "MVP is X, Y, Z. @Priya what security constraints should David consider?"
- Priya (Security): "Encrypt at rest, no third-party analytics. @David factor that into your design."

BAD (no dependencies): "Senior engineer who values quality. Good at architecture."

RESPOND WITH JSON:
{
    "name": "FirstName",
    "description": "Belbin role + job title. Behavioral style. Communication pattern. Realistic flaw. 3-5 sentences.",
    "expertise": ["specific thing they know", "another expertise", "what they provide to team"],
    "needs_before_contributing": ["info they need", "before they can help"],
    "asks_for_info_from": {
        "info they need": "Role who provides it",
        "other info": "Other Role"
    },
    "response_tendency": 0.4-0.9,
    "temperature": 0.6-0.85
}`;

    const userMessage = `Create a persona based on this description:
"${userPrompt}"

Existing personas (create something different):
${existingSummary}

Generate the persona JSON:`;

    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
        return;
      }

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      let responseText = (response.content[0] as { type: 'text'; text: string }).text.trim();

      // Extract JSON from potential markdown
      if (responseText.includes('```')) {
        const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
          responseText = match[1];
        }
      }

      const personaData = JSON.parse(responseText);
      personaData.model = personaData.model || 'haiku';
      personaData.system_prompt = personaData.system_prompt || '';

      res.json(personaData);
    } catch (err) {
      console.error('Persona generation error:', err);
      res.status(500).json({ error: `Failed to generate persona: ${err}` });
    }
  });

  app.post('/api/personas/generate-team', async (req: Request, res: Response) => {
    const { description: teamDescription, count: rawCount = 5 } = req.body;
    const count = Math.min(parseInt(rawCount), 15);

    if (!teamDescription) {
      res.status(400).json({ error: 'Team description is required' });
      return;
    }

    const existingNames = new Set(
      (world?.registry.all() || []).map(a => a.name.toLowerCase())
    );

    const systemPrompt = `Generate ${count} team members using BELBIN TEAM ROLES with personality depth AND clear expertise dependencies.

Create BEHAVIORAL DIVERSITY by distributing personas across these psychological archetypes:

═══════════════════════════════════════════════════════════════
ACTION-ORIENTED ROLES (include at least 1-2):
═══════════════════════════════════════════════════════════════

• SHAPER: Drives forward, challenges the team, thrives on pressure
• IMPLEMENTER: Turns ideas into practical action, reliable, disciplined
• COMPLETER-FINISHER: Quality control, catches errors, ensures nothing is missed

═══════════════════════════════════════════════════════════════
PEOPLE-ORIENTED ROLES (include at least 1-2):
═══════════════════════════════════════════════════════════════

• COORDINATOR: Clarifies goals, delegates, maintains big picture
• TEAMWORKER: Supports others, harmonizes conflicts, puts team first
• RESOURCE INVESTIGATOR: Brings external ideas, networks, enthusiastic

═══════════════════════════════════════════════════════════════
THINKING-ORIENTED ROLES (include at least 1-2):
═══════════════════════════════════════════════════════════════

• PLANT: Creative problem-solver, generates novel ideas
• MONITOR-EVALUATOR: Analyzes options objectively, sees pros/cons
• SPECIALIST: Deep expertise in specific domain

═══════════════════════════════════════════════════════════════
EXPERTISE & DEPENDENCIES - CRITICAL FOR EACH PERSONA
═══════════════════════════════════════════════════════════════

Every persona MUST define:
1. EXPERTISE - What they know deeply and can provide to others
2. NEEDS_BEFORE_CONTRIBUTING - What info they need before they can do their job
3. ASKS_FOR_INFO_FROM - Which ROLES (not names) provide each piece of info

EXAMPLE TEAM WITH INTERLOCKING DEPENDENCIES:

Maya (PM/COORDINATOR):
- expertise: ["product requirements", "user needs", "prioritization", "MVP scope"]
- needs: ["technical feasibility", "effort estimates", "security risks"]
- asks: { "technical feasibility": "Architect", "effort estimates": "Engineer", "security risks": "Security" }

David (ARCHITECT/PLANT):
- expertise: ["system design", "API architecture", "scalability", "technical tradeoffs"]
- needs: ["product requirements", "security constraints", "timeline"]
- asks: { "product requirements": "PM", "security constraints": "Security", "timeline": "PM" }

Priya (SECURITY/MONITOR-EVALUATOR):
- expertise: ["security constraints", "threat modeling", "compliance", "risk assessment"]
- needs: ["architecture overview", "data sensitivity", "external integrations"]
- asks: { "architecture overview": "Architect", "data sensitivity": "PM", "external integrations": "Architect" }

James (BACKEND/IMPLEMENTER):
- expertise: ["implementation", "effort estimates", "technical constraints", "API contracts"]
- needs: ["requirements", "architecture decisions", "security guidelines"]
- asks: { "requirements": "PM", "architecture decisions": "Architect", "security guidelines": "Security" }

Sarah (QA/COMPLETER-FINISHER):
- expertise: ["test planning", "edge cases", "quality standards", "user acceptance"]
- needs: ["feature specs", "acceptance criteria", "architecture decisions"]
- asks: { "feature specs": "PM", "acceptance criteria": "PM", "architecture decisions": "Architect" }

═══════════════════════════════════════════════════════════════
THIS CREATES NATURAL CONVERSATION FLOW:
═══════════════════════════════════════════════════════════════

David: "@Maya I need the product requirements before I can design. What's the MVP scope?"
Maya: "MVP: save highlights, sync across devices. @Priya what security constraints?"
Priya: "Encrypt at rest, no third-party analytics. @David factor that into your design."
David: "Got it. Here's the architecture..." [now has what he needs]
James: "@David I need the API contracts before I can estimate effort."

Each persona EXPLICITLY asks the right person for what they need.

═══════════════════════════════════════════════════════════════

EVERY PERSONA MUST HAVE:
1. A Belbin role (how they contribute)
2. Expertise (what they provide to others)
3. Dependencies (what they need and who provides it)
4. Communication style (Driver/Analytical/Expressive/Amiable)
5. A realistic FLAW

RESPOND WITH JSON ARRAY:
[{
    "name": "FirstName",
    "description": "Belbin role + job title. Behavioral style. Communication pattern. Realistic flaw. 3-5 sentences.",
    "expertise": ["what they know", "what they provide to team"],
    "needs_before_contributing": ["info they need first"],
    "asks_for_info_from": {
        "info needed": "Role who provides it"
    },
    "response_tendency": 0.4-0.9,
    "temperature": 0.6-0.85
}]`;

    const existingList = Array.from(existingNames).join(', ') || 'None';
    const userMessage = `Create a team of ${count} personas for: "${teamDescription}"

Existing persona names to avoid: ${existingList}

Generate the JSON array of ${count} personas:`;

    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
        return;
      }

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      });

      let responseText = (response.content[0] as { type: 'text'; text: string }).text.trim();

      if (responseText.includes('```')) {
        const match = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
          responseText = match[1];
        }
      }

      const personas = JSON.parse(responseText);
      if (!Array.isArray(personas)) {
        res.status(500).json({ error: 'Expected array of personas' });
        return;
      }

      const created: Array<{ id: string; name: string }> = [];

      for (const persona of personas) {
        persona.model = persona.model || 'haiku';
        persona.system_prompt = persona.system_prompt || '';

        // Check if agent with this name already exists
        if (world?.registry.getByName(persona.name)) {
          continue;
        }

        try {
          const agent = Agent.fromConfig(persona);
          await world!.addAgent(agent);
          created.push({ id: agent.id, name: agent.name });
        } catch (err) {
          console.warn(`Failed to create agent ${persona.name}: ${err}`);
        }
      }

      res.json({ status: 'created', count: created.length, personas: created });
    } catch (err) {
      console.error('Team generation error:', err);
      res.status(500).json({ error: `Failed to generate team: ${err}` });
    }
  });

  app.post('/api/personas/bulk-delete', (req: Request, res: Response) => {
    const { ids = [], names = [], filenames = [] } = req.body;
    // filenames are treated as IDs (for frontend compatibility)
    const allIds = [...ids, ...filenames];

    if (allIds.length === 0 && names.length === 0) {
      res.status(400).json({ error: 'No ids, names, or filenames provided' });
      return;
    }

    const deleted: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    // Collect agents to delete (by id or name)
    const agentsToDelete: Array<{ id: string; name: string }> = [];

    for (const id of allIds) {
      const agent = world?.registry.get(id);
      if (agent) {
        agentsToDelete.push({ id: agent.id, name: agent.name });
      } else {
        errors.push({ id, error: 'Not found in registry' });
      }
    }

    for (const name of names) {
      const agent = world?.registry.getByName(name);
      if (agent && !agentsToDelete.find(a => a.id === agent.id)) {
        agentsToDelete.push({ id: agent.id, name: agent.name });
      }
    }

    // Delete each agent
    for (const { id, name } of agentsToDelete) {
      try {
        world?.registry.unregister(id);
        db.removeAgentFromAllRooms(id);
        db.deleteAgent(id);
        deleted.push(name);
      } catch (err) {
        errors.push({ id, error: String(err) });
      }
    }

    res.json({ status: 'deleted', deleted, errors });
  });

  // Get single persona by ID or name
  app.get('/api/personas/:idOrName', (req: Request, res: Response) => {
    const param = req.params.idOrName;
    let agent = world?.registry.get(param);
    if (!agent) {
      agent = world?.registry.getByName(param);
    }

    if (!agent) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }

    // Use toDict() for complete agent data including personality_traits
    res.json(agent.toDict());
  });

  // Update persona by ID or name
  app.put('/api/personas/:idOrName', (req: Request, res: Response) => {
    const param = req.params.idOrName;
    let agent = world?.registry.get(param);
    if (!agent) {
      agent = world?.registry.getByName(param);
    }

    if (!agent) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }

    const data = req.body;

    // Update agent properties
    if (data.description !== undefined) agent.description = data.description;
    if (data.system_prompt !== undefined) agent.system_prompt = data.system_prompt;
    if (data.speaking_style !== undefined) agent.speaking_style = data.speaking_style;
    if (data.interests !== undefined) agent.interests = data.interests;
    if (data.response_tendency !== undefined) agent.response_tendency = parseFloat(data.response_tendency);
    if (data.temperature !== undefined) agent.temperature = parseFloat(data.temperature);

    // Persist to database
    db.upsertAgent({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      system_prompt: agent.system_prompt,
      personality_traits: agent.personality_traits,
      speaking_style: agent.speaking_style,
      interests: agent.interests,
      response_tendency: agent.response_tendency,
      temperature: agent.temperature,
      model: agent.model
    });

    res.json({ status: 'updated', id: agent.id, name: agent.name });
  });

  // Delete persona by ID or name
  app.delete('/api/personas/:idOrName', (req: Request, res: Response) => {
    const param = req.params.idOrName;
    let agent = world?.registry.get(param);
    if (!agent) {
      agent = world?.registry.getByName(param);
    }

    if (!agent) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }

    try {
      const agentId = agent.id;
      const agentName = agent.name;

      world?.registry.unregister(agentId);
      db.removeAgentFromAllRooms(agentId);
      db.deleteAgent(agentId);

      res.json({ status: 'deleted', id: agentId, name: agentName });
    } catch (err) {
      res.status(500).json({ error: `Failed to delete: ${err}` });
    }
  });

  // === WebSocket ===

  wss.on('connection', (ws: WebSocket) => {
    manager.connect(ws);

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', () => {
      manager.disconnect(ws);
    });
  });

  // Initialize actor system with WebSocket manager for broadcasting
  actorIntegration.initializeActorSystem(manager).catch(err => {
    console.error('Failed to initialize actor system:', err);
  });

  return { app, server, world, manager };
}
