/**
 * Arena World - main orchestrator for agent interactions.
 * Uses setInterval instead of asyncio.Task for cleaner scheduling.
 * Now with SQLite persistence for sessions and event logging.
 */

import { v4 as uuidv4 } from 'uuid';
import { ScheduleMode, AgentStatus, MessageType, WorldStatus, Attachment } from '../core/types.js';
import { EventBus } from '../core/events.js';
import { Message } from '../core/message.js';
import { Agent } from '../agents/agent.js';
import { AgentRegistry } from './registry.js';
import { Channel } from './channel.js';
import * as db from '../core/database.js';

export class ArenaWorld {
  name: string;
  registry: AgentRegistry;
  channels: Map<string, Channel>;
  eventBus: EventBus;
  mode: ScheduleMode;
  roundInterval: number; // seconds between rounds
  maxSpeakersPerRound: number;
  running: boolean;
  currentRound: number;
  startTime: Date | null;
  defaultChannel: string;
  sessionId: string | null = null;
  totalMessagesInSession: number = 0;
  maxTurns: number = 20; // Auto-stop after this many rounds

  private schedulerInterval: NodeJS.Timeout | null = null;
  private lastRoundTime: Date = new Date();

  constructor(name: string = 'Agent Arena') {
    this.name = name;
    this.registry = new AgentRegistry();
    this.channels = new Map();
    this.eventBus = new EventBus();
    this.mode = ScheduleMode.HYBRID;
    this.roundInterval = 5.0;
    this.maxSpeakersPerRound = 3;
    this.running = false;
    this.currentRound = 0;
    this.startTime = null;
    this.defaultChannel = 'general';

    // Try to load existing default channel from database, otherwise create new
    const existingRoom = db.getRoom(this.defaultChannel);
    if (existingRoom) {
      const channel = Channel.fromDatabase(existingRoom.id);
      if (channel) {
        this.channels.set(this.defaultChannel, channel);
        console.log(`Loaded existing room '${this.defaultChannel}' from database`);
      } else {
        this.channels.set(this.defaultChannel, new Channel(
          this.defaultChannel,
          'General discussion'
        ));
      }
    } else {
      this.channels.set(this.defaultChannel, new Channel(
        this.defaultChannel,
        'General discussion'
      ));
    }
  }

  // === Agent Management ===

  async addAgent(agent: Agent, channelNames?: string[]): Promise<void> {
    // Register
    this.registry.register(agent);

    // Connect the agent's SDK client
    await agent.connect();

    // Join channels
    const channels = channelNames || [this.defaultChannel];
    for (const channelName of channels) {
      const channel = this.channels.get(channelName);
      if (channel) {
        channel.addMember(agent.id);
      }
    }

    // Emit join event
    this.eventBus.emitEvent('agent_joined', {
      agent_id: agent.id,
      agent_name: agent.name
    });

    // Broadcast join message
    const joinMsg = new Message(
      'system',
      'System',
      `${agent.name} has joined the chat`,
      this.defaultChannel,
      MessageType.JOIN
    );
    await this.broadcast(joinMsg);

    console.log(`Agent ${agent.name} joined the arena`);
  }

  async removeAgent(agentId: string): Promise<Agent | undefined> {
    const agent = this.registry.get(agentId);
    if (!agent) {
      return undefined;
    }

    // Broadcast leave message
    const leaveMsg = new Message(
      'system',
      'System',
      `${agent.name} has left the chat`,
      this.defaultChannel,
      MessageType.LEAVE
    );
    await this.broadcast(leaveMsg);

    // Leave all channels
    for (const channel of this.channels.values()) {
      channel.removeMember(agentId);
    }

    // Disconnect agent
    await agent.disconnect();

    // Unregister
    this.registry.unregister(agentId);

    // Emit leave event
    this.eventBus.emitEvent('agent_left', {
      agent_id: agentId,
      agent_name: agent.name
    });

    console.log(`Agent ${agent.name} left the arena`);
    return agent;
  }

  // === Channel Management ===

  createChannel(name: string, description: string = ''): Channel {
    const channel = new Channel(name, description);
    this.channels.set(name, channel);
    return channel;
  }

