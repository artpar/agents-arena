/**
 * Chat channel for agent communication.
 * Now with SQLite persistence.
 */

import { v4 as uuidv4 } from 'uuid';
import { Message } from '../core/message.js';
import { ChannelData } from '../core/types.js';
import * as db from '../core/database.js';

export class Channel {
  id: string;
  name: string;
  description: string;
  topic: string;
  created_at: Date;
  members: Set<string>;
  private _messagesCache: Message[];
  max_history: number;

  constructor(
    name: string,
    description: string = '',
    id?: string,
    topic?: string,
    skipPersist: boolean = false
  ) {
    this.id = id || uuidv4();
    this.name = name;
    this.description = description;
    this.topic = topic || '';
    this.created_at = new Date();
    this.members = new Set();
    this._messagesCache = [];
    this.max_history = 1000;

    // Persist to database
    if (!skipPersist) {
      db.createRoom(this.id, this.name, this.description, this.topic);
    }
  }

  /**
   * Load a channel from the database.
   */
  static fromDatabase(roomId: string): Channel | null {
    const row = db.getRoom(roomId);
    if (!row) return null;

    const channel = new Channel(row.name, row.description, row.id, row.topic, true);
    channel.created_at = new Date(row.created_at);

    // Load members
    const memberIds = db.getRoomMembers(row.id);
    for (const memberId of memberIds) {
      channel.members.add(memberId);
    }

    return channel;
  }

  /**
   * Add a member to the channel.
   */
  addMember(agentId: string): void {
    this.members.add(agentId);
    db.addRoomMember(this.id, agentId);
  }

  /**
   * Remove a member from the channel.
   */
  removeMember(agentId: string): void {
    this.members.delete(agentId);
    db.removeRoomMember(this.id, agentId);
  }

  /**
   * Add a message to the channel history.
   */
  addMessage(message: Message): void {
    // Add to cache
    this._messagesCache.push(message);

    // Trim cache if needed
    if (this._messagesCache.length > this.max_history) {
      this._messagesCache = this._messagesCache.slice(-this.max_history);
    }

    // Persist to database
    db.createMessage({
      id: message.id,
      room_id: this.id,
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      content: message.content,
      type: message.type,
      mentions: message.mentions
    });

    // Update agent spoke time if it's an agent
    if (message.sender_id !== 'human' && message.sender_id !== 'system') {
      db.updateAgentSpoke(message.sender_id);
    }
  }

  /**
   * Get the most recent messages.
   */
  getRecentMessages(count: number = 50): Message[] {
    // If cache has enough, use it
    if (this._messagesCache.length >= count) {
      return this._messagesCache.slice(-count);
    }

    // Otherwise load from database
    const rows = db.getMessages(this.id, count);
    return rows.map(row => new Message(
      row.sender_id,
      row.sender_name,
      row.content,
      this.name,
      row.type as any,
      row.id,
      new Date(row.created_at)
    ));
  }

  /**
   * Get recent messages formatted as context for agents.
   */
  getContextString(count: number = 20): string {
    const recent = this.getRecentMessages(count);
    const lines: string[] = [];

    // Include topic/atmosphere at the top if set
    if (this.topic) {
      lines.push(`=== Room Topic: ${this.topic} ===`);
      lines.push('');
    }

    for (const msg of recent) {
      lines.push(msg.formatIRC());
    }

    return lines.join('\n');
  }

  /**
   * Set the channel topic.
   */
  setTopic(topic: string): void {
    this.topic = topic;
    db.updateRoomTopic(this.id, topic);
  }

  /**
   * Clear all messages from the channel. Returns count of cleared messages.
   */
  clearMessages(): number {
    const count = db.clearMessages(this.id);
    this._messagesCache = [];
    return count;
  }

  /**
   * Get total message count from database.
   */
  getMessageCount(): number {
    return db.getMessageCount(this.id);
  }

  /**
   * Serialize channel to dictionary.
   */
  toDict(): ChannelData {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      topic: this.topic,
      members: Array.from(this.members),
      message_count: this.getMessageCount(),
      created_at: this.created_at.toISOString()
    };
  }
}
