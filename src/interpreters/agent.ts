/**
 * Agent Interpreter
 *
 * Pure function that handles agent messages and returns new state + effects.
 *
 * (AgentState, AgentMessage) → [AgentState, Effect[]]
 *
 * NO side effects. NO I/O. Just logic.
 */

import { Effect } from '../effects/index.js';
import {
  callAnthropic,
  createAnthropicRequest,
  AnthropicResponse,
  ApiMessage,
  extractText,
  extractToolUses,
  requiresToolExecution,
  isFinalResponse,
  buildToolResults,
  buildToolResultMessage,
  buildAssistantMessage,
  ResponseContentBlock
} from '../effects/anthropic.js';
import {
  executeTool,
  executeToolsBatch,
  ToolResult,
  createToolContext
} from '../effects/tools.js';
import {
  broadcastToRoom,
  agentTyping,
  agentStatus as agentStatusEvent,
  buildProgress
} from '../effects/broadcast.js';
import {
  dbLogEvent
} from '../effects/database.js';
import {
  sendToRoom,
  ActorMessage
} from '../effects/actor.js';
import {
  dbUpdateAgentStats
} from '../effects/database.js';
import {
  AgentState,
  AgentConfig,
  AgentStatus,
  createAgentState,
  withStatus,
  withRoom,
  withTask,
  withConversationTurn,
  withConversationHistory,
  clearConversation,
  incrementToolCalls,
  resetToolCalls,
  withArtifact,
  markSpoke,
  resetForNewTask,
  resolveModel
} from '../values/agent.js';
import {
  ChatMessage,
  ConversationTurn,
  createChatMessage,
  toConversationTurns
} from '../values/message.js';
import { RoomId, senderId, AgentId } from '../values/ids.js';
import { agentResponse, RespondToMessageMsg } from './room.js';
import {
  Interpreter,
  noChange,
  stateOnly,
  stateAndEffects
} from './types.js';

// ============================================================================
// AGENT MESSAGES
// ============================================================================

/**
 * Request to respond to a message.
 */
export type { RespondToMessageMsg };

/**
 * API response received.
 */
export interface ApiResponseMsg {
  readonly type: 'API_RESPONSE';
  readonly response: AnthropicResponse;
  readonly roomId: RoomId;
  readonly replyTag: string;
}

/**
 * Tool execution completed.
 */
export interface ToolResultMsg {
  readonly type: 'TOOL_RESULT';
  readonly results: readonly ToolResult[];
  readonly roomId: RoomId;
  readonly replyTag: string;
}

/**
 * API call failed.
 */
export interface ApiErrorMsg {
  readonly type: 'API_ERROR';
  readonly error: string;
  readonly roomId: RoomId;
  readonly replyTag: string;
}

/**
 * Join a room.
 */
export interface JoinRoomMsg {
  readonly type: 'JOIN_ROOM';
  readonly roomId: RoomId;
}

/**
 * Leave current room.
 */
export interface LeaveRoomMsg {
  readonly type: 'LEAVE_ROOM';
}

/**
 * Set agent status.
 */
export interface SetStatusMsg {
  readonly type: 'SET_STATUS';
  readonly status: AgentStatus;
}

/**
 * Start a task.
 */
export interface StartTaskMsg {
  readonly type: 'START_TASK';
  readonly taskId: string;
  readonly roomId: RoomId;
}

/**
 * Complete current task.
 */
export interface CompleteTaskMsg {
  readonly type: 'COMPLETE_TASK';
}

/**
 * Reset agent for new conversation.
 */
export interface ResetAgentMsg {
  readonly type: 'RESET_AGENT';
}

/**
 * Union of all agent messages.
 */
export type AgentMessage =
  | RespondToMessageMsg
  | ApiResponseMsg
  | ToolResultMsg
  | ApiErrorMsg
  | JoinRoomMsg
  | LeaveRoomMsg
  | SetStatusMsg
  | StartTaskMsg
  | CompleteTaskMsg
  | ResetAgentMsg;

// ============================================================================
// MESSAGE CONSTRUCTORS
// ============================================================================

export function apiResponse(
  response: AnthropicResponse,
  roomId: RoomId,
  replyTag: string
): ApiResponseMsg {
  return Object.freeze({ type: 'API_RESPONSE', response, roomId, replyTag });
}

