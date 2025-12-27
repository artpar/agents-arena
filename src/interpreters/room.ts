/**
 * Room Interpreter
 *
 * Pure function that handles room messages and returns new state + effects.
 *
 * (RoomState, RoomMessage) → [RoomState, Effect[]]
 *
 * NO side effects. NO I/O. Just logic.
 */

import { Effect } from '../effects/index.js';
import {
  dbSaveMessage,
  dbDeleteMessages
} from '../effects/database.js';
import {
  broadcastToRoom,
  broadcastToAll,
  messageAdded,
  agentJoined,
  agentLeft,
  agentTyping,
  systemNotification
} from '../effects/broadcast.js';
import {
  sendToAgent,
  ActorMessage
} from '../effects/actor.js';
import {
  RoomState,
  RoomConfig,
  createRoomState,
  withAgentJoined,
  withAgentLeft,
  withMessage,
  withUserMessage,
  withAgentResponded,
  withPhase,
  withLoadedMessages,
  resetRoom,
  clearMessages,
  selectResponders
} from '../values/room.js';
import {
  ChatMessage,
  createChatMessage
} from '../values/message.js';
import { AgentId, RoomId, senderId } from '../values/ids.js';
import {
  Interpreter,
  noChange,
  stateOnly,
  stateAndEffects
} from './types.js';

// ============================================================================
// ROOM MESSAGES
// ============================================================================

/**
 * User sent a message to the room.
 */
export interface UserMessageMsg {
  readonly type: 'USER_MESSAGE';
  readonly message: ChatMessage;
  readonly mentionedAgents: readonly AgentId[];
}

/**
 * Agent sent a response.
 */
export interface AgentResponseMsg {
  readonly type: 'AGENT_RESPONSE';
  readonly agentId: AgentId;
  readonly message: ChatMessage;
}

/**
 * Agent joined the room.
 */
export interface AgentJoinedMsg {
  readonly type: 'AGENT_JOINED';
  readonly agentId: AgentId;
  readonly agentName: string;
}

/**
 * Agent left the room.
 */
export interface AgentLeftMsg {
  readonly type: 'AGENT_LEFT';
  readonly agentId: AgentId;
  readonly agentName: string;
}

/**
 * Agent is typing/thinking.
 */
export interface AgentTypingMsg {
  readonly type: 'AGENT_TYPING';
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly isTyping: boolean;
}

/**
 * Request to clear room messages.
 */
export interface ClearMessagesMsg {
  readonly type: 'CLEAR_MESSAGES';
}

/**
 * Reset room state.
 */
export interface ResetRoomMsg {
  readonly type: 'RESET_ROOM';
}

/**
 * Messages loaded from persistence.
 */
export interface MessagesLoadedMsg {
  readonly type: 'MESSAGES_LOADED';
  readonly messages: readonly ChatMessage[];
}

/**
 * Tick for periodic checks.
 */
export interface RoomTickMsg {
  readonly type: 'ROOM_TICK';
  readonly timestamp: number;
}

/**
 * Request agents to respond.
 */
export interface RequestResponsesMsg {
  readonly type: 'REQUEST_RESPONSES';
  readonly contextMessage: ChatMessage;
  readonly responders: readonly AgentId[];
}

/**
 * Union of all room messages.
 */
export type RoomMessage =
  | UserMessageMsg
  | AgentResponseMsg
  | AgentJoinedMsg
  | AgentLeftMsg
  | AgentTypingMsg
  | ClearMessagesMsg
  | ResetRoomMsg
  | MessagesLoadedMsg
  | RoomTickMsg
  | RequestResponsesMsg;

// ============================================================================
// MESSAGE CONSTRUCTORS
// ============================================================================

export function userMessage(
  message: ChatMessage,
  mentionedAgents: readonly AgentId[] = []
): UserMessageMsg {
  return Object.freeze({ type: 'USER_MESSAGE', message, mentionedAgents });
}

export function agentResponse(
  agentId: AgentId,
  message: ChatMessage
): AgentResponseMsg {
  return Object.freeze({ type: 'AGENT_RESPONSE', agentId, message });
}

export function agentJoinedMsg(agentId: AgentId, agentName: string): AgentJoinedMsg {
  return Object.freeze({ type: 'AGENT_JOINED', agentId, agentName });
}

export function agentLeftMsg(agentId: AgentId, agentName: string): AgentLeftMsg {
  return Object.freeze({ type: 'AGENT_LEFT', agentId, agentName });
}

