/**
 * Express application with HTMX support.
 * Replaces FastAPI with Express, Jinja2 with Nunjucks, WebSocket with ws.
 */

import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import nunjucks from 'nunjucks';
import yaml from 'js-yaml';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

import { ArenaWorld } from '../arena/world.js';
import { Agent } from '../agents/agent.js';
import { loadAgentConfig } from '../agents/loader.js';
import { ScheduleMode, MessageType, Attachment } from '../core/types.js';
import { Message } from '../core/message.js';
import { Event } from '../core/events.js';
import * as db from '../core/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Template directory
const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');
const CONFIGS_DIR = join(__dirname, '..', '..', 'configs', 'agents');
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
    const messages = channel ? channel.getRecentMessages(50).map(m => m.toDict()) : [];
    res.render('partials/messages.html', { messages });
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

  // === Actions ===

  app.post('/send', upload.array('files', 5), async (req: Request, res: Response) => {
    const { content, sender = 'Human' } = req.body;
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

    await world!.injectMessage(content || '', sender, undefined, attachments.length > 0 ? attachments : undefined);
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
      const count = channel.clearMessages();
      res.json({ status: 'cleared', count });
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
      let configPath = req.body.config_path;
      if (!existsSync(configPath)) {
        configPath = join(CONFIGS_DIR, `${configPath}.yaml`);
      }

      const config = loadAgentConfig(configPath);
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

    // Have agent step
    const responseText = await agent.step(context);

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

  // === Lifecycle Management ===

  app.post('/api/shutdown', (req: Request, res: Response) => {
    res.json({ status: 'shutting_down' });

    // Graceful shutdown
    setTimeout(() => {
      console.log('\nGraceful shutdown requested via API...');
      world!.stop();
      db.closeDatabase();
      server.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    }, 100);
  });

  // === Persona Management ===

  app.get('/personas', (req: Request, res: Response) => {
    const personas = loadPersonaConfigs();
    res.render('personas.html', {
      personas,
      active_agents: world!.registry.all().map(a => a.toDict())
    });
  });

  app.get('/api/personas', (req: Request, res: Response) => {
    res.json(loadPersonaConfigs());
  });

  app.post('/api/personas', async (req: Request, res: Response) => {
    const data = req.body;
    if (!data.name) {
      res.status(400).json({ error: 'Name is required' });
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

    // Save to YAML file
    if (!existsSync(CONFIGS_DIR)) {
      mkdirSync(CONFIGS_DIR, { recursive: true });
    }

    const filename = data.name.toLowerCase().replace(/ /g, '_');
    const filepath = join(CONFIGS_DIR, `${filename}.yaml`);
    writeFileSync(filepath, yaml.dump(config));

    // Add to running world
    try {
      const agent = Agent.fromConfig(config);
      await world!.addAgent(agent);
    } catch (err) {
      console.warn(`Persona saved but failed to add to world: ${err}`);
    }

    res.json({ status: 'created', filename, path: filepath });
  });

  app.post('/api/personas/generate', async (req: Request, res: Response) => {
    const { prompt: userPrompt } = req.body;
    if (!userPrompt) {
      res.status(400).json({ error: 'Prompt is required' });
      return;
    }

    const existingPersonas = loadPersonaConfigs();
    const existingSummary = existingPersonas.map(p =>
      `- ${p.name}: ${String(p.description || '').slice(0, 100)}`
    ).join('\n') || 'None yet';

    const systemPrompt = `Create a realistic team member with a clear purpose that drives what they call out.

EXAMPLES OF GOOD DESCRIPTIONS (notice: purpose drives behavior):

"Frontend lead. Owns the React codebase. Purpose: ship fast - so she calls out missing specs, blockers, and scope creep. Impatient, wants requirements NOW. Will flag 'I can't start until I have X.'"

"Senior architect. Purpose: prevent rewrites - so he calls out architectural shortcuts, scaling issues, and tech debt. Asks 'what happens at 10x users?' Tends to slow things down with war stories."

"DevOps. Purpose: keep prod stable - so he calls out deployment risks, missing monitoring, and things that'll page him at 3am. Skeptical. 'Who's maintaining this?' Dark humor."

"QA lead. Purpose: prevent prod bugs - so she calls out untested paths, missing error handling, edge cases. Will block releases. 'What happens if the user does X?'"

BAD DESCRIPTION (no purpose, no behavior):
"Experienced engineer who values quality. Interested in scalable systems."

Create someone with:
- Role and what they own
- PURPOSE - what drives them and what they call out because of it
- Personality and work style
- Strengths AND flaws

RESPOND WITH JSON:
{
    "name": "FirstName",
    "description": "Role, purpose (so they call out X), personality, flaws. 3-5 sentences.",
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
      loadPersonaConfigs().map(p => String(p.name || '').toLowerCase())
    );

    const systemPrompt = `Generate ${count} team members with different PURPOSES that create natural tension.

Each person has a purpose that drives what they call out. Their purposes sometimes conflict:
- PM wants to ship fast → calls out scope creep
- QA wants quality → calls out untested paths
- Architect wants sustainability → calls out shortcuts
- DevOps wants stability → calls out deployment risks

EXAMPLE:
{
  "name": "Maya",
  "description": "Backend lead. Purpose: deliver reliable APIs - so she calls out vague specs, changing requirements, and frontend making assumptions. Quiet, just builds. Sometimes ships before fully understanding the ask."
}

BAD EXAMPLE (no purpose, no behavior):
{
  "name": "Alex",
  "description": "Experienced engineer who values quality. Has opinions about testing. Interested in scalability."
}

EACH PERSONA NEEDS:
1. Role and what they own
2. PURPOSE - and what they call out because of it
3. Personality (some ship fast, some slow down, some vent, some stay quiet)
4. Flaws

RESPOND WITH JSON ARRAY:
[{
    "name": "FirstName",
    "description": "Role, purpose (so they call out X), personality, flaws. 3-5 sentences.",
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

      if (!existsSync(CONFIGS_DIR)) {
        mkdirSync(CONFIGS_DIR, { recursive: true });
      }

      const saved: Array<{ name: string; filename: string }> = [];

      for (const persona of personas) {
        persona.model = persona.model || 'haiku';
        persona.system_prompt = persona.system_prompt || '';

        const filename = persona.name.toLowerCase().replace(/ /g, '_');
        const filepath = join(CONFIGS_DIR, `${filename}.yaml`);

        if (existsSync(filepath)) {
          continue;
        }

        writeFileSync(filepath, yaml.dump(persona));

        try {
          const agent = Agent.fromConfig(persona);
          await world!.addAgent(agent);
        } catch (err) {
          console.warn(`Persona ${persona.name} saved but failed to add to world: ${err}`);
        }

        saved.push({ name: persona.name, filename });
      }

      res.json({ status: 'created', count: saved.length, personas: saved });
    } catch (err) {
      console.error('Team generation error:', err);
      res.status(500).json({ error: `Failed to generate team: ${err}` });
    }
  });

  app.post('/api/personas/bulk-delete', (req: Request, res: Response) => {
    const { filenames = [] } = req.body;
    if (filenames.length === 0) {
      res.status(400).json({ error: 'No filenames provided' });
      return;
    }

    const deleted: string[] = [];
    const errors: Array<{ filename: string; error: string }> = [];

    for (const filename of filenames) {
      const filepath = join(CONFIGS_DIR, `${filename}.yaml`);
      if (existsSync(filepath)) {
        try {
          unlinkSync(filepath);
          deleted.push(filename);
        } catch (err) {
          errors.push({ filename, error: String(err) });
        }
      } else {
        errors.push({ filename, error: 'Not found' });
      }
    }

    res.json({ status: 'deleted', deleted, errors });
  });

  app.get('/api/personas/:filename', (req: Request, res: Response) => {
    const filepath = join(CONFIGS_DIR, `${req.params.filename}.yaml`);
    if (!existsSync(filepath)) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }

    const content = readFileSync(filepath, 'utf-8');
    const config = yaml.load(content) as Record<string, unknown>;
    config._filename = req.params.filename;
    res.json(config);
  });

  app.put('/api/personas/:filename', (req: Request, res: Response) => {
    const filepath = join(CONFIGS_DIR, `${req.params.filename}.yaml`);
    if (!existsSync(filepath)) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }

    const data = req.body;
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

    writeFileSync(filepath, yaml.dump(config));
    res.json({ status: 'updated', filename: req.params.filename });
  });

  app.delete('/api/personas/:filename', (req: Request, res: Response) => {
    const filepath = join(CONFIGS_DIR, `${req.params.filename}.yaml`);
    if (!existsSync(filepath)) {
      res.status(404).json({ error: 'Persona not found' });
      return;
    }

    unlinkSync(filepath);
    res.json({ status: 'deleted', filename: req.params.filename });
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

  return { app, server, world };
}

/**
 * Helper function to load all persona configs from the configs directory.
 */
function loadPersonaConfigs(): Array<Record<string, unknown>> {
  const personas: Array<Record<string, unknown>> = [];

  if (!existsSync(CONFIGS_DIR)) {
    return personas;
  }

  const files = readdirSync(CONFIGS_DIR);
  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) {
      continue;
    }

    try {
      const filepath = join(CONFIGS_DIR, file);
      const content = readFileSync(filepath, 'utf-8');
      const config = yaml.load(content) as Record<string, unknown>;
      config._filename = file.replace(/\.ya?ml$/, '');
      personas.push(config);
    } catch (err) {
      console.error(`Failed to load ${file}:`, err);
    }
  }

  return personas;
}