export function toolResult(
  results: readonly ToolResult[],
  roomId: RoomId,
  replyTag: string
): ToolResultMsg {
  return Object.freeze({ type: 'TOOL_RESULT', results, roomId, replyTag });
}

export function apiError(
  error: string,
  roomId: RoomId,
  replyTag: string
): ApiErrorMsg {
  return Object.freeze({ type: 'API_ERROR', error, roomId, replyTag });
}

export function joinRoom(roomId: RoomId): JoinRoomMsg {
  return Object.freeze({ type: 'JOIN_ROOM', roomId });
}

export function leaveRoom(): LeaveRoomMsg {
  return Object.freeze({ type: 'LEAVE_ROOM' });
}

export function setStatus(status: AgentStatus): SetStatusMsg {
  return Object.freeze({ type: 'SET_STATUS', status });
}

export function startTask(taskId: string, roomId: RoomId): StartTaskMsg {
  return Object.freeze({ type: 'START_TASK', taskId, roomId });
}

export function completeTask(): CompleteTaskMsg {
  return Object.freeze({ type: 'COMPLETE_TASK' });
}

export function resetAgent(): ResetAgentMsg {
  return Object.freeze({ type: 'RESET_AGENT' });
}

// ============================================================================
// INTERPRETER STATE EXTENSIONS
// ============================================================================

/**
 * Extended agent state for interpreter (includes pending API call info).
 */
export interface AgentInterpreterState extends AgentState {
  readonly pendingApiCall: {
    readonly roomId: RoomId;
    readonly replyTag: string;
    readonly messages: readonly ApiMessage[];
  } | null;
  readonly maxToolCalls: number;
  readonly workspacePath: string;
  readonly sharedWorkspacePath: string;
}

/**
 * Create initial interpreter state from config.
 */
export function createAgentInterpreterState(
  config: AgentConfig,
  workspacePath: string,
  sharedWorkspacePath: string,
  maxToolCalls: number = 50
): AgentInterpreterState {
  const baseState = createAgentState(config);
  return Object.freeze({
    ...baseState,
    pendingApiCall: null,
    maxToolCalls,
    workspacePath,
    sharedWorkspacePath
  });
}

// ============================================================================
// AGENT INTERPRETER
// ============================================================================

/**
 * Pure agent interpreter.
 *
 * Takes current agent state and a message, returns new state and effects.
 */
export const agentInterpreter: Interpreter<AgentInterpreterState, AgentMessage> = (
  state: AgentInterpreterState,
  message: AgentMessage
): readonly [AgentInterpreterState, readonly Effect[]] => {
  switch (message.type) {
    case 'RESPOND_TO_MESSAGE':
      return handleRespondToMessage(state, message);

    case 'API_RESPONSE':
      return handleApiResponse(state, message);

    case 'TOOL_RESULT':
      return handleToolResult(state, message);

    case 'API_ERROR':
      return handleApiError(state, message);

    case 'JOIN_ROOM':
      return handleJoinRoom(state, message);

    case 'LEAVE_ROOM':
      return handleLeaveRoom(state);

    case 'SET_STATUS':
      return handleSetStatus(state, message);

    case 'START_TASK':
      return handleStartTask(state, message);

    case 'COMPLETE_TASK':
      return handleCompleteTask(state);

    case 'RESET_AGENT':
      return handleResetAgent(state);

    default:
      const _exhaustive: never = message;
      return noChange(state);
  }
};

// ============================================================================
// MESSAGE HANDLERS (Pure functions)
// ============================================================================

