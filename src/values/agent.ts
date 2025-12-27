/**
 * Agent Values
 *
 * Immutable data structures for AI agents.
 * All fields are readonly - state changes create new objects.
 */

import { AgentId, RoomId, generateAgentId } from './ids.js';
import { ConversationTurn } from './message.js';

// ============================================================================
// AGENT STATUS
// ============================================================================

export type AgentStatus =
  | 'idle'       // Not doing anything
  | 'thinking'   // Processing, about to respond
  | 'responding' // Generating response
  | 'building'   // Executing tools in build mode
  | 'reviewing'  // Reviewing artifacts
  | 'offline';   // Disconnected/unavailable

// ============================================================================
// PERSONALITY TRAITS
// ============================================================================

export interface PersonalityTraits {
  readonly [key: string]: number; // 0.0 to 1.0
}

export function createPersonalityTraits(
  traits: Record<string, number>
): PersonalityTraits {
  const validated: Record<string, number> = {};
  for (const [key, value] of Object.entries(traits)) {
    validated[key] = Math.max(0, Math.min(1, value));
  }
  return Object.freeze(validated);
}

// ============================================================================
// TOOL DEFINITION
// ============================================================================

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown; // JSON Schema
}

// ============================================================================
// AGENT CONFIG (Static configuration)
// ============================================================================

export interface AgentConfig {
  readonly id: AgentId;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model: string;
  readonly temperature: number;
  readonly tools: readonly string[];  // Tool names this agent can use

  // Personality
  readonly personalityTraits: PersonalityTraits;
  readonly speakingStyle: string;
  readonly interests: readonly string[];
  readonly responseTendency: number; // 0.0 (quiet) to 1.0 (talkative)

  // Rich persona fields
  readonly background: string | null;
  readonly expertise: readonly string[];
  readonly warStories: readonly string[];
  readonly strongOpinions: readonly string[];
  readonly currentObsession: string | null;
  readonly blindSpots: readonly string[];
  readonly communicationQuirks: readonly string[];

  // Collaboration
  readonly needsBeforeContributing: readonly string[];
  readonly asksForInfoFrom: Readonly<Record<string, string>>;
}

/**
 * Create a new AgentConfig value with defaults.
 */
export function createAgentConfig(params: {
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  tools?: readonly string[];
  personalityTraits?: Record<string, number>;
  speakingStyle?: string;
  interests?: readonly string[];
  responseTendency?: number;
  background?: string | null;
  expertise?: readonly string[];
  warStories?: readonly string[];
  strongOpinions?: readonly string[];
  currentObsession?: string | null;
  blindSpots?: readonly string[];
  communicationQuirks?: readonly string[];
  needsBeforeContributing?: readonly string[];
  asksForInfoFrom?: Record<string, string>;
  id?: AgentId;
}): AgentConfig {
  return Object.freeze({
    id: params.id ?? generateAgentId(),
    name: params.name,
    description: params.description ?? '',
    systemPrompt: params.systemPrompt ?? '',
    model: params.model ?? 'haiku',
    temperature: params.temperature ?? 0.7,
    tools: Object.freeze(params.tools ?? []),
    personalityTraits: createPersonalityTraits(params.personalityTraits ?? {}),
    speakingStyle: params.speakingStyle ?? '',
    interests: Object.freeze(params.interests ?? []),
    responseTendency: Math.max(0, Math.min(1, params.responseTendency ?? 0.5)),
    background: params.background ?? null,
    expertise: Object.freeze(params.expertise ?? []),
    warStories: Object.freeze(params.warStories ?? []),
    strongOpinions: Object.freeze(params.strongOpinions ?? []),
    currentObsession: params.currentObsession ?? null,
    blindSpots: Object.freeze(params.blindSpots ?? []),
    communicationQuirks: Object.freeze(params.communicationQuirks ?? []),
    needsBeforeContributing: Object.freeze(params.needsBeforeContributing ?? []),
    asksForInfoFrom: Object.freeze(params.asksForInfoFrom ?? {})
  });
}

// ============================================================================
// AGENT STATE (Runtime state - changes during operation)
// ============================================================================

export interface AgentState {
  readonly config: AgentConfig;
  readonly status: AgentStatus;
  readonly currentRoomId: RoomId | null;
  readonly currentTaskId: string | null;
  readonly conversationHistory: readonly ConversationTurn[];
  readonly toolCallCount: number;
  readonly artifacts: readonly string[];
  readonly lastSpokeAt: number | null; // Unix timestamp
  readonly messageCount: number;
}

