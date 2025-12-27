/**
 * SQLite database module for Agent Arena persistence.
 * Normalized schema for rooms, messages, agents, and sessions.
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Database file location
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'arena.db');

let db: Database.Database | null = null;

/**
 * Initialize the database connection and create tables.
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  // Ensure data directory exists
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables(db);
  return db;
}

/**
 * Get the database instance.
 */
export function getDatabase(): Database.Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Create all database tables.
 */
function createTables(db: Database.Database): void {
  // Rooms/Channels table
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      topic TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Agents table (persisted config and state)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      system_prompt TEXT DEFAULT '',
      personality_traits TEXT DEFAULT '{}',
      speaking_style TEXT DEFAULT '',
      interests TEXT DEFAULT '[]',
      response_tendency REAL DEFAULT 0.5,
      temperature REAL DEFAULT 0.7,
      model TEXT DEFAULT 'claude-haiku-4-5-20251001',
      status TEXT DEFAULT 'offline',
      message_count INTEGER DEFAULT 0,
      last_spoke_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Room memberships (many-to-many)
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, agent_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    )
  `);

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'chat',
      mentions TEXT DEFAULT '[]',
      attachments TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    )
  `);

  // Add attachments column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT DEFAULT '[]'`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Sessions table (simulation runs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      mode TEXT DEFAULT 'hybrid',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      total_rounds INTEGER DEFAULT 0,
      total_messages INTEGER DEFAULT 0
    )
  `);

  // Event log table (for complete logging)
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_type TEXT NOT NULL,
      event_data TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `);

  // Artifacts table (memory tool storage - file-like storage per room/agent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      UNIQUE(room_id, agent_id, path)
    )
  `);

  // Create indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_room_agent ON artifacts(room_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(path);
  `);

  console.log('Database initialized at', DB_PATH);
}

// ==================== Room Operations ====================

export interface RoomRow {
  id: string;
  name: string;
  description: string;
  topic: string;
  created_at: string;
  updated_at: string;
}

export function createRoom(id: string, name: string, description: string = '', topic: string = ''): RoomRow {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO rooms (id, name, description, topic)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      topic = excluded.topic,
      updated_at = datetime('now')
    RETURNING *
  `);
  return stmt.get(id, name, description, topic) as RoomRow;
}

export function getRoom(nameOrId: string): RoomRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM rooms WHERE id = ? OR name = ?');
  return stmt.get(nameOrId, nameOrId) as RoomRow | undefined;
}

export function getAllRooms(): RoomRow[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM rooms ORDER BY created_at');
  return stmt.all() as RoomRow[];
}

export function updateRoomTopic(roomId: string, topic: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE rooms SET topic = ?, updated_at = datetime('now') WHERE id = ?
  `);
  stmt.run(topic, roomId);
}

export function deleteRoom(roomId: string): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM rooms WHERE id = ?');
  stmt.run(roomId);
}

// ==================== Agent Operations ====================

export interface AgentRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  personality_traits: string;
  speaking_style: string;
  interests: string;
  response_tendency: number;
  temperature: number;
  model: string;
  status: string;
  message_count: number;
  last_spoke_at: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertAgent(agent: {
  id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  personality_traits?: Record<string, number>;
  speaking_style?: string;
  interests?: string[];
  response_tendency?: number;
  temperature?: number;
  model?: string;
}): AgentRow {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO agents (id, name, description, system_prompt, personality_traits, speaking_style, interests, response_tendency, temperature, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      system_prompt = excluded.system_prompt,
      personality_traits = excluded.personality_traits,
      speaking_style = excluded.speaking_style,
      interests = excluded.interests,
      response_tendency = excluded.response_tendency,
      temperature = excluded.temperature,
      model = excluded.model,
      updated_at = datetime('now')
    RETURNING *
  `);
  return stmt.get(
    agent.id,
    agent.name,
    agent.description || '',
    agent.system_prompt || '',
    JSON.stringify(agent.personality_traits || {}),
    agent.speaking_style || '',
    JSON.stringify(agent.interests || []),
    agent.response_tendency ?? 0.5,
    agent.temperature ?? 0.7,
    agent.model || 'claude-haiku-4-5-20251001'
  ) as AgentRow;
}

export function getAgent(id: string): AgentRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM agents WHERE id = ?');
  return stmt.get(id) as AgentRow | undefined;
}

export function getAgentByName(name: string): AgentRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM agents WHERE LOWER(name) = LOWER(?)');
  return stmt.get(name) as AgentRow | undefined;
}

export function getAllAgents(): AgentRow[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM agents ORDER BY name');
  return stmt.all() as AgentRow[];
}

export function updateAgentStatus(agentId: string, status: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
  `);
  stmt.run(status, agentId);
}

