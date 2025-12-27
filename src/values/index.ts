/**
 * Values Layer
 *
 * This module exports all immutable value types used throughout the system.
 *
 * PRINCIPLES:
 * - All types are immutable (readonly fields)
 * - State changes create new objects (no mutation)
 * - Pure functions for transformations and queries
 * - Branded types for compile-time safety
 *
 * USAGE:
 * ```typescript
 * import {
 *   // IDs
 *   RoomId, AgentId, roomId, agentId,
 *
 *   // Messages
 *   ChatMessage, createChatMessage,
 *
 *   // Agents
 *   AgentState, createAgentState, withStatus,
 *
 *   // Rooms
 *   RoomState, createRoomState, withMessage,
 *
 *   // Projects
 *   ProjectState, Task, createTask
 * } from './values/index.js';
 * ```
 */

// ============================================================================
// IDS
// ============================================================================

export {
  // Types
  type RoomId,
  type AgentId,
  type MessageId,
  type ProjectId,
  type TaskId,
  type UserId,
  type AttachmentId,
  type SenderId,

  // Constructors
  roomId,
  agentId,
  messageId,
  projectId,
  taskId,
  userId,
  attachmentId,

  // Generators
  generateRoomId,
  generateAgentId,
  generateMessageId,
  generateProjectId,
  generateTaskId,
  generateUserId,
  generateAttachmentId,

  // Type guards
  isRoomId,
  isAgentId,
  isMessageId,
  isProjectId,
  isTaskId,
  isSenderAgent,
  isSenderUser,
  isSenderSystem
} from './ids.js';

// ============================================================================
// MESSAGES
// ============================================================================

export {
  // Types
  type Attachment,
  type MessageType,
  type ChatMessage,
  type ConversationRole,
  type ConversationTurn,

  // Constructors
  createAttachment,
  createChatMessage,

  // Transformations
  withContent,
  withAttachment,
  withMentions,

  // Queries
  mentionsName,
  isFromAgent,
  isFromSystem,
  hasAttachments,
  isReply,

  // Conversions
  toConversationTurns,
  formatForDisplay,
  formatForContext
} from './message.js';

// ============================================================================
// AGENTS
// ============================================================================

export {
  // Types
  type AgentStatus,
  type PersonalityTraits,
  type ToolDefinition,
  type AgentConfig,
  type AgentState,

  // Constructors
  createPersonalityTraits,
  createAgentConfig,
  createAgentState,

  // State transformations
  withStatus,
  withRoom,
  withTask,
  withConversationTurn,
  withConversationHistory,
  clearConversation,
  incrementToolCalls,
  resetToolCalls,
  withArtifact,
  clearArtifacts,
  markSpoke,
  resetForNewTask,

  // Queries
  isBusy,
  isAvailable,
  hasExceededToolCalls,
  getDisplayInfo as getAgentDisplayInfo,

  // Model utilities
  MODEL_MAP,
  resolveModel
} from './agent.js';

// ============================================================================
// ROOMS
// ============================================================================

export {
  // Types
  type RoomPhase,
  type ScheduleMode,
  type RoomConfig,
  type RoomState,

  // Constructors
  createRoomConfig,
  createGeneralRoom,
  createRoomState,

  // State transformations
  withAgentJoined,
  withAgentLeft,
  withMessage,
  withUserMessage,
  withAgentResponded,
  withPhase as withRoomPhase,
  clearMessages,
  withLoadedMessages,
  resetRoom,

  // Queries
  hasAgents,
  hasAgent,
  isWaitingForResponses,
  pendingCount,
  getRecentMessages,
  getContextMessages,
  getDisplayInfo as getRoomDisplayInfo,

  // Agent selection
  selectResponders
} from './room.js';

// ============================================================================
// PROJECTS
// ============================================================================

export {
  // Types
  type ProjectPhase,
  type TaskStatus,
  type Artifact,
  type Task,
  type ProjectState,

  // Artifact constructors
  createArtifact,

  // Task constructors
  createTask,

  // Task transformations
  assignTask,
  startTask,
  completeTask,
  failTask,
  unassignTask,

  // Project constructors
  createProjectState,

  // Project state transformations
  withPhase as withProjectPhase,
  withTask as withProjectTask,
  withUpdatedTask,
  withActiveBuilder,
  withBuilderCompleted,
  incrementTurn,
  resetBuilders,

  // Project queries
  getTask,
  getUnassignedTasks,
  getAgentTasks,
  getInProgressTasks,
  getCompletedTasks,
  getFailedTasks,
  allTasksDone,
  hasExceededMaxTurns,
  isActive,
  getProgress,
  getDisplayInfo as getProjectDisplayInfo,
  getAllArtifacts
} from './project.js';
