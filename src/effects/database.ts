/**
 * Database Effects
 *
 * Effects that describe database operations.
 * These are DATA describing what to do, not the execution.
 * The boundary executor will actually run these against SQLite.
 */

import {
  RoomId,
  AgentId,
  MessageId,
  ProjectId,
  TaskId,
  ChatMessage,
  AgentConfig,
  RoomConfig,
  Task
} from '../values/index.js';

// ============================================================================
// MESSAGE EFFECTS
// ============================================================================

/**
 * Save a chat message to the database.
 */
export interface DbSaveMessage {
  readonly type: 'DB_SAVE_MESSAGE';
  readonly message: ChatMessage;
}

export function dbSaveMessage(message: ChatMessage): DbSaveMessage {
  return Object.freeze({ type: 'DB_SAVE_MESSAGE', message });
}

/**
 * Load message history for a room.
 */
export interface DbLoadMessages {
  readonly type: 'DB_LOAD_MESSAGES';
  readonly roomId: RoomId;
  readonly limit: number;
  readonly beforeTimestamp?: number;
  readonly replyTag: string;  // Tag to correlate response
}

export function dbLoadMessages(
  roomId: RoomId,
  limit: number,
  replyTag: string,
  beforeTimestamp?: number
): DbLoadMessages {
  return Object.freeze({
    type: 'DB_LOAD_MESSAGES',
    roomId,
    limit,
    replyTag,
    beforeTimestamp
  });
}

/**
 * Delete messages from a room.
 */
export interface DbDeleteMessages {
  readonly type: 'DB_DELETE_MESSAGES';
  readonly roomId: RoomId;
  readonly beforeTimestamp?: number;  // If set, only delete older messages
}

export function dbDeleteMessages(
  roomId: RoomId,
  beforeTimestamp?: number
): DbDeleteMessages {
  return Object.freeze({
    type: 'DB_DELETE_MESSAGES',
    roomId,
    beforeTimestamp
  });
}

// ============================================================================
// AGENT EFFECTS
// ============================================================================

/**
 * Save agent config to database.
 */
export interface DbSaveAgent {
  readonly type: 'DB_SAVE_AGENT';
  readonly config: AgentConfig;
}

export function dbSaveAgent(config: AgentConfig): DbSaveAgent {
  return Object.freeze({ type: 'DB_SAVE_AGENT', config });
}

/**
 * Load agent config from database.
 */
export interface DbLoadAgent {
  readonly type: 'DB_LOAD_AGENT';
  readonly agentId: AgentId;
  readonly replyTag: string;
}

export function dbLoadAgent(agentId: AgentId, replyTag: string): DbLoadAgent {
  return Object.freeze({ type: 'DB_LOAD_AGENT', agentId, replyTag });
}

/**
 * Load all agents from database.
 */
export interface DbLoadAllAgents {
  readonly type: 'DB_LOAD_ALL_AGENTS';
  readonly replyTag: string;
}

export function dbLoadAllAgents(replyTag: string): DbLoadAllAgents {
  return Object.freeze({ type: 'DB_LOAD_ALL_AGENTS', replyTag });
}

/**
 * Update agent stats (message count, last spoke).
 */
export interface DbUpdateAgentStats {
  readonly type: 'DB_UPDATE_AGENT_STATS';
  readonly agentId: AgentId;
  readonly messageCount: number;
  readonly lastSpokeAt: number;
}

export function dbUpdateAgentStats(
  agentId: AgentId,
  messageCount: number,
  lastSpokeAt: number
): DbUpdateAgentStats {
  return Object.freeze({
    type: 'DB_UPDATE_AGENT_STATS',
    agentId,
    messageCount,
    lastSpokeAt
  });
}

// ============================================================================
// ROOM EFFECTS
// ============================================================================

/**
 * Save room config to database.
 */
export interface DbSaveRoom {
  readonly type: 'DB_SAVE_ROOM';
  readonly config: RoomConfig;
}

export function dbSaveRoom(config: RoomConfig): DbSaveRoom {
  return Object.freeze({ type: 'DB_SAVE_ROOM', config });
}

/**
 * Load room config from database.
 */
export interface DbLoadRoom {
  readonly type: 'DB_LOAD_ROOM';
  readonly roomId: RoomId;
  readonly replyTag: string;
}

export function dbLoadRoom(roomId: RoomId, replyTag: string): DbLoadRoom {
  return Object.freeze({ type: 'DB_LOAD_ROOM', roomId, replyTag });
}

// ============================================================================
// PROJECT EFFECTS
// ============================================================================

/**
 * Save project state to database.
 */
export interface DbSaveProject {
  readonly type: 'DB_SAVE_PROJECT';
  readonly projectId: ProjectId;
  readonly name: string;
  readonly goal: string;
  readonly roomId: RoomId;
  readonly phase: string;
}

export function dbSaveProject(
  projectId: ProjectId,
  name: string,
  goal: string,
  roomId: RoomId,
  phase: string
): DbSaveProject {
  return Object.freeze({
    type: 'DB_SAVE_PROJECT',
    projectId,
    name,
    goal,
    roomId,
    phase
  });
}

/**
 * Save task to database.
 */
export interface DbSaveTask {
  readonly type: 'DB_SAVE_TASK';
  readonly projectId: ProjectId;
  readonly task: Task;
}

export function dbSaveTask(projectId: ProjectId, task: Task): DbSaveTask {
  return Object.freeze({ type: 'DB_SAVE_TASK', projectId, task });
}

/**
 * Update task in database.
 */
export interface DbUpdateTask {
  readonly type: 'DB_UPDATE_TASK';
  readonly task: Task;
}

export function dbUpdateTask(task: Task): DbUpdateTask {
  return Object.freeze({ type: 'DB_UPDATE_TASK', task });
}

// ============================================================================
// EVENT LOG EFFECTS
// ============================================================================

/**
 * Log an event to the database event_log table.
 * Used for tool_use, tool_result, and other trackable events.
 */
export interface DbLogEvent {
  readonly type: 'DB_LOG_EVENT';
  readonly eventType: string;
  readonly eventData: Record<string, unknown>;
  readonly sessionId?: string;
}

export function dbLogEvent(
  eventType: string,
  eventData: Record<string, unknown>,
  sessionId?: string
): DbLogEvent {
  return Object.freeze({
    type: 'DB_LOG_EVENT',
    eventType,
    eventData,
    sessionId
  });
}

// ============================================================================
// DATABASE EFFECT UNION
// ============================================================================

export type DatabaseEffect =
  | DbSaveMessage
  | DbLoadMessages
  | DbDeleteMessages
  | DbSaveAgent
  | DbLoadAgent
  | DbLoadAllAgents
  | DbUpdateAgentStats
  | DbSaveRoom
  | DbLoadRoom
  | DbSaveProject
  | DbSaveTask
  | DbUpdateTask
  | DbLogEvent;

/**
 * Type guard for database effects.
 */
export function isDatabaseEffect(effect: { type: string }): effect is DatabaseEffect {
  return effect.type.startsWith('DB_');
}
