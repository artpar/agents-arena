/**
 * Actor Effects
 *
 * Effects that describe actor system operations.
 * These are DATA describing what to do, not the execution.
 * The runtime will route messages and manage actor lifecycle.
 */

import {
  RoomId,
  AgentId,
  ProjectId,
  AgentConfig,
  RoomConfig
} from '../values/index.js';

// ============================================================================
// ACTOR ADDRESS
// ============================================================================

/**
 * Address for routing messages to actors.
 * Format: "type:id" (e.g., "room:general", "agent:max")
 */
export type ActorAddress = string & { readonly _brand: 'ActorAddress' };

export function actorAddress(type: string, id: string): ActorAddress {
  return `${type}:${id}` as ActorAddress;
}

export function roomAddress(roomId: RoomId): ActorAddress {
  return actorAddress('room', roomId);
}

export function agentAddress(agentId: AgentId): ActorAddress {
  return actorAddress('agent', agentId);
}

export function projectAddress(projectId: ProjectId): ActorAddress {
  return actorAddress('project', projectId);
}

export function directorAddress(): ActorAddress {
  return actorAddress('director', 'main');
}

/**
 * Parse an actor address.
 */
export function parseAddress(addr: ActorAddress): { type: string; id: string } {
  const [type, ...rest] = addr.split(':');
  return { type, id: rest.join(':') };
}

// ============================================================================
// ACTOR MESSAGES (What actors can receive)
// ============================================================================

/**
 * Base message interface - all messages have a type.
 */
export interface ActorMessage {
  readonly type: string;
}

/**
 * Message with a reply tag for request-response patterns.
 */
export interface TaggedMessage extends ActorMessage {
  readonly replyTag: string;
}

/**
 * Reply message sent back after processing.
 */
export interface ReplyMessage extends ActorMessage {
  readonly inReplyTo: string;  // The original replyTag
}

// ============================================================================
// SEND EFFECTS
// ============================================================================

/**
 * Send a message to an actor.
 */
export interface SendToActor {
  readonly type: 'SEND_TO_ACTOR';
  readonly to: ActorAddress;
  readonly message: ActorMessage;
}

export function sendToActor(to: ActorAddress, message: ActorMessage): SendToActor {
  return Object.freeze({ type: 'SEND_TO_ACTOR', to, message });
}

/**
 * Send to room actor.
 */
export function sendToRoom(roomId: RoomId, message: ActorMessage): SendToActor {
  return sendToActor(roomAddress(roomId), message);
}

/**
 * Send to agent actor.
 */
export function sendToAgent(agentId: AgentId, message: ActorMessage): SendToActor {
  return sendToActor(agentAddress(agentId), message);
}

/**
 * Send to project actor.
 */
export function sendToProject(projectId: ProjectId, message: ActorMessage): SendToActor {
  return sendToActor(projectAddress(projectId), message);
}

/**
 * Send to director.
 */
export function sendToDirector(message: ActorMessage): SendToActor {
  return sendToActor(directorAddress(), message);
}

/**
 * Forward a message (preserves sender).
 */
export interface ForwardToActor {
  readonly type: 'FORWARD_TO_ACTOR';
  readonly to: ActorAddress;
  readonly message: ActorMessage;
  readonly originalSender: ActorAddress;
}

export function forwardToActor(
  to: ActorAddress,
  message: ActorMessage,
  originalSender: ActorAddress
): ForwardToActor {
  return Object.freeze({
    type: 'FORWARD_TO_ACTOR',
    to,
    message,
    originalSender
  });
}

// ============================================================================
// LIFECYCLE EFFECTS
// ============================================================================

/**
 * Spawn a new room actor.
 */
export interface SpawnRoomActor {
  readonly type: 'SPAWN_ROOM_ACTOR';
  readonly config: RoomConfig;
}

export function spawnRoomActor(config: RoomConfig): SpawnRoomActor {
  return Object.freeze({ type: 'SPAWN_ROOM_ACTOR', config });
}

/**
 * Spawn a new agent actor.
 */
export interface SpawnAgentActor {
  readonly type: 'SPAWN_AGENT_ACTOR';
  readonly config: AgentConfig;
}

export function spawnAgentActor(config: AgentConfig): SpawnAgentActor {
  return Object.freeze({ type: 'SPAWN_AGENT_ACTOR', config });
}

/**
 * Spawn a new project actor.
 */
export interface SpawnProjectActor {
  readonly type: 'SPAWN_PROJECT_ACTOR';
  readonly projectId: ProjectId;
  readonly name: string;
  readonly goal: string;
  readonly roomId: RoomId;
}

export function spawnProjectActor(
  projectId: ProjectId,
  name: string,
  goal: string,
  roomId: RoomId
): SpawnProjectActor {
  return Object.freeze({
    type: 'SPAWN_PROJECT_ACTOR',
    projectId,
    name,
    goal,
    roomId
  });
}

/**
 * Stop an actor.
 */
export interface StopActor {
  readonly type: 'STOP_ACTOR';
  readonly address: ActorAddress;
  readonly reason?: string;
}

