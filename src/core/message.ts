/**
 * Message handling for the chat system.
 */

import { v4 as uuidv4 } from 'uuid';
import { MessageType, MessageData } from './types.js';

export class Message {
  id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  channel: string;
  type: MessageType;
  timestamp: Date;
  reply_to?: string;
  mentions: string[];

  constructor(
    sender_id: string,
    sender_name: string,
    content: string,
    channel: string = 'general',
    type: MessageType = MessageType.CHAT,
    id?: string,
    timestamp?: Date,
    reply_to?: string,
    mentions?: string[]
  ) {
    this.id = id || uuidv4();
    this.sender_id = sender_id;
    this.sender_name = sender_name;
    this.content = content;
    this.channel = channel;
    this.type = type;
    this.timestamp = timestamp || new Date();
    this.reply_to = reply_to;
    this.mentions = mentions || this.extractMentions();
  }

  /**
   * Extract @mentions from message content.
   */
  private extractMentions(): string[] {
    const matches = this.content.match(/@(\w+)/g);
    if (!matches) return [];
    return matches.map(m => m.slice(1)); // Remove @ prefix
  }

  /**
   * Convert to dictionary for serialization.
   */
  toDict(): MessageData {
    return {
      id: this.id,
      sender_id: this.sender_id,
      sender_name: this.sender_name,
      content: this.content,
      channel: this.channel,
      type: this.type,
      timestamp: this.timestamp.toISOString(),
      reply_to: this.reply_to,
      mentions: this.mentions
    };
  }

  /**
   * Create from dictionary.
   */
  static fromDict(data: MessageData): Message {
    return new Message(
      data.sender_id,
      data.sender_name,
      data.content,
      data.channel || 'general',
      data.type as MessageType || MessageType.CHAT,
      data.id,
      new Date(data.timestamp),
      data.reply_to,
      data.mentions || []
    );
  }

  /**
   * Format message IRC-style.
   */
  formatIRC(): string {
    const timeStr = this.timestamp.toTimeString().slice(0, 8);
    switch (this.type) {
      case MessageType.ACTION:
        return `[${timeStr}] * ${this.sender_name} ${this.content}`;
      case MessageType.SYSTEM:
        return `[${timeStr}] *** ${this.content}`;
      case MessageType.JOIN:
        return `[${timeStr}] --> ${this.content}`;
      case MessageType.LEAVE:
        return `[${timeStr}] <-- ${this.content}`;
      default:
        return `[${timeStr}] <${this.sender_name}> ${this.content}`;
    }
  }
}
