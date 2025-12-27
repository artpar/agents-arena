/**
 * Effects Layer
 *
 * This module exports all effect types used throughout the system.
 *
 * PRINCIPLES:
 * - Effects are DATA describing side effects
 * - Effects are NOT executed here - just defined
 * - Pure interpreters return Effect[] arrays
 * - Boundary executors actually perform the effects
 *
 * EFFECT FLOW:
 * ```
 * Interpreter(state, msg) → [newState, Effect[]]
 *                                      │
 *                                      ▼
 *                              Effect Executor
 *                                      │
 *                    ┌─────────────────┼─────────────────┐
 *                    ▼                 ▼                 ▼
 *              Database           Anthropic          WebSocket
 *              Boundary           Boundary           Boundary
 * ```
 *
 * USAGE:
 * ```typescript
 * import {
 *   Effect,
 *   dbSaveMessage,
 *   callAnthropic,
 *   broadcastToRoom,
 *   sendToAgent
 * } from './effects/index.js';
 *
 * const effects: Effect[] = [
 *   dbSaveMessage(message),
 *   broadcastToRoom(roomId, messageAdded(roomId, message)),
 *   sendToAgent(agentId, respondMessage)
 * ];
 * ```
 */

// ============================================================================
// DATABASE EFFECTS
// ============================================================================

export {
  // Types
  type DbSaveMessage,
  type DbLoadMessages,
  type DbDeleteMessages,
  type DbSaveAgent,
  type DbLoadAgent,
  type DbLoadAllAgents,
  type DbUpdateAgentStats,
  type DbSaveRoom,
  type DbLoadRoom,
  type DbSaveProject,
  type DbSaveTask,
  type DbUpdateTask,
  type DatabaseEffect,

  // Constructors
  dbSaveMessage,
  dbLoadMessages,
  dbDeleteMessages,
  dbSaveAgent,
  dbLoadAgent,
  dbLoadAllAgents,
  dbUpdateAgentStats,
  dbSaveRoom,
  dbLoadRoom,
  dbSaveProject,
  dbSaveTask,
  dbUpdateTask,

  // Type guard
  isDatabaseEffect
} from './database.js';

// ============================================================================
// ANTHROPIC API EFFECTS
// ============================================================================

export {
  // Request types
  type TextContent,
  type ImageContent,
  type ToolUseContent,
  type ToolResultContent,
  type ContentBlock,
  type ApiMessage,
  type ApiToolDefinition,
  type AnthropicRequest,

  // Response types
  type ResponseTextBlock,
  type ResponseToolUseBlock,
  type ResponseContentBlock,
  type ApiUsage,
  type StopReason,
  type AnthropicResponse,

  // Effect types
  type CallAnthropic,
  type CancelApiCall,
  type AnthropicEffect,

  // Constructors
  createAnthropicRequest,
  callAnthropic,
  cancelApiCall,

  // Response helpers
  extractText,
  extractToolUses,
  requiresToolExecution,
  isFinalResponse,
  buildToolResults,
  buildToolResultMessage,
  buildAssistantMessage,

  // Type guard
  isAnthropicEffect
} from './anthropic.js';

// ============================================================================
// TOOL EFFECTS
// ============================================================================

export {
  // Context types
  type ToolContext,
  type ToolResult,

  // Effect types
  type ExecuteTool,
  type ExecuteToolsBatch,
  type CancelToolExecution,
  type ReadFile,
  type WriteFile,
  type ListDirectory,
  type RunBash,
  type ToolEffect,

  // Constructors
  createToolContext,
  successResult,
  errorResult,
  executeTool,
  executeToolsBatch,
  cancelToolExecution,
  readFile,
  writeFile,
  listDirectory,
  runBash,

  // Constants
  TOOL_NAMES,
  type ToolName,

  // Type guard
  isToolEffect
} from './tools.js';

// ============================================================================
// BROADCAST EFFECTS
// ============================================================================

export {
  // Event types
  type MessageAddedEvent,
  type AgentStatusEvent,
  type AgentTypingEvent,
  type AgentJoinedEvent,
  type AgentLeftEvent,
  type PhaseChangedEvent,
  type TaskUpdatedEvent,
  type BuildProgressEvent,
  type ArtifactCreatedEvent,
  type ErrorEvent,
  type SystemNotificationEvent,
  type UIEvent,

  // Effect types
  type BroadcastToRoom,
  type BroadcastToAll,
  type SendToClient,
  type BroadcastEffect,

  // Event constructors
  messageAdded,
  agentStatus,
  agentTyping,
  agentJoined,
  agentLeft,
  phaseChanged,
  taskUpdated,
  buildProgress,
  artifactCreated,
  errorEvent,
  systemNotification,

  // Effect constructors
  broadcastToRoom,
  broadcastToAll,
  sendToClient,

  // Type guard
  isBroadcastEffect
} from './broadcast.js';

