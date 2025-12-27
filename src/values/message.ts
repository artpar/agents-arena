/**
 * Message Values
 *
 * Immutable data structures for messages in the system.
 * All fields are readonly - state changes create new objects.
 */

import {
  MessageId,
  RoomId,
  SenderId,
  AttachmentId,
  generateMessageId,
  generateAttachmentId
} from './ids.js';

// ============================================================================
// ATTACHMENT
// ============================================================================

export interface Attachment {
  readonly id: AttachmentId;
  readonly filename: string;
  readonly mimetype: string;
  readonly size: number;
  readonly url: string;
}

/**
 * Create a new Attachment value.
 */
export function createAttachment(params: {
  filename: string;
  mimetype: string;
  size: number;
  url: string;
  id?: AttachmentId;
}): Attachment {
  return Object.freeze({
    id: params.id ?? generateAttachmentId(),
    filename: params.filename,
    mimetype: params.mimetype,
    size: params.size,
    url: params.url
  });
}

// ============================================================================
// MESSAGE TYPE
// ============================================================================

export type MessageType =
  | 'chat'      // Regular chat message
  | 'system'    // System notification
  | 'action'    // /me style action
  | 'join'      // User/agent joined
  | 'leave';    // User/agent left

// ============================================================================
// CHAT MESSAGE
// ============================================================================

export interface ChatMessage {
  readonly id: MessageId;
  readonly roomId: RoomId;
  readonly senderId: SenderId;
  readonly senderName: string;
  readonly content: string;
  readonly type: MessageType;
  readonly timestamp: number;  // Unix timestamp (ms)
  readonly replyTo: MessageId | null;
  readonly mentions: readonly string[];
  readonly attachments: readonly Attachment[];
}

/**
 * Create a new ChatMessage value.
 * Automatically freezes the object to ensure immutability.
 */
export function createChatMessage(params: {
  roomId: RoomId;
  senderId: SenderId;
  senderName: string;
  content: string;
  type?: MessageType;
  timestamp?: number;
  replyTo?: MessageId | null;
  mentions?: readonly string[];
  attachments?: readonly Attachment[];
  id?: MessageId;
}): ChatMessage {
  return Object.freeze({
    id: params.id ?? generateMessageId(),
    roomId: params.roomId,
    senderId: params.senderId,
    senderName: params.senderName,
    content: params.content,
    type: params.type ?? 'chat',
    timestamp: params.timestamp ?? Date.now(),
    replyTo: params.replyTo ?? null,
    mentions: Object.freeze(params.mentions ?? []),
    attachments: Object.freeze(params.attachments ?? [])
  });
}

// ============================================================================
// MESSAGE TRANSFORMATIONS (Pure functions)
// ============================================================================

/**
 * Create a copy of a message with updated content.
 * Original message is unchanged.
 */
export function withContent(msg: ChatMessage, content: string): ChatMessage {
  return Object.freeze({ ...msg, content });
}

/**
 * Create a copy of a message with additional attachment.
 */
export function withAttachment(msg: ChatMessage, attachment: Attachment): ChatMessage {
  return Object.freeze({
    ...msg,
    attachments: Object.freeze([...msg.attachments, attachment])
  });
}

/**
 * Create a copy of a message with mentions.
 */
export function withMentions(msg: ChatMessage, mentions: readonly string[]): ChatMessage {
  return Object.freeze({
    ...msg,
    mentions: Object.freeze([...mentions])
  });
}

// ============================================================================
// MESSAGE QUERIES (Pure functions)
// ============================================================================

/**
 * Check if a message mentions a specific name.
 */
export function mentionsName(msg: ChatMessage, name: string): boolean {
  return msg.mentions.includes(name) ||
         msg.content.toLowerCase().includes(`@${name.toLowerCase()}`);
}

/**
 * Check if a message is from an agent (not user or system).
 */
export function isFromAgent(msg: ChatMessage): boolean {
  return msg.senderId !== 'system' && !msg.senderId.toString().startsWith('user_');
}

/**
 * Check if a message is from the system.
 */
export function isFromSystem(msg: ChatMessage): boolean {
  return msg.senderId === 'system';
}

/**
 * Check if a message has attachments.
 */
export function hasAttachments(msg: ChatMessage): boolean {
  return msg.attachments.length > 0;
}

/**
 * Check if a message is a reply to another message.
 */
export function isReply(msg: ChatMessage): boolean {
  return msg.replyTo !== null;
}

// ============================================================================
// CONVERSATION CONTEXT (for API calls)
// ============================================================================

export type ConversationRole = 'user' | 'assistant';

export interface ConversationTurn {
  readonly role: ConversationRole;
  readonly content: string;
}

/**
 * Convert chat messages to conversation turns for API calls.
 * Groups consecutive messages from same role.
 */
export function toConversationTurns(
  messages: readonly ChatMessage[],
  agentId: string
): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const msg of messages) {
    if (msg.type !== 'chat') continue;

    const role: ConversationRole = msg.senderId === agentId ? 'assistant' : 'user';
    const content = msg.senderId === agentId
      ? msg.content
      : `[${msg.senderName}]: ${msg.content}`;

    // Merge consecutive same-role messages
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.role === role) {
      turns[turns.length - 1] = {
        role,
        content: `${lastTurn.content}\n\n${content}`
      };
    } else {
      turns.push({ role, content });
    }
  }

  return Object.freeze(turns.map(t => Object.freeze(t)));
}

// ============================================================================
// MESSAGE FORMATTING
// ============================================================================

/**
 * Format a message for display in IRC-style format.
 */
export function formatForDisplay(msg: ChatMessage): string {
  const time = new Date(msg.timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  switch (msg.type) {
    case 'join':
      return `[${time}] --> ${msg.senderName} has joined`;
    case 'leave':
      return `[${time}] <-- ${msg.senderName} has left`;
    case 'action':
      return `[${time}] * ${msg.senderName} ${msg.content}`;
    case 'system':
      return `[${time}] * ${msg.content}`;
    case 'chat':
    default:
      return `[${time}] <${msg.senderName}> ${msg.content}`;
  }
}

/**
 * Format a message for the Anthropic API context.
 */
export function formatForContext(msg: ChatMessage): string {
  const time = new Date(msg.timestamp).toISOString();
  return `[${time}] ${msg.senderName}: ${msg.content}`;
}