  getChannel(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  // === Messaging ===

  async broadcast(message: Message): Promise<void> {
    const channel = this.channels.get(message.channel);
    if (!channel) {
      console.warn(`Channel ${message.channel} not found`);
      return;
    }

    // Add to channel history (this persists to database)
    channel.addMessage(message);

    // Increment session message count
    if (this.sessionId) {
      this.totalMessagesInSession++;
    }

    // Log event to database
    db.logEvent('message', {
      message_id: message.id,
      channel: message.channel,
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      content_length: message.content.length,
      mentions: message.mentions
    }, this.sessionId || undefined);

    // Emit message event
    this.eventBus.emitEvent('message', {
      channel: message.channel,
      message: message.toDict()
    });

    console.log(`[${message.channel}] <${message.sender_name}> ${message.content}`);
  }

  async injectMessage(
    content: string,
    senderName: string = 'Human',
    channelName?: string,
    attachments?: Attachment[]
  ): Promise<Message> {
    const message = new Message(
      'human',
      senderName,
      content,
      channelName || this.defaultChannel,
      MessageType.CHAT,
      undefined,
      undefined,
      undefined,
      undefined,
      attachments
    );
    await this.broadcast(message);
    return message;
  }

  // === Simulation Control ===

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.startTime = new Date();
    this.lastRoundTime = new Date();
    this.totalMessagesInSession = 0;

    // Create session in database
    this.sessionId = uuidv4();
    db.createSession(this.sessionId, this.name, this.mode);
    db.logEvent('simulation_started', { mode: this.mode, session_id: this.sessionId }, this.sessionId);

    // Start scheduler - runs every second
    this.schedulerInterval = setInterval(() => {
      this.tick().catch(err => {
        console.error('Scheduler error:', err);
      });
    }, 1000);

    this.eventBus.emitEvent('simulation_started', {
      mode: this.mode,
      session_id: this.sessionId
    });

    console.log(`Simulation started in ${this.mode} mode (session: ${this.sessionId})`);
  }

  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Stop scheduler
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }

    // End session in database
    if (this.sessionId) {
      db.endSession(this.sessionId, this.currentRound, this.totalMessagesInSession);
      db.logEvent('simulation_stopped', {
        rounds: this.currentRound,
        messages: this.totalMessagesInSession
      }, this.sessionId);
    }

    this.eventBus.emitEvent('simulation_stopped', {
      rounds: this.currentRound,
      session_id: this.sessionId
    });

    console.log(`Simulation stopped (${this.currentRound} rounds, ${this.totalMessagesInSession} messages)`);
    this.sessionId = null;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    // Check if we've hit max turns
    if (this.maxTurns > 0 && this.currentRound >= this.maxTurns) {
      console.log(`Max turns (${this.maxTurns}) reached, stopping simulation`);
      this.stop();
      return;
    }

    switch (this.mode) {
      case ScheduleMode.TURN_BASED:
        await this.tickTurnBased();
        break;
      case ScheduleMode.ASYNC:
        await this.checkAsyncResponses();
        break;
      case ScheduleMode.HYBRID:
        await this.runHybridStep();
        break;
    }
  }

  private async tickTurnBased(): Promise<void> {
    const elapsed = (Date.now() - this.lastRoundTime.getTime()) / 1000;
    if (elapsed >= this.roundInterval) {
      await this.runRound();
      this.lastRoundTime = new Date();
    }
  }

  private async runRound(): Promise<void> {
    this.currentRound += 1;

    this.eventBus.emitEvent('round_started', {
      round: this.currentRound
    });

    // Get agents who want to speak
    const speakers = await this.selectSpeakers();

    // Have each speaker respond
    for (const agent of speakers.slice(0, this.maxSpeakersPerRound)) {
      await this.agentRespond(agent);
    }

    this.eventBus.emitEvent('round_ended', {
      round: this.currentRound,
      speakers: speakers.length
    });
  }

  private async checkAsyncResponses(): Promise<void> {
    const channel = this.channels.get(this.defaultChannel);
    if (!channel) return;

    const recent = channel.getRecentMessages(1);
    if (recent.length === 0) return;

    const lastMessage = recent[recent.length - 1];

    // Check for direct mentions
    for (const agent of this.registry.all()) {
      // Allow OFFLINE (not yet connected) or IDLE agents to respond
      if (agent.status !== AgentStatus.IDLE && agent.status !== AgentStatus.OFFLINE) {
        continue;
      }

      const mentionsLower = lastMessage.mentions.map(m => m.toLowerCase());
      if (mentionsLower.includes(agent.name.toLowerCase())) {
        await this.agentRespond(agent);
      }
    }
  }

  private async runHybridStep(): Promise<void> {
    const channel = this.channels.get(this.defaultChannel);
    if (!channel) return;

    const recent = channel.getRecentMessages(1);

    // Check for urgent responses (mentions)
    if (recent.length > 0) {
      const lastMessage = recent[recent.length - 1];
      for (const agent of this.registry.all()) {
        // Allow OFFLINE (not yet connected) or IDLE agents to respond
        if (agent.status !== AgentStatus.IDLE && agent.status !== AgentStatus.OFFLINE) {
          continue;
        }
        const mentionsLower = lastMessage.mentions.map(m => m.toLowerCase());
        if (mentionsLower.includes(agent.name.toLowerCase())) {
          await this.agentRespond(agent);
          return;
        }
      }
    }

    // Periodic round check
    const elapsed = (Date.now() - this.lastRoundTime.getTime()) / 1000;
    if (elapsed >= this.roundInterval) {
      await this.runRound();
      this.lastRoundTime = new Date();
    }
  }

  private async selectSpeakers(): Promise<Agent[]> {
    const channel = this.channels.get(this.defaultChannel);
    if (!channel) return [];

    const recent = channel.getRecentMessages(1);

    if (recent.length === 0) {
      // No messages yet - pick a random agent to start
      const agents = this.registry.all();
      if (agents.length > 0) {
        const randomIndex = Math.floor(Math.random() * agents.length);
        return [agents[randomIndex]];
      }
      return [];
    }

    const lastMessage = recent[recent.length - 1];
    const candidates: Array<[number, Agent]> = [];

    for (const agent of this.registry.all()) {
      // Allow OFFLINE (not yet connected) or IDLE agents to respond
      if (agent.status !== AgentStatus.IDLE && agent.status !== AgentStatus.OFFLINE) {
        continue;
      }
      if (agent.id === lastMessage.sender_id) {
        continue; // Skip the last speaker
      }

      const probability = agent.shouldRespond(lastMessage, this.registry.names());
      if (Math.random() < probability) {
        candidates.push([probability, agent]);
      }
    }

    // Sort by probability and return top speakers
    candidates.sort((a, b) => b[0] - a[0]);
    return candidates.map(([, agent]) => agent);
  }

  async agentRespond(agent: Agent): Promise<Message | null> {
    const channel = this.channels.get(this.defaultChannel);
    if (!channel) return null;

    // Build context from recent messages
    const context = `Current conversation in #${channel.name}:

${channel.getContextString(20)}

Participants: ${this.registry.names().join(', ')}

Now respond naturally as ${agent.name}. Keep it brief (1-2 sentences).
IMPORTANT: Just write your response directly. Do NOT include your name, timestamps, or angle brackets.`;

    // Emit thinking event
    this.eventBus.emitEvent('agent_thinking', {
      agent_id: agent.id,
      agent_name: agent.name,
      thinking: true
    });

    // Log agent thinking start
    db.logEvent('agent_thinking_start', {
      agent_id: agent.id,
      agent_name: agent.name
    }, this.sessionId || undefined);

    // Get response from agent
    const responseText = await agent.respond(context);

    // Log agent thinking end
    db.logEvent('agent_thinking_end', {
      agent_id: agent.id,
      agent_name: agent.name,
      responded: !!responseText
    }, this.sessionId || undefined);

    // Emit thinking done event
    this.eventBus.emitEvent('agent_thinking', {
      agent_id: agent.id,
      agent_name: agent.name,
      thinking: false
    });

    if (!responseText) {
      return null;
    }

    // Create and broadcast message
    const message = new Message(
      agent.id,
      agent.name,
      responseText,
      channel.name
    );
    await this.broadcast(message);

    return message;
  }

  // === Status ===

  getStatus(): WorldStatus {
    const channelsData: Record<string, ReturnType<Channel['toDict']>> = {};
    for (const [name, channel] of this.channels) {
      channelsData[name] = channel.toDict();
    }

    return {
      name: this.name,
      running: this.running,
      mode: this.mode,
      current_round: this.currentRound,
      max_turns: this.maxTurns,
      start_time: this.startTime?.toISOString() || null,
      agents: {
        count: this.registry.count(),
        names: this.registry.names()
      },
      channels: channelsData
    };
  }
}
