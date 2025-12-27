/**
 * Runtime Types
 *
 * Core type definitions for the runtime layer.
 *
 * The runtime is the BOUNDARY where effects are executed.
 * It's the only place where side effects happen.
 *
 * ARCHITECTURE:
 * ```
 * ┌─────────────────────────────────────────────────────────┐
 * │                      Runtime                            │
 * │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
 * │  │   Actor     │  │   Effect    │  │  Message    │     │
 * │  │   System    │  │   Executor  │  │   Router    │     │
 * │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
 * │         │                │                │             │
 * │  ┌──────┴────────────────┴────────────────┴──────┐     │
 * │  │              Boundary Executors               │     │
 * │  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │     │
 * │  │  │Database│ │Anthropic│ │ Tools │ │  WS   │ │     │
 * │  │  └────────┘ └────────┘ └────────┘ └────────┘ │     │
 * │  └───────────────────────────────────────────────┘     │
 * └─────────────────────────────────────────────────────────┘
 * ```
 */

import { Effect } from '../effects/index.js';
import { ActorAddress, ActorMessage } from '../effects/actor.js';

// ============================================================================
// RUNTIME CONFIGURATION
// ============================================================================

/**
 * Configuration for the runtime.
 */
export interface RuntimeConfig {
  readonly anthropicApiKey: string;
  readonly databasePath: string;
  readonly workspacePath: string;
  readonly sharedWorkspacePath: string;
  readonly maxConcurrentApiCalls: number;
  readonly maxToolExecutionTime: number;
  readonly enableLogging: boolean;
}

/**
 * Create runtime config with defaults.
 */
export function createRuntimeConfig(params: {
  anthropicApiKey: string;
  databasePath?: string;
  workspacePath?: string;
  sharedWorkspacePath?: string;
  maxConcurrentApiCalls?: number;
  maxToolExecutionTime?: number;
  enableLogging?: boolean;
}): RuntimeConfig {
  return Object.freeze({
    anthropicApiKey: params.anthropicApiKey,
    databasePath: params.databasePath ?? './data/arena.db',
    workspacePath: params.workspacePath ?? './workspaces',
    sharedWorkspacePath: params.sharedWorkspacePath ?? './shared',
    maxConcurrentApiCalls: params.maxConcurrentApiCalls ?? 5,
    maxToolExecutionTime: params.maxToolExecutionTime ?? 30000,
    enableLogging: params.enableLogging ?? true
  });
}

// ============================================================================
// EFFECT EXECUTION
// ============================================================================

/**
 * Result of executing an effect.
 */
export interface EffectResult {
  readonly success: boolean;
  readonly effect: Effect;
  readonly result?: unknown;
  readonly error?: string;
  readonly duration: number;
}

/**
 * Create a successful effect result.
 */
export function successResult(
  effect: Effect,
  result: unknown,
  duration: number
): EffectResult {
  return Object.freeze({
    success: true,
    effect,
    result,
    duration
  });
}

/**
 * Create a failed effect result.
 */
export function failureResult(
  effect: Effect,
  error: string,
  duration: number
): EffectResult {
  return Object.freeze({
    success: false,
    effect,
    error,
    duration
  });
}

/**
 * Interface for effect executors.
 */
export interface EffectExecutor {
  execute(effect: Effect): Promise<EffectResult>;
  canHandle(effect: Effect): boolean;
}

// ============================================================================
// ACTOR SYSTEM
// ============================================================================

/**
 * Actor instance in the runtime.
 */
export interface ActorInstance<S, M> {
  readonly address: ActorAddress;
  readonly state: S;
  readonly interpreter: (state: S, message: M) => readonly [S, readonly Effect[]];
  readonly mailbox: readonly M[];
  readonly isProcessing: boolean;
  readonly createdAt: number;
  readonly lastMessageAt: number | null;
}

/**
 * Create an actor instance.
 */
export function createActorInstance<S, M>(
  address: ActorAddress,
  initialState: S,
  interpreter: (state: S, message: M) => readonly [S, readonly Effect[]]
): ActorInstance<S, M> {
  return Object.freeze({
    address,
    state: initialState,
    interpreter,
    mailbox: Object.freeze([]),
    isProcessing: false,
    createdAt: Date.now(),
    lastMessageAt: null
  });
}

/**
 * Actor with message in mailbox.
 */
export function withMessage<S, M>(
  actor: ActorInstance<S, M>,
  message: M
): ActorInstance<S, M> {
  return Object.freeze({
    ...actor,
    mailbox: Object.freeze([...actor.mailbox, message])
  });
}

/**
 * Actor with updated state and cleared mailbox head.
 */
export function withProcessedMessage<S, M>(
  actor: ActorInstance<S, M>,
  newState: S
): ActorInstance<S, M> {
  return Object.freeze({
    ...actor,
    state: newState,
    mailbox: Object.freeze(actor.mailbox.slice(1)),
    isProcessing: false,
    lastMessageAt: Date.now()
  });
}

/**
 * Actor in processing state.
 */
export function withProcessing<S, M>(
  actor: ActorInstance<S, M>,
  processing: boolean
): ActorInstance<S, M> {
  return Object.freeze({
    ...actor,
    isProcessing: processing
  });
}

// ============================================================================
// MESSAGE ROUTING
// ============================================================================

