/**
 * Room Values
 *
 * Immutable data structures for chat rooms/channels.
 * All fields are readonly - state changes create new objects.
 */

import { RoomId, AgentId, generateRoomId, roomId } from './ids.js';
import { ChatMessage } from './message.js';

// ============================================================================
// ROOM PHASE
// ============================================================================

export type RoomPhase =
  | 'empty'      // No agents in room
  | 'active'     // Agents present, ready for messages
  | 'processing' // Waiting for agent responses
  | 'ready';     // All agents have responded

// ============================================================================
// SCHEDULE MODE
// ============================================================================

export type ScheduleMode =
  | 'turn_based' // Round-robin, one at a time
  | 'async'      // Agents speak whenever
  | 'hybrid';    // Rounds + async for mentions

// ============================================================================
// ROOM CONFIG (Static configuration)
// ============================================================================

export interface RoomConfig {
  readonly id: RoomId;
  readonly name: string;
  readonly description: string;
  readonly topic: string;
  readonly scheduleMode: ScheduleMode;
  readonly maxHistory: number;     // Max messages to keep in memory
  readonly createdAt: number;      // Unix timestamp
}

/**
 * Create a new RoomConfig value.
 */
export function createRoomConfig(params: {
  name: string;
  description?: string;
  topic?: string;
  scheduleMode?: ScheduleMode;
  maxHistory?: number;
  id?: RoomId;
}): RoomConfig {
  return Object.freeze({
    id: params.id ?? generateRoomId(),
    name: params.name,
    description: params.description ?? '',
    topic: params.topic ?? '',
    scheduleMode: params.scheduleMode ?? 'turn_based',
    maxHistory: params.maxHistory ?? 100,
    createdAt: Date.now()
  });
}

/**
 * Create the default "general" room config.
 */
export function createGeneralRoom(): RoomConfig {
  return createRoomConfig({
    id: roomId('general'),
    name: 'general',
    description: 'General discussion channel',
    topic: 'General chat',
    scheduleMode: 'turn_based',
    maxHistory: 100
  });
}

// ============================================================================
// ROOM STATE (Runtime state)
// ============================================================================

export interface RoomState {
  readonly config: RoomConfig;
  readonly agents: readonly AgentId[];
  readonly messages: readonly ChatMessage[];
  readonly phase: RoomPhase;
  readonly pendingResponders: readonly AgentId[];  // Agents who haven't responded
  readonly currentRound: number;
  readonly lastActivity: number;  // Unix timestamp
}

/**
 * Create initial room state from config.
 */
export function createRoomState(config: RoomConfig): RoomState {
  return Object.freeze({
    config,
    agents: Object.freeze([]),
    messages: Object.freeze([]),
    phase: 'empty',
    pendingResponders: Object.freeze([]),
    currentRound: 0,
    lastActivity: Date.now()
  });
}

// ============================================================================
// STATE TRANSFORMATIONS (Pure functions)
// ============================================================================

/**
 * Add an agent to the room.
 */
export function withAgentJoined(state: RoomState, agentId: AgentId): RoomState {
  if (state.agents.includes(agentId)) {
    return state; // Already in room
  }
  const newAgents = Object.freeze([...state.agents, agentId]);
  const newPhase: RoomPhase = newAgents.length > 0 ? 'active' : 'empty';

  return Object.freeze({
    ...state,
    agents: newAgents,
    phase: newPhase,
    lastActivity: Date.now()
  });
}

/**
 * Remove an agent from the room.
 */
export function withAgentLeft(state: RoomState, agentId: AgentId): RoomState {
  const newAgents = Object.freeze(state.agents.filter(id => id !== agentId));
  const newPending = Object.freeze(state.pendingResponders.filter(id => id !== agentId));
  const newPhase: RoomPhase = newAgents.length === 0 ? 'empty' : state.phase;

  return Object.freeze({
    ...state,
    agents: newAgents,
    pendingResponders: newPending,
    phase: newPhase,
    lastActivity: Date.now()
  });
}

/**
 * Add a message to the room.
 */
export function withMessage(state: RoomState, message: ChatMessage): RoomState {
  // Trim to max history
  const currentMessages = state.messages.length >= state.config.maxHistory
    ? state.messages.slice(1)
    : state.messages;

  const newMessages = Object.freeze([...currentMessages, message]);

  return Object.freeze({
    ...state,
    messages: newMessages,
    lastActivity: message.timestamp
  });
}

/**
 * Add a message and start waiting for agent responses.
 */
