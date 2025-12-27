/**
 * Runtime Layer
 *
 * This module exports all runtime components for executing effects.
 *
 * BOUNDARY PRINCIPLE:
 * - Pure interpreters produce Effect values
 * - Runtime boundaries execute actual I/O
 * - All side effects are isolated in this layer
 *
 * ARCHITECTURE:
 * ```
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                         Runtime Layer                          │
 * │                                                                 │
 * │  ┌───────────────────────────────────────────────────────────┐ │
 * │  │                    RuntimeContext                         │ │
 * │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │ │
 * │  │  │   Config    │  │   Logger    │  │   Actors    │       │ │
 * │  │  └─────────────┘  └─────────────┘  └─────────────┘       │ │
 * │  └───────────────────────────────────────────────────────────┘ │
 * │                              │                                  │
 * │  ┌───────────────────────────┴───────────────────────────────┐ │
 * │  │                   UnifiedExecutor                         │ │
 * │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │ │
 * │  │  │ Database │ │Anthropic │ │  Tools   │ │Broadcast │     │ │
 * │  │  │ Executor │ │ Executor │ │ Executor │ │ Executor │     │ │
 * │  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │ │
 * │  └───────────────────────────────────────────────────────────┘ │
 * │                              │                                  │
 * │  ┌───────────────────────────┴───────────────────────────────┐ │
 * │  │                    Boundary Layer                         │ │
 * │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │ │
 * │  │  │ SQLite   │ │ Anthropic│ │ File I/O │ │WebSocket │     │ │
 * │  │  │   DB     │ │   API    │ │  Bash    │ │  Server  │     │ │
 * │  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │ │
 * │  └───────────────────────────────────────────────────────────┘ │
 * └─────────────────────────────────────────────────────────────────┘
 * ```
 *
 * USAGE:
 * ```typescript
 * import {
 *   createRuntimeContext,
 *   createRuntimeConfig
 * } from './runtime/index.js';
 *
 * // Create runtime
 * const config = createRuntimeConfig({
 *   anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
 *   databasePath: './data/arena.db'
 * });
 *
 * const runtime = createRuntimeContext(config);
 *
 * // Start runtime
 * await runtime.start();
 *
 * // Execute effects from interpreters
 * const results = await runtime.executor.executeAll(effects);
 *
 * // Stop runtime
 * await runtime.stop();
 * ```
 */

// ============================================================================
// CORE TYPES
// ============================================================================

export {
  // Configuration
  type RuntimeConfig,
  createRuntimeConfig,

  // Effect execution
  type EffectResult,
  type EffectExecutor,
  successResult,
  failureResult,

  // Actor instances
  type ActorInstance,
  createActorInstance,
  withMessage,
  withProcessedMessage,
  withProcessing,

  // Message routing
  type MessageEnvelope,
  createEnvelope,

  // Runtime state
  type RuntimeState,
  type ScheduledMessage,
  createRuntimeState,
  withActor,
  withoutActor,
  withUpdatedActor,
  withPendingEffects,
  clearPendingEffects,
  withScheduledMessage,
  withoutScheduledMessage,
  withRunning,

  // Logging
  type LogLevel,
  type LogEntry,
  type Logger,
  createConsoleLogger,
  createNoopLogger
} from './types.js';

// ============================================================================
// DATABASE BOUNDARY
// ============================================================================

export {
  // Connection
  type DatabaseConnection,
  createDatabaseConnection,
  closeDatabaseConnection,

  // Executor
  createDatabaseExecutor
} from './database.js';

// ============================================================================
// ANTHROPIC BOUNDARY
// ============================================================================

export {
  // Client
  type AnthropicClient,
  createAnthropicClient,

  // Executor
  createAnthropicExecutor,

  // Results
  type ApiCallResult,
  type CancelResult,

  // Utilities
  isPendingCall,
  getPendingCallCount,
  cancelAllCalls
} from './anthropic.js';

// ============================================================================
// TOOLS BOUNDARY
// ============================================================================

export {
  // State
  type ToolsState,
  createToolsState,

  // Executor
  createToolsExecutor
} from './tools.js';

// ============================================================================
// BROADCAST BOUNDARY
// ============================================================================

export {
  // Client connection
  type ClientConnection,
  createClientConnection,

  // State management
  type BroadcastState,
  createBroadcastState,
  addClient,
  removeClient,
  moveClientToRoom,

  // Executor
  createBroadcastExecutor,

  // Results
  type BroadcastResult,

  // Utilities
  getClientCount,
  getRoomClientCount,
  getActiveRooms,

  // WebSocket integration
  type WebSocketServerOptions,
  setupWebSocketHandlers
} from './broadcast.js';

// ============================================================================
// ACTOR RUNTIME
// ============================================================================

export {
  // Runtime
  type ActorRuntime,
  type ActorRuntimeConfig,
  createActorRuntime,
  createActorRuntimeConfig,

  // Actor executor
  createActorEffectExecutor,

  // Statistics
  type RuntimeStats,
  getRuntimeStats
} from './actor.js';

// ============================================================================
// UNIFIED EXECUTOR
// ============================================================================

export {
  // Executor
  type UnifiedExecutor,
  createUnifiedExecutor,

  // Runtime context
  type RuntimeContext,
  createRuntimeContext,

  // Batching
  groupEffectsByCategory,
  executeWithBatching,

  // Statistics
  type ExecutionStats,
  type CategoryStats,
  getExecutionStats
} from './executor.js';
