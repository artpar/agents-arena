/**
 * Interpreter Types
 *
 * Core type definitions for the interpreter pattern.
 *
 * An interpreter is a PURE FUNCTION:
 *   (State, Message) → [NewState, Effect[]]
 *
 * No side effects. No I/O. Just logic.
 */

import { Effect } from '../effects/index.js';

// ============================================================================
// INTERPRETER TYPE
// ============================================================================

/**
 * The core interpreter function signature.
 *
 * Takes current state and a message, returns new state and effects.
 * This function MUST be pure - no side effects allowed.
 *
 * @template S - The state type
 * @template M - The message type (discriminated union)
 */
export type Interpreter<S, M> = (
  state: S,
  message: M
) => readonly [S, readonly Effect[]];

/**
 * Result of an interpreter invocation.
 */
export interface InterpreterResult<S> {
  readonly state: S;
  readonly effects: readonly Effect[];
}

/**
 * Convert interpreter output tuple to result object.
 */
export function toResult<S>(
  [state, effects]: readonly [S, readonly Effect[]]
): InterpreterResult<S> {
  return { state, effects };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Return state unchanged with no effects.
 */
export function noChange<S>(state: S): readonly [S, readonly Effect[]] {
  return [state, []];
}

/**
 * Return state unchanged with effects.
 */
export function withEffects<S>(
  state: S,
  effects: readonly Effect[]
): readonly [S, readonly Effect[]] {
  return [state, effects];
}

/**
 * Return new state with no effects.
 */
export function stateOnly<S>(newState: S): readonly [S, readonly Effect[]] {
  return [newState, []];
}

/**
 * Return new state with effects.
 */
export function stateAndEffects<S>(
  newState: S,
  effects: readonly Effect[]
): readonly [S, readonly Effect[]] {
  return [newState, effects];
}

/**
 * Combine multiple effect arrays.
 */
export function combineEffects(
  ...effectArrays: readonly (readonly Effect[])[]
): readonly Effect[] {
  return Object.freeze(effectArrays.flat());
}

// ============================================================================
// MESSAGE TYPES
// ============================================================================

/**
 * Base interface for all messages.
 */
export interface Message {
  readonly type: string;
}

/**
 * Message that expects a reply.
 */
export interface RequestMessage extends Message {
  readonly replyTag: string;
}

/**
 * Message that is a reply to a request.
 */
export interface ResponseMessage extends Message {
  readonly inReplyTo: string;
}

// ============================================================================
// COMMON MESSAGE PATTERNS
// ============================================================================

/**
 * Initialize message - sent when actor starts.
 */
export interface InitMessage {
  readonly type: 'INIT';
}

/**
 * Shutdown message - sent when actor should stop.
 */
export interface ShutdownMessage {
  readonly type: 'SHUTDOWN';
  readonly reason?: string;
}

/**
 * Reset message - clear state and start fresh.
 */
export interface ResetMessage {
  readonly type: 'RESET';
}

/**
 * Tick message - for periodic updates.
 */
export interface TickMessage {
  readonly type: 'TICK';
  readonly timestamp: number;
}

// ============================================================================
// INTERPRETER COMPOSITION
// ============================================================================

/**
 * Compose two interpreters that handle different message types.
 */
export function composeInterpreters<S, M1, M2>(
  interpreter1: Interpreter<S, M1>,
  interpreter2: Interpreter<S, M2>,
  isM1: (msg: M1 | M2) => msg is M1
): Interpreter<S, M1 | M2> {
  return (state: S, message: M1 | M2) => {
    if (isM1(message)) {
      return interpreter1(state, message);
    } else {
      return interpreter2(state, message as M2);
    }
  };
}

/**
 * Add a middleware that runs before the interpreter.
 */
export function withMiddleware<S, M>(
  interpreter: Interpreter<S, M>,
  middleware: (state: S, message: M) => readonly Effect[]
): Interpreter<S, M> {
  return (state: S, message: M) => {
    const preEffects = middleware(state, message);
    const [newState, postEffects] = interpreter(state, message);
    return [newState, [...preEffects, ...postEffects]];
  };
}

/**
 * Add logging middleware (for debugging).
 */
export function withLogging<S, M extends Message>(
  interpreter: Interpreter<S, M>,
  logger: (msg: string) => void
): Interpreter<S, M> {
  return (state: S, message: M) => {
    logger(`[${message.type}] Processing...`);
    const result = interpreter(state, message);
    logger(`[${message.type}] Done. Effects: ${result[1].length}`);
    return result;
  };
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Error that occurred during message handling.
 * This is a VALUE, not a thrown exception.
 */
export interface InterpreterError {
  readonly type: 'INTERPRETER_ERROR';
  readonly messageType: string;
  readonly error: string;
  readonly timestamp: number;
}

export function interpreterError(
  messageType: string,
  error: string
): InterpreterError {
  return Object.freeze({
    type: 'INTERPRETER_ERROR',
    messageType,
    error,
    timestamp: Date.now()
  });
}

/**
 * Wrap interpreter with error boundary.
 * Catches thrown errors and converts to error effects.
 */
export function withErrorBoundary<S, M extends Message>(
  interpreter: Interpreter<S, M>,
  onError: (state: S, message: M, error: Error) => readonly [S, readonly Effect[]]
): Interpreter<S, M> {
  return (state: S, message: M) => {
    try {
      return interpreter(state, message);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      return onError(state, message, error);
    }
  };
}
