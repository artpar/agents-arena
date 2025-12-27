/**
 * Database Boundary
 *
 * Executes database effects. This is where actual I/O happens.
 *
 * BOUNDARY PRINCIPLE:
 * - Pure interpreters produce DatabaseEffect values
 * - This boundary executes them against the real database
 * - Results are returned as values for the runtime to route
 */

import Database from 'better-sqlite3';
import {
  DatabaseEffect,
  isDatabaseEffect,
  DbSaveMessage,
  DbLoadMessages,
  DbDeleteMessages,
  DbSaveAgent,
  DbLoadAgent,
  DbLoadAllAgents,
  DbUpdateAgentStats,
  DbSaveRoom,
  DbLoadRoom,
  DbSaveProject,
  DbSaveTask,
  DbUpdateTask
} from '../effects/database.js';
import { ChatMessage, createChatMessage } from '../values/message.js';
import { AgentConfig, createAgentConfig } from '../values/agent.js';
import { RoomConfig, createRoomConfig } from '../values/room.js';
import { ProjectState, Task } from '../values/project.js';
import { RoomId, AgentId, MessageId, ProjectId, TaskId, roomId, agentId, messageId, projectId, taskId, senderId } from '../values/ids.js';
import {
  EffectResult,
  EffectExecutor,
  successResult,
  failureResult,
  Logger
} from './types.js';
import { Effect } from '../effects/index.js';

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

/**
 * Database connection wrapper.
 */
export interface DatabaseConnection {
  readonly db: Database.Database;
  readonly path: string;
}

/**
 * Create and initialize database connection.
 */
export function createDatabaseConnection(path: string): DatabaseConnection {
  const db = new Database(path);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Initialize schema
  initializeSchema(db);

  return { db, path };
}

/**
 * Initialize database schema.
 */