export function withUserMessage(
  state: RoomState,
  message: ChatMessage,
  responders: readonly AgentId[]
): RoomState {
  const withMsg = withMessage(state, message);

  return Object.freeze({
    ...withMsg,
    phase: responders.length > 0 ? 'processing' : 'active',
    pendingResponders: Object.freeze([...responders]),
    currentRound: state.currentRound + 1
  });
}

/**
 * Mark an agent as having responded.
 */
export function withAgentResponded(
  state: RoomState,
  agentId: AgentId,
  message: ChatMessage
): RoomState {
  const withMsg = withMessage(state, message);
  const newPending = Object.freeze(
    state.pendingResponders.filter(id => id !== agentId)
  );
  const newPhase: RoomPhase = newPending.length === 0 ? 'ready' : 'processing';

  return Object.freeze({
    ...withMsg,
    pendingResponders: newPending,
    phase: newPhase
  });
}

/**
 * Set room phase.
 */
export function withPhase(state: RoomState, phase: RoomPhase): RoomState {
  return Object.freeze({ ...state, phase });
}

/**
 * Clear all messages.
 */
export function clearMessages(state: RoomState): RoomState {
  return Object.freeze({
    ...state,
    messages: Object.freeze([]),
    currentRound: 0
  });
}

/**
 * Load messages from persistence.
 */
export function withLoadedMessages(
  state: RoomState,
  messages: readonly ChatMessage[]
): RoomState {
  return Object.freeze({
    ...state,
    messages: Object.freeze([...messages])
  });
}

/**
 * Reset room for new conversation.
 */
export function resetRoom(state: RoomState): RoomState {
  return Object.freeze({
    ...state,
    messages: Object.freeze([]),
    phase: state.agents.length > 0 ? 'active' : 'empty',
    pendingResponders: Object.freeze([]),
    currentRound: 0,
    lastActivity: Date.now()
  });
}

// ============================================================================
// ROOM QUERIES (Pure functions)
// ============================================================================

/**
 * Check if room has any agents.
 */
export function hasAgents(state: RoomState): boolean {
  return state.agents.length > 0;
}

/**
 * Check if a specific agent is in the room.
 */
export function hasAgent(state: RoomState, agentId: AgentId): boolean {
  return state.agents.includes(agentId);
}

/**
 * Check if room is waiting for responses.
 */
export function isWaitingForResponses(state: RoomState): boolean {
  return state.phase === 'processing' && state.pendingResponders.length > 0;
}

/**
 * Get count of pending responders.
 */
export function pendingCount(state: RoomState): number {
  return state.pendingResponders.length;
}

/**
 * Get recent messages (last N).
 */
export function getRecentMessages(
  state: RoomState,
  count: number
): readonly ChatMessage[] {
  const start = Math.max(0, state.messages.length - count);
  return state.messages.slice(start);
}

/**
 * Get messages for context building (for API calls).
 */
export function getContextMessages(
  state: RoomState,
  maxMessages: number = 50
): readonly ChatMessage[] {
  return getRecentMessages(state, maxMessages);
}

/**
 * Get room display info.
 */
export function getDisplayInfo(state: RoomState): {
  id: RoomId;
  name: string;
  agentCount: number;
  messageCount: number;
  phase: RoomPhase;
} {
  return {
    id: state.config.id,
    name: state.config.name,
    agentCount: state.agents.length,
    messageCount: state.messages.length,
    phase: state.phase
  };
}

// ============================================================================
// AGENT SELECTION (Pure functions)
// ============================================================================

/**
 * Select which agents should respond to a message.
 * This is a pure function - no randomness.
 */
export function selectResponders(
  state: RoomState,
  mentionedAgents: readonly AgentId[] | undefined,
  excludeSender: AgentId | null = null
): readonly AgentId[] {
  // If specific agents are mentioned, only they respond
  if (mentionedAgents && mentionedAgents.length > 0) {
    return Object.freeze(
      mentionedAgents.filter(id =>
        state.agents.includes(id) && id !== excludeSender
      )
    );
  }

  // Otherwise, based on schedule mode
  const mode = state.config?.scheduleMode ?? 'turn_based';
  switch (mode) {
    case 'turn_based': {
      // All agents respond in turn-based mode
      return Object.freeze(
        (state.agents ?? []).filter(id => id !== excludeSender)
      );
    }
    case 'async': {
      // In async mode, agents decide themselves (empty for now)
      return Object.freeze([]);
    }
    case 'hybrid': {
      // All agents in hybrid mode too
      return Object.freeze(
        (state.agents ?? []).filter(id => id !== excludeSender)
      );
    }
    default: {
      // Default to empty responders
      return Object.freeze([]);
    }
  }
}