export function agentTypingMsg(
  agentId: AgentId,
  agentName: string,
  isTyping: boolean
): AgentTypingMsg {
  return Object.freeze({ type: 'AGENT_TYPING', agentId, agentName, isTyping });
}

export function clearMessagesMsg(): ClearMessagesMsg {
  return Object.freeze({ type: 'CLEAR_MESSAGES' });
}

export function resetRoomMsg(): ResetRoomMsg {
  return Object.freeze({ type: 'RESET_ROOM' });
}

export function messagesLoaded(messages: readonly ChatMessage[]): MessagesLoadedMsg {
  return Object.freeze({ type: 'MESSAGES_LOADED', messages });
}

export function roomTick(timestamp: number): RoomTickMsg {
  return Object.freeze({ type: 'ROOM_TICK', timestamp });
}

export function requestResponses(
  contextMessage: ChatMessage,
  responders: readonly AgentId[]
): RequestResponsesMsg {
  return Object.freeze({ type: 'REQUEST_RESPONSES', contextMessage, responders });
}

// ============================================================================
// AGENT MESSAGE (What we send to agents)
// ============================================================================

export interface RespondToMessageMsg extends ActorMessage {
  readonly type: 'RESPOND_TO_MESSAGE';
  readonly roomId: RoomId;
  readonly contextMessages: readonly ChatMessage[];
  readonly triggerMessage: ChatMessage;
}

export function respondToMessage(
  roomId: RoomId,
  contextMessages: readonly ChatMessage[],
  triggerMessage: ChatMessage
): RespondToMessageMsg {
  return Object.freeze({
    type: 'RESPOND_TO_MESSAGE',
    roomId,
    contextMessages,
    triggerMessage
  });
}

// ============================================================================
// ROOM INTERPRETER
// ============================================================================

/**
 * Pure room interpreter.
 *
 * Takes current room state and a message, returns new state and effects.
 */
export const roomInterpreter: Interpreter<RoomState, RoomMessage> = (
  state: RoomState,
  message: RoomMessage
): readonly [RoomState, readonly Effect[]] => {
  switch (message.type) {
    case 'USER_MESSAGE':
      return handleUserMessage(state, message);

    case 'AGENT_RESPONSE':
      return handleAgentResponse(state, message);

    case 'AGENT_JOINED':
      return handleAgentJoined(state, message);

    case 'AGENT_LEFT':
      return handleAgentLeft(state, message);

    case 'AGENT_TYPING':
      return handleAgentTyping(state, message);

    case 'CLEAR_MESSAGES':
      return handleClearMessages(state);

    case 'RESET_ROOM':
      return handleResetRoom(state);

    case 'MESSAGES_LOADED':
      return handleMessagesLoaded(state, message);

    case 'ROOM_TICK':
      return handleRoomTick(state, message);

    case 'REQUEST_RESPONSES':
      return handleRequestResponses(state, message);

    default:
      // Exhaustive check
      const _exhaustive: never = message;
      return noChange(state);
  }
};

// ============================================================================
// MESSAGE HANDLERS (Pure functions)
// ============================================================================

function handleUserMessage(
  state: RoomState,
  msg: UserMessageMsg
): readonly [RoomState, readonly Effect[]] {
  // Defensive checks
  if (!state || !state.config) {
    console.error('[ROOM] handleUserMessage: state or state.config is undefined');
    return [state, []];
  }
  if (!msg || !msg.message) {
    console.error('[ROOM] handleUserMessage: msg or msg.message is undefined');
    return [state, []];
  }

  const roomId = state.config.id;

  // Select which agents should respond
  const responders = selectResponders(
    state,
    msg.mentionedAgents ?? [],
    null // User is not an agent
  );

  // Update state with message and set pending responders
  const newState = withUserMessage(state, msg.message, responders ?? []);

  // Effects: save to DB, broadcast to clients
  const effects: Effect[] = [
    dbSaveMessage(msg.message),
    broadcastToRoom(roomId, messageAdded(roomId, msg.message))
  ];

  // Send respond requests to agents
  for (const agentId of responders) {
    effects.push(
      sendToAgent(agentId, respondToMessage(
        roomId,
        newState.messages,
        msg.message
      ))
    );
  }

  return [newState, Object.freeze(effects)];
}