function handleRespondToMessage(
  state: AgentInterpreterState,
  msg: RespondToMessageMsg
): readonly [AgentInterpreterState, readonly Effect[]] {
  const { roomId, contextMessages, triggerMessage } = msg;
  const agentId = state.config.id;
  const agentName = state.config.name;

  // Build conversation history for API
  const turns = toConversationTurns(contextMessages, agentId);
  let apiMessages = turnsToApiMessages(turns);

  // Anthropic API requires conversation to end with 'user' message
  // If the last message is from this agent (assistant), add a continuation prompt
  if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'assistant') {
    apiMessages = Object.freeze([
      ...apiMessages,
      Object.freeze({
        role: 'user' as const,
        content: '[System: Please continue the conversation naturally based on the context above. You may share your thoughts, ask questions, or respond to the ongoing discussion.]'
      })
    ]);
  }

  // If no messages at all, create a starter prompt
  if (apiMessages.length === 0) {
    apiMessages = Object.freeze([
      Object.freeze({
        role: 'user' as const,
        content: '[System: Start or join the conversation. Share your thoughts on the topic at hand.]'
      })
    ]);
  }

  // Create API request
  const replyTag = `api_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const request = createAnthropicRequest({
    model: resolveModel(state.config.model),
    messages: apiMessages,
    system: state.config.systemPrompt,
    temperature: state.config.temperature,
    maxTokens: 4096
  });

  // Update state: set to thinking, store pending call
  const newState: AgentInterpreterState = Object.freeze({
    ...withStatus(state, 'thinking'),
    pendingApiCall: Object.freeze({
      roomId,
      replyTag,
      messages: apiMessages
    })
  });

  // Effects: broadcast typing, call API
  const effects: Effect[] = [
    broadcastToRoom(roomId, agentTyping(agentId, agentName, true)),
    broadcastToRoom(roomId, agentStatusEvent(agentId, agentName, 'thinking')),
    callAnthropic(agentId, request, replyTag)
  ];

  return [newState, Object.freeze(effects)];
}

function handleApiResponse(
  state: AgentInterpreterState,
  msg: ApiResponseMsg
): readonly [AgentInterpreterState, readonly Effect[]] {
  const { response, roomId } = msg;
  const agentId = state.config.id;
  const agentName = state.config.name;

  if (!state.pendingApiCall) {
    return noChange(state);
  }

  // Check if response has tool calls
  if (requiresToolExecution(response)) {
    return handleToolCallsNeeded(state, response, roomId);
  }

  // Final response - extract text and send to room
  const text = extractText(response);

  if (text.trim()) {
    // Create chat message
    const chatMessage = createChatMessage({
      roomId,
      senderId: senderId(agentId),
      senderName: agentName,
      content: text
    });

    // Update state: back to idle, clear pending, mark spoke
    const newState: AgentInterpreterState = Object.freeze({
      ...markSpoke(withStatus(state, 'idle')),
      pendingApiCall: null,
      toolCallCount: 0
    });

    // Effects: broadcast done typing, send response to room
    const effects: Effect[] = [
      broadcastToRoom(roomId, agentTyping(agentId, agentName, false)),
      broadcastToRoom(roomId, agentStatusEvent(agentId, agentName, 'idle')),
      sendToRoom(roomId, agentResponse(agentId, chatMessage)),
      dbUpdateAgentStats(agentId, newState.messageCount, newState.lastSpokeAt ?? Date.now())
    ];

    return [newState, Object.freeze(effects)];
  }

  // Empty response - just go back to idle
  const newState: AgentInterpreterState = Object.freeze({
    ...withStatus(state, 'idle'),
    pendingApiCall: null
  });

  const effects: Effect[] = [
    broadcastToRoom(roomId, agentTyping(agentId, agentName, false)),
    broadcastToRoom(roomId, agentStatusEvent(agentId, agentName, 'idle'))
  ];

  return [newState, Object.freeze(effects)];
}

function handleToolCallsNeeded(
  state: AgentInterpreterState,
  response: AnthropicResponse,
  roomId: RoomId
): readonly [AgentInterpreterState, readonly Effect[]] {
  const agentId = state.config.id;
  const agentName = state.config.name;
  const toolUses = extractToolUses(response);

  if (toolUses.length === 0) {
    return noChange(state);
  }

  // Check if we've exceeded max tool calls
  if (state.toolCallCount >= state.maxToolCalls) {
    return handleMaxToolCallsExceeded(state, roomId);
  }

  // Update state: set to building, increment tool count
  const newToolCount = state.toolCallCount + toolUses.length;
  const newState: AgentInterpreterState = Object.freeze({
    ...withStatus(state, 'building'),
    toolCallCount: newToolCount,
    pendingApiCall: state.pendingApiCall ? Object.freeze({
      ...state.pendingApiCall,
      messages: Object.freeze([
        ...state.pendingApiCall.messages,
        buildAssistantMessage(response.content)
      ])
    }) : null
  });

  // Create tool context
  const context = createToolContext({
    agentId,
    agentName,
    workspacePath: state.workspacePath,
    sharedWorkspacePath: state.sharedWorkspacePath
  });

  // Create tool execution effects
  const replyTag = `tools_${Date.now()}`;
  const toolEffects = toolUses.map(tool =>
    executeTool(tool.id, tool.name, tool.input, context, replyTag)
  );

  // Log tool_use events to database
  const toolUseLogEffects = toolUses.map(tool =>
    dbLogEvent('tool_use', {
      agent_id: agentId,
      agent_name: agentName,
      tool_name: tool.name,
      tool_use_id: tool.id,
      tool_input: tool.input,
      room_id: roomId
    })
  );

  // Effects: broadcast status, log tool events to DB, execute tools
  const effects: Effect[] = [
    broadcastToRoom(roomId, agentStatusEvent(agentId, agentName, 'building')),
    broadcastToRoom(roomId, buildProgress(
      agentId,
      agentName,
      newToolCount,
      state.maxToolCalls,
      toolUses[0]?.name ?? 'unknown'
    )),
    ...toolUseLogEffects,
    ...toolEffects
  ];

  return [newState, Object.freeze(effects)];
}

function handleMaxToolCallsExceeded(
  state: AgentInterpreterState,
  roomId: RoomId
): readonly [AgentInterpreterState, readonly Effect[]] {
  const agentId = state.config.id;
  const agentName = state.config.name;

  // Create error message
  const errorMessage = createChatMessage({
    roomId,
    senderId: senderId(agentId),
    senderName: agentName,
    content: `[Reached maximum tool call limit of ${state.maxToolCalls}. Stopping execution.]`,
    type: 'system'
  });

  // Update state
  const newState: AgentInterpreterState = Object.freeze({
    ...withStatus(state, 'idle'),
    pendingApiCall: null,
    toolCallCount: 0
  });

  // Effects
  const effects: Effect[] = [
    broadcastToRoom(roomId, agentTyping(agentId, agentName, false)),
    broadcastToRoom(roomId, agentStatusEvent(agentId, agentName, 'idle')),
    sendToRoom(roomId, agentResponse(agentId, errorMessage))
  ];

  return [newState, Object.freeze(effects)];
}

function handleToolResult(
  state: AgentInterpreterState,
  msg: ToolResultMsg
): readonly [AgentInterpreterState, readonly Effect[]] {
  const { results, roomId } = msg;
  const agentId = state.config.id;
  const agentName = state.config.name;

  if (!state.pendingApiCall) {
    return noChange(state);
  }

  // Build tool result message
  const toolResults = buildToolResults(
    results.map(r => ({
      toolUseId: r.toolUseId,
      result: r.result,
      isError: r.isError
    }))
  );

  const toolResultMessage = buildToolResultMessage(toolResults);

  // Log tool_result events to database
  const toolResultLogEffects = results.map(r =>
    dbLogEvent('tool_result', {
      agent_id: agentId,
      agent_name: agentName,
      tool_name: r.toolName,
      tool_use_id: r.toolUseId,
      result_length: r.result.length,
      is_error: r.isError,
      room_id: roomId
    })
  );

  // Add any artifacts
  let newArtifacts = state.artifacts;
  for (const result of results) {
    if (result.artifacts) {
      newArtifacts = Object.freeze([...newArtifacts, ...result.artifacts]);
    }
  }

  // Update messages and call API again
  const newMessages = Object.freeze([
    ...state.pendingApiCall.messages,
    toolResultMessage
  ]);

  const replyTag = `api_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const request = createAnthropicRequest({
    model: resolveModel(state.config.model),
    messages: newMessages,
    system: state.config.systemPrompt,
    temperature: state.config.temperature,
    maxTokens: 4096
  });

  // Update state
  const newState: AgentInterpreterState = Object.freeze({
    ...state,
    artifacts: newArtifacts,
    pendingApiCall: Object.freeze({
      ...state.pendingApiCall,
      messages: newMessages,
      replyTag
    })
  });

  // Continue the API conversation with tool result logging
  const effects: Effect[] = [
    ...toolResultLogEffects,
    callAnthropic(state.config.id, request, replyTag)
  ];

  return [newState, Object.freeze(effects)];
}