export function updateAgentSpoke(agentId: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE agents SET
      message_count = message_count + 1,
      last_spoke_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(agentId);
}

export function deleteAgent(agentId: string): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM agents WHERE id = ?');
  stmt.run(agentId);
}

// ==================== Room Membership Operations ====================

export function addRoomMember(roomId: string, agentId: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO room_members (room_id, agent_id) VALUES (?, ?)
  `);
  stmt.run(roomId, agentId);
}

export function removeRoomMember(roomId: string, agentId: string): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM room_members WHERE room_id = ? AND agent_id = ?');
  stmt.run(roomId, agentId);
}

export function removeAgentFromAllRooms(agentId: string): void {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM room_members WHERE agent_id = ?');
  stmt.run(agentId);
}

export function getRoomMembers(roomId: string): string[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT agent_id FROM room_members WHERE room_id = ?');
  const rows = stmt.all(roomId) as Array<{ agent_id: string }>;
  return rows.map(r => r.agent_id);
}

// ==================== Message Operations ====================

export interface MessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  type: string;
  mentions: string;
  attachments: string;
  created_at: string;
}

export function createMessage(message: {
  id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  type?: string;
  mentions?: string[];
  attachments?: Array<{ id: string; filename: string; mimetype: string; size: number; url: string }>;
}): MessageRow {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO messages (id, room_id, sender_id, sender_name, content, type, mentions, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);
  return stmt.get(
    message.id,
    message.room_id,
    message.sender_id,
    message.sender_name,
    message.content,
    message.type || 'chat',
    JSON.stringify(message.mentions || []),
    JSON.stringify(message.attachments || [])
  ) as MessageRow;
}

export function getMessages(roomId: string, limit: number = 50, offset: number = 0): MessageRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE room_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `);
  const rows = stmt.all(roomId, limit, offset) as MessageRow[];
  return rows.reverse(); // Return in chronological order
}

export function getMessageCount(roomId: string): number {
  const db = getDatabase();
  const stmt = db.prepare('SELECT COUNT(*) as count FROM messages WHERE room_id = ?');
  const row = stmt.get(roomId) as { count: number };
  return row.count;
}

export function clearMessages(roomId: string): number {
  const db = getDatabase();
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM messages WHERE room_id = ?');
  const row = countStmt.get(roomId) as { count: number };
  const count = row.count;

  const deleteStmt = db.prepare('DELETE FROM messages WHERE room_id = ?');
  deleteStmt.run(roomId);

  return count;
}

export function deleteMessage(messageId: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM messages WHERE id = ?');
  const result = stmt.run(messageId);
  return result.changes > 0;
}

export function searchMessages(query: string, roomId?: string, limit: number = 50): MessageRow[] {
  const db = getDatabase();
  if (roomId) {
    const stmt = db.prepare(`
      SELECT * FROM messages
      WHERE room_id = ? AND content LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(roomId, `%${query}%`, limit) as MessageRow[];
  } else {
    const stmt = db.prepare(`
      SELECT * FROM messages
      WHERE content LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(`%${query}%`, limit) as MessageRow[];
  }
}

// ==================== Session Operations ====================

export interface SessionRow {
  id: string;
  name: string;
  mode: string;
  started_at: string;
  ended_at: string | null;
  total_rounds: number;
  total_messages: number;
}

export function createSession(id: string, name: string = '', mode: string = 'hybrid'): SessionRow {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO sessions (id, name, mode)
    VALUES (?, ?, ?)
    RETURNING *
  `);
  return stmt.get(id, name, mode) as SessionRow;
}

export function endSession(sessionId: string, totalRounds: number, totalMessages: number): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE sessions SET
      ended_at = datetime('now'),
      total_rounds = ?,
      total_messages = ?
    WHERE id = ?
  `);
  stmt.run(totalRounds, totalMessages, sessionId);
}

export function getSession(id: string): SessionRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  return stmt.get(id) as SessionRow | undefined;
}

export function getRecentSessions(limit: number = 10): SessionRow[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?');
  return stmt.all(limit) as SessionRow[];
}

// ==================== Event Log Operations ====================

export interface EventLogRow {
  id: number;
  session_id: string | null;
  event_type: string;
  event_data: string;
  created_at: string;
}

