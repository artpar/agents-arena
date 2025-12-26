/**
 * Core type definitions for Agent Arena.
 */

// Enums
export enum AgentStatus {
  IDLE = 'idle',
  THINKING = 'thinking',
  SPEAKING = 'speaking',
  OFFLINE = 'offline'
}

export enum MessageType {
  CHAT = 'chat',
  SYSTEM = 'system',
  ACTION = 'action', // /me style
  JOIN = 'join',
  LEAVE = 'leave'
}

export enum ScheduleMode {
  TURN_BASED = 'turn_based', // Round-robin, one at a time
  ASYNC = 'async',           // Agents speak whenever they want
  HYBRID = 'hybrid'          // Rounds + async for mentions
}

// Interfaces
export interface PersonalityTraits {
  [key: string]: number; // 0.0 to 1.0
}

export interface AgentConfig {
  id?: string;
  name: string;
  description?: string;
  system_prompt?: string;
  personality_traits?: PersonalityTraits;
  speaking_style?: string;
  interests?: string[];
  response_tendency?: number; // 0.0 (quiet) to 1.0 (talkative)
  temperature?: number;
  model?: string; // sonnet, opus, haiku
  tools?: string[];

  // NEW: Concrete persona fields for realistic discussions
  background?: string;              // Specific life/work history
  expertise?: string[];             // Deep knowledge areas with specifics
  war_stories?: string[];           // Concrete experiences/failures that shaped views
  strong_opinions?: string[];       // Opinionated takes with reasoning
  current_obsession?: string;       // What they can't stop thinking about
  blind_spots?: string[];           // What they dismiss or don't understand
  communication_quirks?: string[];  // How they uniquely express themselves
}

export interface Attachment {
  id: string;
  filename: string;
  mimetype: string;
  size: number;
  url: string;
}

export interface MessageData {
  id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  channel: string;
  type: string;
  timestamp: string;
  reply_to?: string;
  mentions: string[];
  attachments?: Attachment[];
}

export interface ChannelData {
  id: string;
  name: string;
  description: string;
  topic: string;
  members: string[];
  message_count: number;
  created_at: string;
}

export interface WorldStatus {
  name: string;
  running: boolean;
  mode: string;
  current_round: number;
  max_turns: number;
  start_time: string | null;
  agents: {
    count: number;
    names: string[];
  };
  channels: Record<string, ChannelData>;
}

export interface AgentData {
  id: string;
  name: string;
  description: string;
  status: string;
  personality_traits: PersonalityTraits;
  speaking_style: string;
  interests: string[];
  response_tendency: number;
  temperature: number;
  model: string;
  message_count: number;
  last_spoke_at: string | null;
}