function handleApiError(
  state: AgentInterpreterState,
  msg: ApiErrorMsg
): readonly [AgentInterpreterState, readonly Effect[]] {
  const { error, roomId } = msg;
  const agentId = state.config.id;
  const agentName = state.config.name;

  // Create error message
  const errorMessage = createChatMessage({
    roomId,
    senderId: senderId(agentId),
    senderName: agentName,
    content: `[Error: ${error}]`,
    type: 'system'
  });

  // Update state
  const newState: AgentInterpreterState = Object.freeze({
    ...withStatus(state, 'idle'),
    pendingApiCall: null,
    toolCallCount: 0
  });

  // Effects
  const effects: Effect[] = [
    broadcastToRoom(roomId, agentTyping(agentId, agentName, false)),
    broadcastToRoom(roomId, agentStatusEvent(agentId, agentName, 'idle')),
    sendToRoom(roomId, agentResponse(agentId, errorMessage))
  ];

  return [newState, Object.freeze(effects)];
}

function handleJoinRoom(
  state: AgentInterpreterState,
  msg: JoinRoomMsg
): readonly [AgentInterpreterState, readonly Effect[]] {
  const newState: AgentInterpreterState = Object.freeze({
    ...withRoom(state, msg.roomId),
    pendingApiCall: state.pendingApiCall,
    maxToolCalls: state.maxToolCalls,
    workspacePath: state.workspacePath,
    sharedWorkspacePath: state.sharedWorkspacePath
  });

  return stateOnly(newState);
}