export function stopActor(address: ActorAddress, reason?: string): StopActor {
  return Object.freeze({ type: 'STOP_ACTOR', address, reason });
}

/**
 * Restart an actor.
 */
export interface RestartActor {
  readonly type: 'RESTART_ACTOR';
  readonly address: ActorAddress;
}

export function restartActor(address: ActorAddress): RestartActor {
  return Object.freeze({ type: 'RESTART_ACTOR', address });
}

// ============================================================================
// SCHEDULING EFFECTS
// ============================================================================

/**
 * Schedule a message to be sent after a delay.
 */
export interface ScheduleMessage {
  readonly type: 'SCHEDULE_MESSAGE';
  readonly to: ActorAddress;
  readonly message: ActorMessage;
  readonly delayMs: number;
  readonly id?: string;  // Optional ID for cancellation
}

export function scheduleMessage(
  to: ActorAddress,
  message: ActorMessage,
  delayMs: number,
  id?: string
): ScheduleMessage {
  return Object.freeze({
    type: 'SCHEDULE_MESSAGE',
    to,
    message,
    delayMs,
    id
  });
}

/**
 * Cancel a scheduled message.
 */
export interface CancelScheduled {
  readonly type: 'CANCEL_SCHEDULED';
  readonly id: string;
}

export function cancelScheduled(id: string): CancelScheduled {
  return Object.freeze({ type: 'CANCEL_SCHEDULED', id });
}

/**
 * Schedule a recurring message.
 */
export interface ScheduleRecurring {
  readonly type: 'SCHEDULE_RECURRING';
  readonly to: ActorAddress;
  readonly message: ActorMessage;
  readonly intervalMs: number;
  readonly id: string;
}

export function scheduleRecurring(
  to: ActorAddress,
  message: ActorMessage,
  intervalMs: number,
  id: string
): ScheduleRecurring {
  return Object.freeze({
    type: 'SCHEDULE_RECURRING',
    to,
    message,
    intervalMs,
    id
  });
}

// ============================================================================
// SUPERVISION EFFECTS
// ============================================================================

/**
 * Watch an actor for failure.
 */
export interface WatchActor {
  readonly type: 'WATCH_ACTOR';
  readonly address: ActorAddress;
}

export function watchActor(address: ActorAddress): WatchActor {
  return Object.freeze({ type: 'WATCH_ACTOR', address });
}

/**
 * Unwatch an actor.
 */
export interface UnwatchActor {
  readonly type: 'UNWATCH_ACTOR';
  readonly address: ActorAddress;
}

export function unwatchActor(address: ActorAddress): UnwatchActor {
  return Object.freeze({ type: 'UNWATCH_ACTOR', address });
}

// ============================================================================
// ACTOR EFFECT UNION
// ============================================================================

export type ActorEffect =
  | SendToActor
  | ForwardToActor
  | SpawnRoomActor
  | SpawnAgentActor
  | SpawnProjectActor
  | StopActor
  | RestartActor
  | ScheduleMessage
  | CancelScheduled
  | ScheduleRecurring
  | WatchActor
  | UnwatchActor;

/**
 * Type guard for actor effects.
 */
export function isActorEffect(effect: { type: string }): effect is ActorEffect {
  return [
    'SEND_TO_ACTOR',
    'FORWARD_TO_ACTOR',
    'SPAWN_ROOM_ACTOR',
    'SPAWN_AGENT_ACTOR',
    'SPAWN_PROJECT_ACTOR',
    'STOP_ACTOR',
    'RESTART_ACTOR',
    'SCHEDULE_MESSAGE',
    'CANCEL_SCHEDULED',
    'SCHEDULE_RECURRING',
    'WATCH_ACTOR',
    'UNWATCH_ACTOR'
  ].includes(effect.type);
}

// ============================================================================
// COMMON ACTOR MESSAGES
// ============================================================================

/**
 * Initialize actor (sent on startup).
 */
export interface InitMessage {
  readonly type: 'INIT';
}

export const initMessage: InitMessage = Object.freeze({ type: 'INIT' });

/**
 * Shutdown actor.
 */
export interface ShutdownMessage {
  readonly type: 'SHUTDOWN';
  readonly reason?: string;
}

export function shutdownMessage(reason?: string): ShutdownMessage {
  return Object.freeze({ type: 'SHUTDOWN', reason });
}

/**
 * Health check.
 */
export interface PingMessage {
  readonly type: 'PING';
  readonly replyTag: string;
}

export function pingMessage(replyTag: string): PingMessage {
  return Object.freeze({ type: 'PING', replyTag });
}

/**
 * Health check response.
 */
export interface PongMessage {
  readonly type: 'PONG';
  readonly inReplyTo: string;
  readonly address: ActorAddress;
  readonly uptime: number;
}

export function pongMessage(
  inReplyTo: string,
  address: ActorAddress,
  uptime: number
): PongMessage {
  return Object.freeze({ type: 'PONG', inReplyTo, address, uptime });
}