export function logEvent(eventType: string, eventData: Record<string, unknown> = {}, sessionId?: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO event_log (session_id, event_type, event_data)
    VALUES (?, ?, ?)
  `);
  stmt.run(sessionId || null, eventType, JSON.stringify(eventData));
}

export function getEventLog(sessionId?: string, eventType?: string, limit: number = 100): EventLogRow[] {
  const db = getDatabase();
  let sql = 'SELECT * FROM event_log WHERE 1=1';
  const params: unknown[] = [];

  if (sessionId) {
    sql += ' AND session_id = ?';
    params.push(sessionId);
  }
  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(sql);
  return stmt.all(...params) as EventLogRow[];
}

export function clearEventsByRoom(roomId: string): number {
  const db = getDatabase();
  // event_data is JSON with room_id field
  const stmt = db.prepare(`
    DELETE FROM event_log
    WHERE json_extract(event_data, '$.room_id') = ?
  `);
  const result = stmt.run(roomId);
  return result.changes;
}

// ==================== Artifact Operations (Memory Tool Storage) ====================

export interface ArtifactRow {
  id: string;
  room_id: string;
  agent_id: string;
  path: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export function createArtifact(artifact: {
  id: string;
  roomId: string;
  agentId: string;
  path: string;
  content: string;
}): ArtifactRow {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO artifacts (id, room_id, agent_id, path, content)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `);
  return stmt.get(
    artifact.id,
    artifact.roomId,
    artifact.agentId,
    artifact.path,
    artifact.content
  ) as ArtifactRow;
}

export function getArtifact(roomId: string, agentId: string, path: string): ArtifactRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM artifacts WHERE room_id = ? AND agent_id = ? AND path = ?');
  return stmt.get(roomId, agentId, path) as ArtifactRow | undefined;
}

export function getArtifactById(id: string): ArtifactRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM artifacts WHERE id = ?');
  return stmt.get(id) as ArtifactRow | undefined;
}

export function listArtifacts(roomId: string, agentId: string, pathPrefix?: string): ArtifactRow[] {
  const db = getDatabase();
  if (pathPrefix) {
    const stmt = db.prepare('SELECT * FROM artifacts WHERE room_id = ? AND agent_id = ? AND path LIKE ? ORDER BY path');
    return stmt.all(roomId, agentId, `${pathPrefix}%`) as ArtifactRow[];
  } else {
    const stmt = db.prepare('SELECT * FROM artifacts WHERE room_id = ? AND agent_id = ? ORDER BY path');
    return stmt.all(roomId, agentId) as ArtifactRow[];
  }
}

export interface ArtifactWithAgent {
  path: string;
  agentId: string;
  agentName: string;
}

export function listAllArtifactsInRoom(roomId: string, excludeAgentId: string): ArtifactWithAgent[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT a.path, a.agent_id as agentId, COALESCE(ag.name, a.agent_id) as agentName
    FROM artifacts a
    LEFT JOIN agents ag ON a.agent_id = ag.id
    WHERE a.room_id = ?
      AND a.agent_id != ?
      AND a.agent_id != '_shared_'
    ORDER BY ag.name, a.path
  `);
  return stmt.all(roomId, excludeAgentId) as ArtifactWithAgent[];
}

export function updateArtifact(roomId: string, agentId: string, path: string, content: string): ArtifactRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE artifacts
    SET content = ?, updated_at = datetime('now')
    WHERE room_id = ? AND agent_id = ? AND path = ?
    RETURNING *
  `);
  return stmt.get(content, roomId, agentId, path) as ArtifactRow | undefined;
}

export function deleteArtifact(roomId: string, agentId: string, path: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM artifacts WHERE room_id = ? AND agent_id = ? AND path = ?');
  const result = stmt.run(roomId, agentId, path);
  return result.changes > 0;
}

export function clearArtifactsByRoom(roomId: string): number {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM artifacts WHERE room_id = ?');
  const result = stmt.run(roomId);
  return result.changes;
}

export function renameArtifact(roomId: string, agentId: string, oldPath: string, newPath: string): ArtifactRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE artifacts
    SET path = ?, updated_at = datetime('now')
    WHERE room_id = ? AND agent_id = ? AND path = ?
    RETURNING *
  `);
  return stmt.get(newPath, roomId, agentId, oldPath) as ArtifactRow | undefined;
}

export function artifactExists(roomId: string, agentId: string, path: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare('SELECT 1 FROM artifacts WHERE room_id = ? AND agent_id = ? AND path = ?');
  return stmt.get(roomId, agentId, path) !== undefined;
}

// ==================== Utility ====================

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
