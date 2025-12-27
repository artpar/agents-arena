/**
 * Broadcast Effects
 *
 * Effects that describe WebSocket broadcasts to connected clients.
 * These are DATA describing what to do, not the execution.
 * The boundary executor will actually send WebSocket messages.
 */

import {
  RoomId,
  AgentId,
  ChatMessage,
  AgentStatus,
  ProjectPhase,
  Task
} from '../values/index.js';

// ============================================================================
// UI EVENT TYPES (What clients receive)
// ============================================================================

/**
 * New message added to room.
 */
export interface MessageAddedEvent {
  readonly type: 'message_added';
  readonly roomId: RoomId;
  readonly message: ChatMessage;
}

/**
 * Agent status changed.
 */
export interface AgentStatusEvent {
  readonly type: 'agent_status';
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly status: AgentStatus;
}

/**
 * Agent is typing/thinking.
 */
export interface AgentTypingEvent {
  readonly type: 'agent_typing';
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly isTyping: boolean;
}

/**
 * Agent joined room.
 */
export interface AgentJoinedEvent {
  readonly type: 'agent_joined';
  readonly roomId: RoomId;
  readonly agentId: AgentId;
  readonly agentName: string;
}

/**
 * Agent left room.
 */
export interface AgentLeftEvent {
  readonly type: 'agent_left';
  readonly roomId: RoomId;
  readonly agentId: AgentId;
  readonly agentName: string;
}

/**
 * Project phase changed.
 */
export interface PhaseChangedEvent {
  readonly type: 'phase_changed';
  readonly projectId: string;
  readonly phase: ProjectPhase;
}

/**
 * Task updated.
 */
export interface TaskUpdatedEvent {
  readonly type: 'task_updated';
  readonly projectId: string;
  readonly task: Task;
}

/**
 * Build progress update.
 */
export interface BuildProgressEvent {
  readonly type: 'build_progress';
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly toolCallCount: number;
  readonly maxToolCalls: number;
  readonly lastTool: string;
}

/**
 * Artifact created.
 */
export interface ArtifactCreatedEvent {
  readonly type: 'artifact_created';
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly path: string;
}

/**
 * Error occurred.
 */
export interface ErrorEvent {
  readonly type: 'error';
  readonly message: string;
  readonly code?: string;
}

/**
 * System notification.
 */
export interface SystemNotificationEvent {
  readonly type: 'system_notification';
  readonly message: string;
  readonly level: 'info' | 'warning' | 'error';
}

/**
 * Union of all UI events.
 * Note: Tool events (tool_use, tool_result) are stored in database, not broadcast.
 * The UI fetches them via the /messages endpoint.
 */
export type UIEvent =
  | MessageAddedEvent
  | AgentStatusEvent
  | AgentTypingEvent
  | AgentJoinedEvent
  | AgentLeftEvent
  | PhaseChangedEvent
  | TaskUpdatedEvent
  | BuildProgressEvent
  | ArtifactCreatedEvent
  | ErrorEvent
  | SystemNotificationEvent;

// ============================================================================
// EVENT CONSTRUCTORS
// ============================================================================

export function messageAdded(roomId: RoomId, message: ChatMessage): MessageAddedEvent {
  return Object.freeze({ type: 'message_added', roomId, message });
}

export function agentStatus(
  agentId: AgentId,
  agentName: string,
  status: AgentStatus
): AgentStatusEvent {
  return Object.freeze({ type: 'agent_status', agentId, agentName, status });
}

export function agentTyping(
  agentId: AgentId,
  agentName: string,
  isTyping: boolean
): AgentTypingEvent {
  return Object.freeze({ type: 'agent_typing', agentId, agentName, isTyping });
}

export function agentJoined(
  roomId: RoomId,
  agentId: AgentId,
  agentName: string
): AgentJoinedEvent {
  return Object.freeze({ type: 'agent_joined', roomId, agentId, agentName });
}

export function agentLeft(
  roomId: RoomId,
  agentId: AgentId,
  agentName: string
): AgentLeftEvent {
  return Object.freeze({ type: 'agent_left', roomId, agentId, agentName });
}

export function phaseChanged(projectId: string, phase: ProjectPhase): PhaseChangedEvent {
  return Object.freeze({ type: 'phase_changed', projectId, phase });
}

export function taskUpdated(projectId: string, task: Task): TaskUpdatedEvent {
  return Object.freeze({ type: 'task_updated', projectId, task });
}

export function buildProgress(
  agentId: AgentId,
  agentName: string,
  toolCallCount: number,
  maxToolCalls: number,
  lastTool: string
): BuildProgressEvent {
  return Object.freeze({
    type: 'build_progress',
    agentId,
    agentName,
    toolCallCount,
    maxToolCalls,
    lastTool
  });
}

export function artifactCreated(
  agentId: AgentId,
  agentName: string,
  path: string
): ArtifactCreatedEvent {
  return Object.freeze({ type: 'artifact_created', agentId, agentName, path });
}

export function errorEvent(message: string, code?: string): ErrorEvent {
  return Object.freeze({ type: 'error', message, code });
}

export function systemNotification(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info'
): SystemNotificationEvent {
  return Object.freeze({ type: 'system_notification', message, level });
}

// ============================================================================
// BROADCAST EFFECTS
// ============================================================================

/**
 * Broadcast to all clients in a room.
 */
export interface BroadcastToRoom {
  readonly type: 'BROADCAST_TO_ROOM';
  readonly roomId: RoomId;
  readonly event: UIEvent;
}

export function broadcastToRoom(roomId: RoomId, event: UIEvent): BroadcastToRoom {
  return Object.freeze({ type: 'BROADCAST_TO_ROOM', roomId, event });
}

/**
 * Broadcast to all connected clients.
 */
export interface BroadcastToAll {
  readonly type: 'BROADCAST_TO_ALL';
  readonly event: UIEvent;
}

export function broadcastToAll(event: UIEvent): BroadcastToAll {
  return Object.freeze({ type: 'BROADCAST_TO_ALL', event });
}

/**
 * Send to a specific client.
 */
export interface SendToClient {
  readonly type: 'SEND_TO_CLIENT';
  readonly clientId: string;
  readonly event: UIEvent;
}

export function sendToClient(clientId: string, event: UIEvent): SendToClient {
  return Object.freeze({ type: 'SEND_TO_CLIENT', clientId, event });
}

// ============================================================================
// BROADCAST EFFECT UNION
// ============================================================================

export type BroadcastEffect =
  | BroadcastToRoom
  | BroadcastToAll
  | SendToClient;

/**
 * Type guard for broadcast effects.
 */
export function isBroadcastEffect(effect: { type: string }): effect is BroadcastEffect {
  return [
    'BROADCAST_TO_ROOM',
    'BROADCAST_TO_ALL',
    'SEND_TO_CLIENT'
  ].includes(effect.type);
}