function handleAgentResponse(
  state: RoomState,
  msg: AgentResponseMsg
): readonly [RoomState, readonly Effect[]] {
  const roomId = state.config.id;

  // Update state: add message, remove from pending
  const newState = withAgentResponded(state, msg.agentId, msg.message);

  // Effects: save to DB, broadcast
  const effects: Effect[] = [
    dbSaveMessage(msg.message),
    broadcastToRoom(roomId, messageAdded(roomId, msg.message))
  ];

  return [newState, Object.freeze(effects)];
}

function handleAgentJoined(
  state: RoomState,
  msg: AgentJoinedMsg
): readonly [RoomState, readonly Effect[]] {
  const roomId = state.config.id;

  // Update state
  const newState = withAgentJoined(state, msg.agentId);

  // Create join message
  const joinMessage = createChatMessage({
    roomId,
    senderId: senderId('system'),
    senderName: 'system',
    content: `${msg.agentName} has joined the room`,
    type: 'join'
  });

  // Effects: broadcast join event, add join message
  const effects: Effect[] = [
    broadcastToRoom(roomId, agentJoined(roomId, msg.agentId, msg.agentName)),
    broadcastToRoom(roomId, messageAdded(roomId, joinMessage))
  ];

  return [withMessage(newState, joinMessage), Object.freeze(effects)];
}

function handleAgentLeft(
  state: RoomState,
  msg: AgentLeftMsg
): readonly [RoomState, readonly Effect[]] {
  const roomId = state.config.id;

  // Update state
  const newState = withAgentLeft(state, msg.agentId);

  // Create leave message
  const leaveMessage = createChatMessage({
    roomId,
    senderId: senderId('system'),
    senderName: 'system',
    content: `${msg.agentName} has left the room`,
    type: 'leave'
  });

  // Effects: broadcast leave event
  const effects: Effect[] = [
    broadcastToRoom(roomId, agentLeft(roomId, msg.agentId, msg.agentName)),
    broadcastToRoom(roomId, messageAdded(roomId, leaveMessage))
  ];

  return [withMessage(newState, leaveMessage), Object.freeze(effects)];
}

function handleAgentTyping(
  state: RoomState,
  msg: AgentTypingMsg
): readonly [RoomState, readonly Effect[]] {
  const roomId = state.config.id;

  // No state change for typing - just broadcast
  const effects: Effect[] = [
    broadcastToRoom(roomId, agentTyping(msg.agentId, msg.agentName, msg.isTyping))
  ];

  return [state, Object.freeze(effects)];
}

function handleClearMessages(
  state: RoomState
): readonly [RoomState, readonly Effect[]] {
  const roomId = state.config.id;
  const newState = clearMessages(state);

  const effects: Effect[] = [
    dbDeleteMessages(roomId),
    broadcastToRoom(roomId, systemNotification('Messages cleared', 'info'))
  ];

  return [newState, Object.freeze(effects)];
}

function handleResetRoom(
  state: RoomState
): readonly [RoomState, readonly Effect[]] {
  const roomId = state.config.id;
  const newState = resetRoom(state);

  const effects: Effect[] = [
    dbDeleteMessages(roomId),
    broadcastToRoom(roomId, systemNotification('Room reset', 'info'))
  ];

  return [newState, Object.freeze(effects)];
}

function handleMessagesLoaded(
  state: RoomState,
  msg: MessagesLoadedMsg
): readonly [RoomState, readonly Effect[]] {
  // Just update state, no side effects needed
  const newState = withLoadedMessages(state, msg.messages);
  return stateOnly(newState);
}

function handleRoomTick(
  state: RoomState,
  _msg: RoomTickMsg
): readonly [RoomState, readonly Effect[]] {
  // Periodic tick - could check for timeouts, stale state, etc.
  // For now, just return unchanged state
  return noChange(state);
}

function handleRequestResponses(
  state: RoomState,
  msg: RequestResponsesMsg
): readonly [RoomState, readonly Effect[]] {
  const roomId = state.config.id;

  // Update state to set pending responders
  const newState: RoomState = Object.freeze({
    ...state,
    phase: msg.responders.length > 0 ? 'processing' : 'active',
    pendingResponders: Object.freeze([...msg.responders])
  });

  // Send respond requests to each agent
  const effects: Effect[] = msg.responders.map(agentId =>
    sendToAgent(agentId, respondToMessage(
      roomId,
      state.messages,
      msg.contextMessage
    ))
  );

  return [newState, Object.freeze(effects)];
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create initial room state from config.
 */
export function createRoomInterpreterState(config: RoomConfig): RoomState {
  return createRoomState(config);
}

export default roomInterpreter;