function handleLeaveRoom(
  state: AgentInterpreterState
): readonly [AgentInterpreterState, readonly Effect[]] {
  const newState: AgentInterpreterState = Object.freeze({
    ...withRoom(state, null),
    pendingApiCall: null,
    maxToolCalls: state.maxToolCalls,
    workspacePath: state.workspacePath,
    sharedWorkspacePath: state.sharedWorkspacePath
  });

  return stateOnly(newState);
}

function handleSetStatus(
  state: AgentInterpreterState,
  msg: SetStatusMsg
): readonly [AgentInterpreterState, readonly Effect[]] {
  const newState: AgentInterpreterState = Object.freeze({
    ...withStatus(state, msg.status),
    pendingApiCall: state.pendingApiCall,
    maxToolCalls: state.maxToolCalls,
    workspacePath: state.workspacePath,
    sharedWorkspacePath: state.sharedWorkspacePath
  });

  const effects: Effect[] = state.currentRoomId ? [
    broadcastToRoom(
      state.currentRoomId,
      agentStatusEvent(state.config.id, state.config.name, msg.status)
    )
  ] : [];

  return [newState, Object.freeze(effects)];
}

function handleStartTask(
  state: AgentInterpreterState,
  msg: StartTaskMsg
): readonly [AgentInterpreterState, readonly Effect[]] {
  const newState: AgentInterpreterState = Object.freeze({
    ...withTask(withRoom(withStatus(state, 'building'), msg.roomId), msg.taskId),
    pendingApiCall: state.pendingApiCall,
    maxToolCalls: state.maxToolCalls,
    workspacePath: state.workspacePath,
    sharedWorkspacePath: state.sharedWorkspacePath
  });

  return stateOnly(newState);
}

function handleCompleteTask(
  state: AgentInterpreterState
): readonly [AgentInterpreterState, readonly Effect[]] {
  const newState: AgentInterpreterState = Object.freeze({
    ...resetForNewTask(state),
    pendingApiCall: null,
    maxToolCalls: state.maxToolCalls,
    workspacePath: state.workspacePath,
    sharedWorkspacePath: state.sharedWorkspacePath
  });

  return stateOnly(newState);
}

function handleResetAgent(
  state: AgentInterpreterState
): readonly [AgentInterpreterState, readonly Effect[]] {
  const newState: AgentInterpreterState = Object.freeze({
    ...resetForNewTask(withRoom(state, null)),
    pendingApiCall: null,
    maxToolCalls: state.maxToolCalls,
    workspacePath: state.workspacePath,
    sharedWorkspacePath: state.sharedWorkspacePath
  });

  return stateOnly(newState);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert conversation turns to API messages.
 */
function turnsToApiMessages(turns: readonly ConversationTurn[]): readonly ApiMessage[] {
  return Object.freeze(
    turns.map(turn => Object.freeze({
      role: turn.role,
      content: turn.content
    }))
  );
}

export default agentInterpreter;