// ============================================================================
// ACTOR EFFECTS
// ============================================================================

export {
  // Address types
  type ActorAddress,

  // Message types
  type ActorMessage,
  type TaggedMessage,
  type ReplyMessage,

  // Effect types
  type SendToActor,
  type ForwardToActor,
  type SpawnRoomActor,
  type SpawnAgentActor,
  type SpawnProjectActor,
  type StopActor,
  type RestartActor,
  type ScheduleMessage,
  type CancelScheduled,
  type ScheduleRecurring,
  type WatchActor,
  type UnwatchActor,
  type ActorEffect,

  // Address constructors
  actorAddress,
  roomAddress,
  agentAddress,
  projectAddress,
  directorAddress,
  parseAddress,

  // Effect constructors
  sendToActor,
  sendToRoom,
  sendToAgent,
  sendToProject,
  sendToDirector,
  forwardToActor,
  spawnRoomActor,
  spawnAgentActor,
  spawnProjectActor,
  stopActor,
  restartActor,
  scheduleMessage,
  cancelScheduled,
  scheduleRecurring,
  watchActor,
  unwatchActor,

  // Common messages
  type InitMessage,
  type ShutdownMessage,
  type PingMessage,
  type PongMessage,
  initMessage,
  shutdownMessage,
  pingMessage,
  pongMessage,

  // Type guard
  isActorEffect
} from './actor.js';

// ============================================================================
// UNIFIED EFFECT TYPE
// ============================================================================

import { DatabaseEffect, isDatabaseEffect } from './database.js';
import { AnthropicEffect, isAnthropicEffect } from './anthropic.js';
import { ToolEffect, isToolEffect } from './tools.js';
import { BroadcastEffect, isBroadcastEffect } from './broadcast.js';
import { ActorEffect, isActorEffect } from './actor.js';

/**
 * Union of ALL effect types in the system.
 *
 * This is what interpreters return.
 * The runtime dispatches each effect to the appropriate executor.
 */
export type Effect =
  | DatabaseEffect
  | AnthropicEffect
  | ToolEffect
  | BroadcastEffect
  | ActorEffect;

/**
 * Categorize an effect by its executor type.
 */
export type EffectCategory =
  | 'database'
  | 'anthropic'
  | 'tool'
  | 'broadcast'
  | 'actor';

/**
 * Determine which executor should handle an effect.
 */
export function categorizeEffect(effect: Effect): EffectCategory {
  if (isDatabaseEffect(effect)) return 'database';
  if (isAnthropicEffect(effect)) return 'anthropic';
  if (isToolEffect(effect)) return 'tool';
  if (isBroadcastEffect(effect)) return 'broadcast';
  if (isActorEffect(effect)) return 'actor';

  // TypeScript exhaustiveness check
  const _exhaustive: never = effect;
  throw new Error(`Unknown effect type: ${(_exhaustive as any).type}`);
}

/**
 * Group effects by their category.
 */
export function groupEffects(effects: readonly Effect[]): {
  database: DatabaseEffect[];
  anthropic: AnthropicEffect[];
  tool: ToolEffect[];
  broadcast: BroadcastEffect[];
  actor: ActorEffect[];
} {
  const groups = {
    database: [] as DatabaseEffect[],
    anthropic: [] as AnthropicEffect[],
    tool: [] as ToolEffect[],
    broadcast: [] as BroadcastEffect[],
    actor: [] as ActorEffect[]
  };

  for (const effect of effects) {
    const category = categorizeEffect(effect);
    (groups[category] as Effect[]).push(effect);
  }

  return groups;
}

/**
 * Check if any effects require async execution.
 */
export function hasAsyncEffects(effects: readonly Effect[]): boolean {
  return effects.some(e =>
    isAnthropicEffect(e) ||
    isToolEffect(e) ||
    isDatabaseEffect(e)
  );
}

/**
 * Get effects that can be executed in parallel.
 * Currently: broadcasts and actor sends can run in parallel.
 */
export function getParallelEffects(effects: readonly Effect[]): Effect[] {
  return effects.filter(e =>
    isBroadcastEffect(e) ||
    (isActorEffect(e) && e.type === 'SEND_TO_ACTOR')
  );
}

/**
 * Get effects that must be executed sequentially.
 */
export function getSequentialEffects(effects: readonly Effect[]): Effect[] {
  return effects.filter(e =>
    isDatabaseEffect(e) ||
    isAnthropicEffect(e) ||
    isToolEffect(e)
  );
}