/**
 * Create initial agent state from config.
 */
export function createAgentState(config: AgentConfig): AgentState {
  return Object.freeze({
    config,
    status: 'idle',
    currentRoomId: null,
    currentTaskId: null,
    conversationHistory: Object.freeze([]),
    toolCallCount: 0,
    artifacts: Object.freeze([]),
    lastSpokeAt: null,
    messageCount: 0
  });
}

// ============================================================================
// STATE TRANSFORMATIONS (Pure functions)
// ============================================================================

/**
 * Update agent status.
 */
export function withStatus(state: AgentState, status: AgentStatus): AgentState {
  return Object.freeze({ ...state, status });
}

/**
 * Set the current room.
 */
export function withRoom(state: AgentState, roomId: RoomId | null): AgentState {
  return Object.freeze({ ...state, currentRoomId: roomId });
}

/**
 * Set the current task.
 */
export function withTask(state: AgentState, taskId: string | null): AgentState {
  return Object.freeze({ ...state, currentTaskId: taskId });
}

/**
 * Add a conversation turn.
 */
export function withConversationTurn(
  state: AgentState,
  turn: ConversationTurn
): AgentState {
  return Object.freeze({
    ...state,
    conversationHistory: Object.freeze([...state.conversationHistory, turn])
  });
}

/**
 * Replace entire conversation history.
 */
export function withConversationHistory(
  state: AgentState,
  history: readonly ConversationTurn[]
): AgentState {
  return Object.freeze({
    ...state,
    conversationHistory: Object.freeze([...history])
  });
}

/**
 * Clear conversation history.
 */
export function clearConversation(state: AgentState): AgentState {
  return Object.freeze({
    ...state,
    conversationHistory: Object.freeze([])
  });
}

/**
 * Increment tool call count.
 */
export function incrementToolCalls(state: AgentState): AgentState {
  return Object.freeze({
    ...state,
    toolCallCount: state.toolCallCount + 1
  });
}

/**
 * Reset tool call count.
 */
export function resetToolCalls(state: AgentState): AgentState {
  return Object.freeze({ ...state, toolCallCount: 0 });
}

/**
 * Add an artifact.
 */
export function withArtifact(state: AgentState, artifact: string): AgentState {
  return Object.freeze({
    ...state,
    artifacts: Object.freeze([...state.artifacts, artifact])
  });
}

/**
 * Clear artifacts.
 */
export function clearArtifacts(state: AgentState): AgentState {
  return Object.freeze({
    ...state,
    artifacts: Object.freeze([])
  });
}

/**
 * Mark that agent spoke.
 */
export function markSpoke(state: AgentState, timestamp: number = Date.now()): AgentState {
  return Object.freeze({
    ...state,
    lastSpokeAt: timestamp,
    messageCount: state.messageCount + 1
  });
}

/**
 * Complete reset for new task.
 */
export function resetForNewTask(state: AgentState): AgentState {
  return Object.freeze({
    ...state,
    status: 'idle',
    currentTaskId: null,
    conversationHistory: Object.freeze([]),
    toolCallCount: 0,
    artifacts: Object.freeze([])
  });
}

// ============================================================================
// AGENT QUERIES (Pure functions)
// ============================================================================

/**
 * Check if agent is busy.
 */
export function isBusy(state: AgentState): boolean {
  return state.status !== 'idle' && state.status !== 'offline';
}

/**
 * Check if agent is available to respond.
 */
export function isAvailable(state: AgentState): boolean {
  return state.status === 'idle';
}

/**
 * Check if agent has exceeded max tool calls.
 */
export function hasExceededToolCalls(state: AgentState, max: number): boolean {
  return state.toolCallCount >= max;
}

/**
 * Get agent display info.
 */
export function getDisplayInfo(state: AgentState): {
  id: AgentId;
  name: string;
  status: AgentStatus;
  messageCount: number;
} {
  return {
    id: state.config.id,
    name: state.config.name,
    status: state.status,
    messageCount: state.messageCount
  };
}

// ============================================================================
// MODEL MAPPING
// ============================================================================

export const MODEL_MAP: Readonly<Record<string, string>> = Object.freeze({
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514'
});

/**
 * Resolve model name to full model ID.
 */
export function resolveModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}