/**
 * Envelope for routing messages.
 */
export interface MessageEnvelope {
  readonly to: ActorAddress;
  readonly message: ActorMessage;
  readonly from?: ActorAddress;
  readonly timestamp: number;
  readonly id: string;
}

/**
 * Create a message envelope.
 */
export function createEnvelope(
  to: ActorAddress,
  message: ActorMessage,
  from?: ActorAddress
): MessageEnvelope {
  return Object.freeze({
    to,
    message,
    from,
    timestamp: Date.now(),
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`
  });
}

// ============================================================================
// RUNTIME STATE
// ============================================================================

/**
 * State of the runtime system.
 */
export interface RuntimeState {
  readonly actors: Readonly<Record<string, ActorInstance<unknown, unknown>>>;
  readonly pendingEffects: readonly Effect[];
  readonly scheduledMessages: readonly ScheduledMessage[];
  readonly isRunning: boolean;
  readonly startedAt: number | null;
}

/**
 * Scheduled message for delayed delivery.
 */
export interface ScheduledMessage {
  readonly id: string;
  readonly envelope: MessageEnvelope;
  readonly executeAt: number;
  readonly isRecurring: boolean;
  readonly intervalMs?: number;
}

/**
 * Create initial runtime state.
 */
export function createRuntimeState(): RuntimeState {
  return Object.freeze({
    actors: Object.freeze({}),
    pendingEffects: Object.freeze([]),
    scheduledMessages: Object.freeze([]),
    isRunning: false,
    startedAt: null
  });
}

/**
 * Add an actor to runtime state.
 */
export function withActor(
  state: RuntimeState,
  actor: ActorInstance<unknown, unknown>
): RuntimeState {
  return Object.freeze({
    ...state,
    actors: Object.freeze({
      ...state.actors,
      [actor.address]: actor
    })
  });
}

/**
 * Remove an actor from runtime state.
 */
export function withoutActor(
  state: RuntimeState,
  address: ActorAddress
): RuntimeState {
  const { [address]: removed, ...remaining } = state.actors;
  return Object.freeze({
    ...state,
    actors: Object.freeze(remaining)
  });
}

/**
 * Update an actor in runtime state.
 */
export function withUpdatedActor(
  state: RuntimeState,
  actor: ActorInstance<unknown, unknown>
): RuntimeState {
  return Object.freeze({
    ...state,
    actors: Object.freeze({
      ...state.actors,
      [actor.address]: actor
    })
  });
}

/**
 * Add pending effects.
 */
export function withPendingEffects(
  state: RuntimeState,
  effects: readonly Effect[]
): RuntimeState {
  return Object.freeze({
    ...state,
    pendingEffects: Object.freeze([...state.pendingEffects, ...effects])
  });
}

/**
 * Clear pending effects.
 */
export function clearPendingEffects(state: RuntimeState): RuntimeState {
  return Object.freeze({
    ...state,
    pendingEffects: Object.freeze([])
  });
}

/**
 * Add a scheduled message.
 */
export function withScheduledMessage(
  state: RuntimeState,
  scheduled: ScheduledMessage
): RuntimeState {
  return Object.freeze({
    ...state,
    scheduledMessages: Object.freeze([...state.scheduledMessages, scheduled])
  });
}

/**
 * Remove a scheduled message.
 */
export function withoutScheduledMessage(
  state: RuntimeState,
  id: string
): RuntimeState {
  return Object.freeze({
    ...state,
    scheduledMessages: Object.freeze(
      state.scheduledMessages.filter(s => s.id !== id)
    )
  });
}

/**
 * Set running state.
 */
export function withRunning(state: RuntimeState, running: boolean): RuntimeState {
  return Object.freeze({
    ...state,
    isRunning: running,
    startedAt: running && !state.startedAt ? Date.now() : state.startedAt
  });
}

// ============================================================================
// LOGGING
// ============================================================================

/**
 * Log levels.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log entry.
 */
export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Logger interface.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Create a console logger.
 */
export function createConsoleLogger(minLevel: LogLevel = 'info'): Logger {
  const levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3
  };

  const shouldLog = (level: LogLevel): boolean => {
    return levels[level] >= levels[minLevel];
  };

  const formatContext = (ctx?: Record<string, unknown>): string => {
    if (!ctx || Object.keys(ctx).length === 0) return '';
    return ' ' + JSON.stringify(ctx);
  };

  return {
    debug(message: string, context?: Record<string, unknown>): void {
      if (shouldLog('debug')) {
        console.debug(`[DEBUG] ${message}${formatContext(context)}`);
      }
    },
    info(message: string, context?: Record<string, unknown>): void {
      if (shouldLog('info')) {
        console.info(`[INFO] ${message}${formatContext(context)}`);
      }
    },
    warn(message: string, context?: Record<string, unknown>): void {
      if (shouldLog('warn')) {
        console.warn(`[WARN] ${message}${formatContext(context)}`);
      }
    },
    error(message: string, context?: Record<string, unknown>): void {
      if (shouldLog('error')) {
        console.error(`[ERROR] ${message}${formatContext(context)}`);
      }
    }
  };
}

/**
 * Create a no-op logger.
 */
export function createNoopLogger(): Logger {
  return {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {}
  };
}
