/**
 * Agent class using Anthropic SDK for Node.js.
 * Now with SQLite persistence and tool support.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { AgentStatus, AgentConfig, PersonalityTraits, AgentData } from '../core/types.js';
import { Message } from '../core/message.js';
import * as db from '../core/database.js';
import {
  ToolContext,
  getAllToolDefinitions,
  executeTool,
  getAgentWorkspace,
  getSharedWorkspace
} from '../tools/index.js';

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
  conversation_history: Anthropic.MessageParam[];

  // Concrete persona fields
  background: string;
  expertise: string[];
  war_stories: string[];
  strong_opinions: string[];
  current_obsession: string;
  blind_spots: string[];
  communication_quirks: string[];

  // Expertise dependencies
  needs_before_contributing: string[];
  asks_for_info_from: Record<string, string>;

  private _client: Anthropic | null = null;

  // Callback for tool use events (set by world for broadcasting)
  onToolUse?: (event: { agentId: string; agentName: string; toolName: string; input: unknown }) => void;
  onToolResult?: (event: { agentId: string; agentName: string; toolName: string; result: string; isError: boolean }) => void;

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

    // Expertise dependencies
    this.needs_before_contributing = config.needs_before_contributing || [];
    this.asks_for_info_from = config.asks_for_info_from || {};

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

    // Add expertise and dependencies
    if (this.expertise.length > 0) {
      prompt += `\nYOU PROVIDE (your expertise - others will ask you for this):
${this.expertise.map(e => `• ${e}`).join('\n')}
`;
    }

    if (this.needs_before_contributing.length > 0) {
      prompt += `\nYOU NEED BEFORE CONTRIBUTING:
${this.needs_before_contributing.map(n => `• ${n}`).join('\n')}
`;
    }

    if (Object.keys(this.asks_for_info_from).length > 0) {
      prompt += `\nWHO TO ASK:
${Object.entries(this.asks_for_info_from).map(([info, role]) => `• "${info}" → ask the ${role}`).join('\n')}

When you need information, @mention the specific person who can provide it.
If you're missing info you need, ASK for it before proceeding.
When someone asks about your expertise, provide a clear, actionable answer.
`;
    }

    // Workspace and tools info
    prompt += `
YOUR TOOLS - Use the RIGHT tool:

1. str_replace_based_edit_tool - For CODE and structured files
   - Write actual code (scripts, config files, source code)
   - Use command: 'create' with path and file_text
   - Use command: 'view' to see existing files
   - Files persist in your workspace

2. memory - For notes and quick records
   - Store meeting notes, decisions, quick references
   - Use 'view' first to check what exists
   - Good for temporary working notes

3. bash - For running commands and getting real data
   - Run calculations, process data, check system state
   - Execute scripts you've written
   - Get current date/time, file listings, etc.

4. web_search - For current information
   - Look up facts, prices, statistics
   - Research competitors, market data
   - Find documentation or best practices

PICK THE RIGHT TOOL:
- Writing code → str_replace_based_edit_tool
- Need current info → web_search
- Need to calculate/process → bash
- Quick notes → memory

ACTION MODE - NO MORE MEETINGS

You are a DOER, not a TALKER. When given a task:

DO:
- Take immediate action using your tools
- Create deliverables (documents, analyses, code, files)
- Make decisions and state them clearly
- Use the APPROPRIATE tool for the task
- Report what you COMPLETED

DO NOT:
- Say "I'll work on X" - just DO it now
- Schedule future meetings or syncs
- Say "let's discuss" or "we should talk about"
- Write vague plans without concrete deliverables
- Defer action to later

RESPONSE FORMAT:
- 1-2 sentences max
- State what you DID or DECIDED
- If you used a tool, say what you created
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
   * Implements agentic loop for tool execution.
   */
  async step(chatContext: string, roomId: string): Promise<string | null> {
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

Now respond as ${this.name}. Stay in character and keep it brief.
Use your tools if you need to take action or remember something.`;

      // Add to conversation history
      this.conversation_history.push({
        role: 'user',
        content: userMessage
      });

      // Keep history manageable (last 40 messages)
      if (this.conversation_history.length > 40) {
        this.conversation_history = this.conversation_history.slice(-40);
      }

      // Get tool definitions
      const tools = getAllToolDefinitions();

      // Build tool context
      const toolCtx: ToolContext = {
        roomId,
        agentId: this.id,
        agentName: this.name,
        workDir: getAgentWorkspace(roomId, this.id),
        sharedDir: getSharedWorkspace(roomId)
      };

      // Call Anthropic API with tools
      let response = await this._client.messages.create({
        model: this.model,
        max_tokens: 10000,
        system: this.system_prompt,
        messages: this.conversation_history,
        temperature: this.temperature,
        tools: tools as Anthropic.Tool[]
      });

      // Agentic loop - process tool calls until done
      let loopCount = 0;
      const maxLoops = 10; // Safety limit

      while (response.stop_reason === 'tool_use' && loopCount < maxLoops) {
        loopCount++;
        console.log(`Agent ${this.name} using tools (loop ${loopCount})...`);

        // Add assistant response to history
        this.conversation_history.push({
          role: 'assistant',
          content: response.content
        });

        // Process each tool use block
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type === 'tool_use') {
            console.log(`  Tool: ${block.name}`);

            // Log tool use to database
            db.logEvent('tool_use', {
              agent_id: this.id,
              agent_name: this.name,
              tool_name: block.name,
              tool_input: block.input,
              room_id: roomId
            });

            // Emit tool use event for UI
            if (this.onToolUse) {
              this.onToolUse({
                agentId: this.id,
                agentName: this.name,
                toolName: block.name,
                input: block.input
              });
            }

            const result = await executeTool(block.name, block.input as Record<string, unknown>, toolCtx);

            // Log tool result
            db.logEvent('tool_result', {
              agent_id: this.id,
              agent_name: this.name,
              tool_name: block.name,
              is_error: result.is_error || false,
              result_length: result.content.length
            });

            // Emit tool result event for UI
            if (this.onToolResult) {
              this.onToolResult({
                agentId: this.id,
                agentName: this.name,
                toolName: block.name,
                result: result.content.slice(0, 500),  // Truncate for UI
                isError: result.is_error || false
              });
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.content,
              is_error: result.is_error
            });
          }
        }

        // Add tool results to history
        this.conversation_history.push({
          role: 'user',
          content: toolResults
        });

        // Continue the conversation
        response = await this._client.messages.create({
          model: this.model,
          max_tokens: 10000,
          system: this.system_prompt,
          messages: this.conversation_history,
          temperature: this.temperature,
          tools: tools as Anthropic.Tool[]
        });
      }

      // Extract text from final response
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      const responseText = textBlocks.map(b => b.text).join('\n').trim();

      // No response? Don't touch history, return null
      if (!responseText) {
        return null;
      }

      // Has content - add to history
      this.conversation_history.push({
        role: 'assistant',
        content: response.content
      });

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
  async respond(context: string, roomId: string): Promise<string | null> {
    return this.step(context, roomId);
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
      last_spoke_at: this.last_spoke_at?.toISOString() || null,
      expertise: this.expertise,
      needs_before_contributing: this.needs_before_contributing,
      asks_for_info_from: this.asks_for_info_from
    };
  }
}
