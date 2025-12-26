/**
 * Agent class using Anthropic SDK for Node.js.
 * Now with SQLite persistence.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { AgentStatus, AgentConfig, PersonalityTraits, AgentData } from '../core/types.js';
import { Message } from '../core/message.js';
import * as db from '../core/database.js';

// Model name mapping
const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514'
};

export class Agent {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  personality_traits: PersonalityTraits;
  speaking_style: string;
  interests: string[];
  response_tendency: number;
  temperature: number;
  model: string;
  tools: string[];
  status: AgentStatus;
  last_spoke_at: Date | null;
  message_count: number;
  conversation_history: Array<{ role: 'user' | 'assistant'; content: string }>;

  // Concrete persona fields
  background: string;
  expertise: string[];
  war_stories: string[];
  strong_opinions: string[];
  current_obsession: string;
  blind_spots: string[];
  communication_quirks: string[];

  private _client: Anthropic | null = null;

  constructor(config: AgentConfig) {
    this.id = config.id || uuidv4();
    this.name = config.name;
    this.description = config.description || '';
    this.personality_traits = config.personality_traits || {};
    this.speaking_style = config.speaking_style || '';
    this.interests = config.interests || [];
    this.response_tendency = config.response_tendency ?? 0.5;
    this.temperature = config.temperature ?? 0.7;
    this.tools = config.tools || [];

    // Concrete persona fields
    this.background = config.background || '';
    this.expertise = config.expertise || [];
    this.war_stories = config.war_stories || [];
    this.strong_opinions = config.strong_opinions || [];
    this.current_obsession = config.current_obsession || '';
    this.blind_spots = config.blind_spots || [];
    this.communication_quirks = config.communication_quirks || [];

    // Map model names
    const modelInput = config.model || 'claude-haiku-4-5-20251001';
    this.model = MODEL_MAP[modelInput] || modelInput;

    // Build system prompt
    this.system_prompt = config.system_prompt || this.buildDefaultPrompt();

    // Runtime state
    this.status = AgentStatus.OFFLINE;
    this.last_spoke_at = null;
    this.message_count = 0;
    this.conversation_history = [];

    // Persist to database
    db.upsertAgent({
      id: this.id,
      name: this.name,
      description: this.description,
      system_prompt: this.system_prompt,
      personality_traits: this.personality_traits,
      speaking_style: this.speaking_style,
      interests: this.interests,
      response_tendency: this.response_tendency,
      temperature: this.temperature,
      model: this.model
    });
  }

  private buildDefaultPrompt(): string {
    // Start with the core identity
    let prompt = `You are ${this.name}.\n\n${this.description}\n`;

    // Add any extra structured fields if present (backwards compatibility)
    if (this.background) {
      prompt += `\n${this.background}\n`;
    }

    if (this.speaking_style) {
      prompt += `\nSpeaking style: ${this.speaking_style}\n`;
    }

    // Minimal format rules only - personality comes from description
    prompt += `
FORMAT:
- @Name to address someone directly
- Keep responses short (1-3 sentences)
- Say "[PASS]" if you have nothing to add
`;

    return prompt;
  }

  /**
   * Initialize the Anthropic client.
   */
  async connect(): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable not set');
    }

    this._client = new Anthropic({ apiKey });
    this.status = AgentStatus.IDLE;
    this.conversation_history = [];
    db.updateAgentStatus(this.id, 'idle');
    console.log(`Agent ${this.name} connected`);
  }

  /**
   * Disconnect the agent.
   */
  async disconnect(): Promise<void> {
    this._client = null;
    this.status = AgentStatus.OFFLINE;
    this.conversation_history = [];
    db.updateAgentStatus(this.id, 'offline');
    console.log(`Agent ${this.name} disconnected`);
  }

  /**
   * Execute one step - generate a response to the current chat context.
   */
  async step(chatContext: string): Promise<string | null> {
    // Connect on first use if not already connected
    if (!this._client) {
      await this.connect();
    }

    this.status = AgentStatus.THINKING;
    console.log(`Agent ${this.name} thinking...`);

    try {
      // Build the message
      const userMessage = `Current conversation:

${chatContext}

Now respond as ${this.name}. Keep it brief (1-2 sentences). Just your response, nothing else.`;

      // Add to conversation history
      this.conversation_history.push({
        role: 'user',
        content: userMessage
      });

      // Keep history manageable (last 40 messages)
      if (this.conversation_history.length > 40) {
        this.conversation_history = this.conversation_history.slice(-40);
      }

      // Call Anthropic API
      const response = await this._client.messages.create({
        model: this.model,
        max_tokens: 10000,
        system: this.system_prompt,
        messages: this.conversation_history,
        temperature: this.temperature
      });

      // Extract response text
      const responseText = (response.content[0] as { type: 'text'; text: string }).text.trim();

      // Add assistant response to history
      this.conversation_history.push({
        role: 'assistant',
        content: responseText
      });

      // Check for [PASS]
      if (responseText === '[PASS]') {
        this.status = AgentStatus.IDLE;
        return null;
      }

      this.status = AgentStatus.SPEAKING;
      this.last_spoke_at = new Date();
      this.message_count += 1;

      console.log(`Agent ${this.name} responded: ${responseText.slice(0, 50)}...`);
      return responseText;

    } catch (error: unknown) {
      const err = error as Error & { status?: number; error?: { message?: string } };
      console.error(`Agent ${this.name} API error:`);
      console.error(`  Status: ${err.status || 'unknown'}`);
      console.error(`  Message: ${err.message || err.error?.message || 'unknown'}`);
      if (err.stack) console.error(`  Stack: ${err.stack.split('\n')[1]}`);
      this.status = AgentStatus.IDLE;
      return null;
    } finally {
      this.status = AgentStatus.IDLE;
    }
  }

  /**
   * Generate a response (alias for step).
   */
  async respond(context: string): Promise<string | null> {
    return this.step(context);
  }

  /**
   * Calculate probability that this agent should respond.
   */
  shouldRespond(message: Message, allAgents: string[]): number {
    let baseProb = this.response_tendency * 0.3;

    // Direct mention - high priority
    const mentionsLower = message.mentions.map(m => m.toLowerCase());
    if (mentionsLower.includes(this.name.toLowerCase())) {
      return Math.min(0.95, baseProb + 0.6);
    }

    // Question - medium boost
    if (message.content.includes('?')) {
      baseProb += 0.15;
    }

    // Topic matches interests
    const contentLower = message.content.toLowerCase();
    for (const interest of this.interests) {
      if (contentLower.includes(interest.toLowerCase())) {
        baseProb += 0.1;
        break;
      }
    }

    // Recently spoke - reduce
    if (this.last_spoke_at) {
      const secondsAgo = (Date.now() - this.last_spoke_at.getTime()) / 1000;
      if (secondsAgo < 10) {
        baseProb *= 0.3;
      } else if (secondsAgo < 30) {
        baseProb *= 0.6;
      }
    }

    return Math.min(0.8, baseProb);
  }

  /**
   * Create an agent from a config dict.
   */
  static fromConfig(config: AgentConfig): Agent {
    return new Agent(config);
  }

  /**
   * Serialize agent to dictionary.
   */
  toDict(): AgentData {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      personality_traits: this.personality_traits,
      speaking_style: this.speaking_style,
      interests: this.interests,
      response_tendency: this.response_tendency,
      temperature: this.temperature,
      model: this.model,
      status: this.status,
      message_count: this.message_count,
      last_spoke_at: this.last_spoke_at?.toISOString() || null
    };
  }
}