function initializeSchema(db: Database.Database): void {
  db.exec(`
    -- Messages table
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'chat',
      timestamp INTEGER NOT NULL,
      reply_to TEXT,
      mentions TEXT NOT NULL DEFAULT '[]',
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

    -- Agents table
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_spoke_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    -- Rooms table
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    -- Projects table
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      room_id TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'idle',
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    -- Tasks table
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unassigned',
      assignee_id TEXT,
      assignee_name TEXT,
      task_data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);
}

/**
 * Close database connection.
 */
export function closeDatabaseConnection(conn: DatabaseConnection): void {
  conn.db.close();
}

// ============================================================================
// DATABASE EXECUTOR
// ============================================================================

/**
 * Create a database effect executor.
 */
export function createDatabaseExecutor(
  conn: DatabaseConnection,
  logger: Logger
): EffectExecutor {
  return {
    canHandle(effect: Effect): boolean {
      return isDatabaseEffect(effect);
    },

    async execute(effect: Effect): Promise<EffectResult> {
      if (!isDatabaseEffect(effect)) {
        return failureResult(effect, 'Not a database effect', 0);
      }

      const start = Date.now();

      try {
        const result = await executeDbEffect(conn, effect as DatabaseEffect, logger);
        return successResult(effect, result, Date.now() - start);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Database effect failed', { effect: effect.type, error });
        return failureResult(effect, error, Date.now() - start);
      }
    }
  };
}

/**
 * Execute a database effect.
 */
async function executeDbEffect(
  conn: DatabaseConnection,
  effect: DatabaseEffect,
  logger: Logger
): Promise<unknown> {
  switch (effect.type) {
    case 'DB_SAVE_MESSAGE':
      return saveMessage(conn, effect);

    case 'DB_LOAD_MESSAGES':
      return loadMessages(conn, effect);

    case 'DB_DELETE_MESSAGES':
      return deleteMessages(conn, effect);

    case 'DB_SAVE_AGENT':
      return saveAgent(conn, effect);

    case 'DB_LOAD_AGENT':
      return loadAgent(conn, effect);

    case 'DB_LOAD_ALL_AGENTS':
      return loadAllAgents(conn, effect);

    case 'DB_UPDATE_AGENT_STATS':
      return updateAgentStats(conn, effect);

    case 'DB_SAVE_ROOM':
      return saveRoom(conn, effect);

    case 'DB_LOAD_ROOM':
      return loadRoom(conn, effect);

    case 'DB_SAVE_PROJECT':
      return saveProject(conn, effect);

    case 'DB_SAVE_TASK':
      return saveTask(conn, effect);

    case 'DB_UPDATE_TASK':
      return updateTask(conn, effect);

    default:
      const _exhaustive: never = effect;
      throw new Error(`Unknown database effect type`);
  }
}

// ============================================================================
// EFFECT IMPLEMENTATIONS
// ============================================================================

function saveMessage(conn: DatabaseConnection, effect: DbSaveMessage): void {
  const { message } = effect;

  const stmt = conn.db.prepare(`
    INSERT OR REPLACE INTO messages
    (id, room_id, sender_id, sender_name, content, type, timestamp, reply_to, mentions, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    message.id,
    message.roomId,
    message.senderId,
    message.senderName,
    message.content,
    message.type,
    message.timestamp,
    message.replyTo,
    JSON.stringify(message.mentions),
    JSON.stringify(message.attachments)
  );
}

function loadMessages(
  conn: DatabaseConnection,
  effect: DbLoadMessages
): readonly ChatMessage[] {
  const { roomId: rid, limit, before } = effect;

  let sql = `
    SELECT * FROM messages
    WHERE room_id = ?
  `;
  const params: (string | number)[] = [rid];

  if (before !== undefined) {
    sql += ' AND timestamp < ?';
    params.push(before);
  }

  sql += ' ORDER BY timestamp DESC';

  if (limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const stmt = conn.db.prepare(sql);
  const rows = stmt.all(...params) as DatabaseMessageRow[];

  // Reverse to get chronological order
  return Object.freeze(rows.reverse().map(rowToMessage));
}

function deleteMessages(conn: DatabaseConnection, effect: DbDeleteMessages): number {
  const { roomId: rid } = effect;

  const stmt = conn.db.prepare('DELETE FROM messages WHERE room_id = ?');
  const result = stmt.run(rid);
  return result.changes;
}

function saveAgent(conn: DatabaseConnection, effect: DbSaveAgent): void {
  const { config } = effect;

  const stmt = conn.db.prepare(`
    INSERT OR REPLACE INTO agents (id, name, config, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(
    config.id,
    config.name,
    JSON.stringify(config),
    Date.now()
  );
}

function loadAgent(
  conn: DatabaseConnection,
  effect: DbLoadAgent
): AgentConfig | null {
  const { agentId: aid } = effect;

  const stmt = conn.db.prepare('SELECT * FROM agents WHERE id = ?');
  const row = stmt.get(aid) as DatabaseAgentRow | undefined;

  if (!row) return null;

  return rowToAgentConfig(row);
}

function loadAllAgents(
  conn: DatabaseConnection,
  _effect: DbLoadAllAgents
): readonly AgentConfig[] {
  const stmt = conn.db.prepare('SELECT * FROM agents ORDER BY name');
  const rows = stmt.all() as DatabaseAgentRow[];

  return Object.freeze(rows.map(rowToAgentConfig));
}

function updateAgentStats(
  conn: DatabaseConnection,
  effect: DbUpdateAgentStats
): void {
  const { agentId, messageCount, lastSpokeAt } = effect;

  const updates: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [Date.now()];

  if (messageCount !== undefined) {
    updates.push('message_count = ?');
    params.push(messageCount);
  }

  if (lastSpokeAt !== undefined) {
    updates.push('last_spoke_at = ?');
    params.push(lastSpokeAt);
  }

  params.push(agentId);

  const stmt = conn.db.prepare(`
    UPDATE agents SET ${updates.join(', ')} WHERE id = ?
  `);
  stmt.run(...params);
}

function saveRoom(conn: DatabaseConnection, effect: DbSaveRoom): void {
  const { config } = effect;

  const stmt = conn.db.prepare(`
    INSERT OR REPLACE INTO rooms (id, name, config, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(
    config.id,
    config.name,
    JSON.stringify(config),
    Date.now()
  );
}

function loadRoom(
  conn: DatabaseConnection,
  effect: DbLoadRoom
): RoomConfig | null {
  const { roomId: rid } = effect;

  const stmt = conn.db.prepare('SELECT * FROM rooms WHERE id = ?');
  const row = stmt.get(rid) as DatabaseRoomRow | undefined;

  if (!row) return null;

  return rowToRoomConfig(row);
}

function saveProject(conn: DatabaseConnection, effect: DbSaveProject): void {
  const { project } = effect;

  const stmt = conn.db.prepare(`
    INSERT OR REPLACE INTO projects (id, name, goal, room_id, phase, state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    project.id,
    project.name,
    project.goal,
    project.roomId,
    project.phase,
    JSON.stringify(project),
    Date.now()
  );
}

function saveTask(conn: DatabaseConnection, effect: DbSaveTask): void {
  const { projectId: pid, task } = effect;

  const stmt = conn.db.prepare(`
    INSERT OR REPLACE INTO tasks
    (id, project_id, title, description, priority, status, assignee_id, assignee_name, task_data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    task.id,
    pid,
    task.title,
    task.description,
    task.priority,
    task.status,
    task.assigneeId,
    task.assigneeName,
    JSON.stringify(task),
    Date.now()
  );
}

function updateTask(conn: DatabaseConnection, effect: DbUpdateTask): void {
  const { projectId: pid, task } = effect;

  const stmt = conn.db.prepare(`
    UPDATE tasks SET
      title = ?,
      description = ?,
      priority = ?,
      status = ?,
      assignee_id = ?,
      assignee_name = ?,
      task_data = ?,
      updated_at = ?
    WHERE id = ? AND project_id = ?
  `);

  stmt.run(
    task.title,
    task.description,
    task.priority,
    task.status,
    task.assigneeId,
    task.assigneeName,
    JSON.stringify(task),
    Date.now(),
    task.id,
    pid
  );
}

// ============================================================================
// ROW TYPES & CONVERTERS
// ============================================================================

interface DatabaseMessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  type: string;
  timestamp: number;
  reply_to: string | null;
  mentions: string;
  attachments: string;
}

interface DatabaseAgentRow {
  id: string;
  name: string;
  config: string;
  message_count: number;
  last_spoke_at: number | null;
}

interface DatabaseRoomRow {
  id: string;
  name: string;
  config: string;
}

function rowToMessage(row: DatabaseMessageRow): ChatMessage {
  return createChatMessage({
    id: messageId(row.id),
    roomId: roomId(row.room_id),
    senderId: senderId(row.sender_id),
    senderName: row.sender_name,
    content: row.content,
    type: row.type as 'chat' | 'system' | 'action' | 'join' | 'leave',
    timestamp: row.timestamp,
    replyTo: row.reply_to ? messageId(row.reply_to) : null,
    mentions: JSON.parse(row.mentions),
    attachments: JSON.parse(row.attachments)
  });
}

function rowToAgentConfig(row: DatabaseAgentRow): AgentConfig {
  const config = JSON.parse(row.config);
  return createAgentConfig({
    ...config,
    id: agentId(row.id)
  });
}

function rowToRoomConfig(row: DatabaseRoomRow): RoomConfig {
  const config = JSON.parse(row.config);
  return createRoomConfig({
    ...config,
    id: roomId(row.id)
  });
}
