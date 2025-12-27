/**
 * Interpreters Layer
 *
 * This module exports all interpreters used in the system.
 *
 * PRINCIPLES:
 * - Interpreters are PURE FUNCTIONS
 * - (State, Message) → [NewState, Effect[]]
 * - NO side effects. NO I/O. Just logic.
 * - Effects are DATA describing what to do
 *
 * INTERPRETER HIERARCHY:
 * ```
 *                    Director
 *                       │
 *         ┌─────────────┼─────────────┐
 *         ▼             ▼             ▼
 *       Room         Agent        Project
 *         │             │             │
 *         ▼             ▼             ▼
 *    [Messages]   [API Calls]    [Tasks]
 * ```
 *
 * DATA FLOW:
 * ```
 * Message → Interpreter → [NewState, Effect[]]
 *                              │
 *                              ▼
 *                         Runtime
 *                              │
 *              ┌───────────────┼───────────────┐
 *              ▼               ▼               ▼
 *          Database        Anthropic       WebSocket
 *          Boundary        Boundary        Boundary
 * ```
 *
 * USAGE:
 * ```typescript
 * import {
 *   roomInterpreter,
 *   agentInterpreter,
 *   projectInterpreter,
 *   directorInterpreter
 * } from './interpreters/index.js';
 *
 * // Process a message
 * const [newState, effects] = roomInterpreter(state, message);
 *
 * // Runtime executes effects
 * for (const effect of effects) {
 *   await executeEffect(effect);
 * }
 * ```
 */

// ============================================================================
// CORE TYPES
// ============================================================================

export {
  // Interpreter type
  type Interpreter,
  type InterpreterResult,
  toResult,

  // Helper functions
  noChange,
  withEffects,
  stateOnly,
  stateAndEffects,
  combineEffects,

  // Message types
  type Message,
  type RequestMessage,
  type ResponseMessage,
  type InitMessage,
  type ShutdownMessage,
  type ResetMessage,
  type TickMessage,

  // Composition
  composeInterpreters,
  withMiddleware,
  withLogging,

  // Error handling
  type InterpreterError,
  interpreterError,
  withErrorBoundary
} from './types.js';

// ============================================================================
// ROOM INTERPRETER
// ============================================================================

export {
  // Interpreter
  roomInterpreter,
  createRoomInterpreterState,

  // Message types
  type RoomMessage,
  type UserMessageMsg,
  type AgentResponseMsg,
  type AgentJoinedMsg,
  type AgentLeftMsg,
  type AgentTypingMsg,
  type ClearMessagesMsg,
  type ResetRoomMsg,
  type MessagesLoadedMsg,
  type RoomTickMsg,
  type RequestResponsesMsg,

  // Message constructors
  userMessage,
  agentResponse,
  agentJoinedMsg,
  agentLeftMsg,
  agentTypingMsg,
  clearMessagesMsg,
  resetRoomMsg,
  messagesLoaded,
  roomTick,
  requestResponses,

  // Agent message
  type RespondToMessageMsg,
  respondToMessage
} from './room.js';

// ============================================================================
// AGENT INTERPRETER
// ============================================================================

export {
  // Interpreter
  agentInterpreter,
  createAgentInterpreterState,

  // State types
  type AgentInterpreterState,

  // Message types
  type AgentMessage,
  type ApiResponseMsg,
  type ToolResultMsg,
  type ApiErrorMsg,
  type JoinRoomMsg,
  type LeaveRoomMsg,
  type SetStatusMsg,
  type StartTaskMsg,
  type CompleteTaskMsg,
  type ResetAgentMsg,

  // Message constructors
  apiResponse,
  toolResult,
  apiError,
  joinRoom,
  leaveRoom,
  setStatus,
  startTask,
  completeTask,
  resetAgent
} from './agent.js';

// ============================================================================
// PROJECT INTERPRETER
// ============================================================================

export {
  // Interpreter
  projectInterpreter,

  // Message types
  type ProjectMessage,
  type StartProjectMsg,
  type AddTaskMsg,
  type AssignTaskMsg,
  type TaskStartedMsg,
  type TaskCompletedMsg,
  type TaskFailedMsg,
  type SetPhaseMsg,
  type ProjectTickMsg,
  type AgentTurnCompleteMsg,
  type CancelProjectMsg,
  type ResetProjectMsg,
  type PlanningCompleteMsg,

  // Message constructors
  startProject,
  addTask,
  assignTaskMsg,
  taskStarted,
  taskCompleted,
  taskFailed,
  setPhase,
  projectTick,
  agentTurnComplete,
  cancelProject,
  resetProject,
  planningComplete,

  // Agent message
  type WorkOnTaskMsg,
  workOnTask
} from './project.js';

// ============================================================================
// DIRECTOR INTERPRETER
// ============================================================================

export {
  // Interpreter
  directorInterpreter,
  createDirectorState,

  // State types
  type DirectorState,
  type ProjectInfo,

  // Message types
  type DirectorMessage,
  type InitDirectorMsg,
  type CreateRoomMsg,
  type DeleteRoomMsg,
  type RegisterAgentMsg,
  type UnregisterAgentMsg,
  type MoveAgentToRoomMsg,
  type RemoveAgentFromRoomMsg,
  type StartNewProjectMsg,
  type StopProjectMsg,
  type AgentsLoadedMsg,
  type RoomsLoadedMsg,
  type GetStatusMsg,

  // Message constructors
  initDirector,
  createRoom,
  deleteRoom,
  registerAgent,
  unregisterAgent,
  moveAgentToRoom,
  removeAgentFromRoom,
  startNewProject,
  stopProject,
  agentsLoaded,
  roomsLoaded,
  getStatus,

  // Queries
  getRoomCount,
  getAgentCount,
  getActiveProjectCount,
  getAgentsInRoom,
  getStatusSummary
} from './director.js';
