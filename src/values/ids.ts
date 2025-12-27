/**
 * Branded ID Types
 *
 * Branded types provide compile-time type safety for IDs.
 * You cannot accidentally pass a RoomId where an AgentId is expected.
 *
 * These are "phantom types" - the brand exists only at compile time,
 * at runtime they are just strings.
 */

// ============================================================================
// BRAND SYMBOL
// ============================================================================

declare const brand: unique symbol;

type Brand<T, B> = T & { readonly [brand]: B };

// ============================================================================
// ID TYPES
// ============================================================================

export type RoomId = Brand<string, 'RoomId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type UserId = Brand<string, 'UserId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;

// ============================================================================
// ID CONSTRUCTORS (Smart Constructors)
// ============================================================================

/**
 * Create a RoomId from a string.
 * Use this instead of type casting.
 */
export function roomId(id: string): RoomId {
  return id as RoomId;
}

export function agentId(id: string): AgentId {
  return id as AgentId;
}

export function messageId(id: string): MessageId {
  return id as MessageId;
}

export function projectId(id: string): ProjectId {
  return id as ProjectId;
}

export function taskId(id: string): TaskId {
  return id as TaskId;
}

export function userId(id: string): UserId {
  return id as UserId;
}

export function attachmentId(id: string): AttachmentId {
  return id as AttachmentId;
}

export function senderId(id: string): SenderId {
  if (id === 'system') return 'system';
  return id as AgentId | UserId;
}

// ============================================================================
// ID GENERATORS
// ============================================================================

let counter = 0;

function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  const count = (counter++).toString(36);
  return `${prefix}_${timestamp}_${random}_${count}`;
}

export function generateRoomId(): RoomId {
  return roomId(generateId('room'));
}

export function generateAgentId(): AgentId {
  return agentId(generateId('agent'));
}

export function generateMessageId(): MessageId {
  return messageId(generateId('msg'));
}

export function generateProjectId(): ProjectId {
  return projectId(generateId('proj'));
}

export function generateTaskId(): TaskId {
  return taskId(generateId('task'));
}

export function generateUserId(): UserId {
  return userId(generateId('user'));
}

export function generateAttachmentId(): AttachmentId {
  return attachmentId(generateId('attach'));
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Check if a string looks like a valid ID of a given type.
 * This is a runtime check based on prefix convention.
 */
export function isRoomId(id: string): id is RoomId {
  return id.startsWith('room_') || id === 'general'; // 'general' is default room
}

export function isAgentId(id: string): id is AgentId {
  return id.startsWith('agent_') || !id.includes('_'); // legacy IDs without prefix
}

export function isMessageId(id: string): id is MessageId {
  return id.startsWith('msg_');
}

export function isProjectId(id: string): id is ProjectId {
  return id.startsWith('proj_');
}

export function isTaskId(id: string): id is TaskId {
  return id.startsWith('task_');
}

// ============================================================================
// SENDER ID (Union type for message senders)
// ============================================================================

export type SenderId = AgentId | UserId | 'system';

export function isSenderAgent(id: SenderId): id is AgentId {
  return id !== 'system' && isAgentId(id as string);
}

export function isSenderUser(id: SenderId): id is UserId {
  return id !== 'system' && !isAgentId(id as string);
}

export function isSenderSystem(id: SenderId): id is 'system' {
  return id === 'system';
}
