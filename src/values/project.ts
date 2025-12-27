/**
 * Project Values
 *
 * Immutable data structures for collaborative projects and tasks.
 * All fields are readonly - state changes create new objects.
 */

import { ProjectId, TaskId, AgentId, RoomId, generateProjectId, generateTaskId } from './ids.js';

// ============================================================================
// PROJECT PHASE
// ============================================================================

export type ProjectPhase =
  | 'idle'      // Not started
  | 'planning'  // Breaking down tasks
  | 'building'  // Agents working on tasks
  | 'reviewing' // Reviewing completed work
  | 'done';     // Project complete

// ============================================================================
// TASK STATUS
// ============================================================================

export type TaskStatus =
  | 'unassigned'  // No agent assigned
  | 'assigned'    // Agent assigned but not started
  | 'in_progress' // Agent actively working
  | 'done'        // Task completed
  | 'failed';     // Task failed

// ============================================================================
// ARTIFACT
// ============================================================================

export interface Artifact {
  readonly id: string;
  readonly path: string;
  readonly content: string;
  readonly createdBy: AgentId;
  readonly createdByName: string;
  readonly createdAt: number;
}

/**
 * Create a new Artifact value.
 */
export function createArtifact(params: {
  path: string;
  content: string;
  createdBy: AgentId;
  createdByName: string;
  id?: string;
}): Artifact {
  return Object.freeze({
    id: params.id ?? `artifact_${Date.now()}`,
    path: params.path,
    content: params.content,
    createdBy: params.createdBy,
    createdByName: params.createdByName,
    createdAt: Date.now()
  });
}

// ============================================================================
// TASK
// ============================================================================

export interface Task {
  readonly id: TaskId;
  readonly title: string;
  readonly description: string;
  readonly priority: number;  // Lower = higher priority
  readonly status: TaskStatus;
  readonly assigneeId: AgentId | null;
  readonly assigneeName: string | null;
  readonly artifacts: readonly string[];  // File paths
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly error: string | null;
}

/**
 * Create a new Task value.
 */
export function createTask(params: {
  title: string;
  description: string;
  priority?: number;
  id?: TaskId;
}): Task {
  return Object.freeze({
    id: params.id ?? generateTaskId(),
    title: params.title,
    description: params.description,
    priority: params.priority ?? 0,
    status: 'unassigned',
    assigneeId: null,
    assigneeName: null,
    artifacts: Object.freeze([]),
    startedAt: null,
    completedAt: null,
    error: null
  });
}

// ============================================================================
// TASK TRANSFORMATIONS (Pure functions)
// ============================================================================

/**
 * Assign task to an agent.
 */
export function assignTask(
  task: Task,
  agentId: AgentId,
  agentName: string
): Task {
  return Object.freeze({
    ...task,
    status: 'assigned',
    assigneeId: agentId,
    assigneeName: agentName
  });
}

/**
 * Mark task as in progress.
 */
export function startTask(task: Task): Task {
  return Object.freeze({
    ...task,
    status: 'in_progress',
    startedAt: Date.now()
  });
}

/**
 * Mark task as completed with artifacts.
 */
export function completeTask(task: Task, artifacts: readonly string[]): Task {
  return Object.freeze({
    ...task,
    status: 'done',
    artifacts: Object.freeze([...artifacts]),
    completedAt: Date.now(),
    error: null
  });
}

/**
 * Mark task as failed.
 */
export function failTask(task: Task, error: string): Task {
  return Object.freeze({
    ...task,
    status: 'failed',
    completedAt: Date.now(),
    error
  });
}

/**
 * Unassign a task.
 */
export function unassignTask(task: Task): Task {
  return Object.freeze({
    ...task,
    status: 'unassigned',
    assigneeId: null,
    assigneeName: null,
    startedAt: null
  });
}

// ============================================================================
// PROJECT STATE
// ============================================================================

export interface ProjectState {
  readonly id: ProjectId;
  readonly name: string;
  readonly goal: string;
  readonly roomId: RoomId;
  readonly phase: ProjectPhase;
  readonly tasks: readonly Task[];
  readonly activeBuilders: readonly AgentId[];
  readonly completedBuilders: readonly AgentId[];
  readonly turnCount: number;
  readonly maxTurns: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

/**
 * Create initial project state.
 */
export function createProjectState(params: {
  name: string;
  goal: string;
  roomId: RoomId;
  maxTurns?: number;
  id?: ProjectId;
}): ProjectState {
  return Object.freeze({
    id: params.id ?? generateProjectId(),
    name: params.name,
    goal: params.goal,
    roomId: params.roomId,
    phase: 'idle',
    tasks: Object.freeze([]),
    activeBuilders: Object.freeze([]),
    completedBuilders: Object.freeze([]),
    turnCount: 0,
    maxTurns: params.maxTurns ?? 10,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null
  });
}

// ============================================================================
// PROJECT STATE TRANSFORMATIONS (Pure functions)
// ============================================================================

/**
 * Set project phase.
 */
export function withPhase(state: ProjectState, phase: ProjectPhase): ProjectState {
  const now = Date.now();
  const startedAt = phase === 'planning' && state.startedAt === null
    ? now
    : state.startedAt;
  const completedAt = phase === 'done' && state.completedAt === null
    ? now
    : state.completedAt;

  return Object.freeze({
    ...state,
    phase,
    startedAt,
    completedAt
  });
}

/**
 * Add a task to the project.
 */
export function withTask(state: ProjectState, task: Task): ProjectState {
  return Object.freeze({
    ...state,
    tasks: Object.freeze([...state.tasks, task])
  });
}

/**
 * Update a task in the project.
 */
export function withUpdatedTask(state: ProjectState, updatedTask: Task): ProjectState {
  const newTasks = state.tasks.map(t =>
    t.id === updatedTask.id ? updatedTask : t
  );
  return Object.freeze({
    ...state,
    tasks: Object.freeze(newTasks)
  });
}

/**
 * Add an active builder.
 */
export function withActiveBuilder(state: ProjectState, agentId: AgentId): ProjectState {
  if (state.activeBuilders.includes(agentId)) {
    return state;
  }
  return Object.freeze({
    ...state,
    activeBuilders: Object.freeze([...state.activeBuilders, agentId])
  });
}

/**
 * Move builder from active to completed.
 */
export function withBuilderCompleted(state: ProjectState, agentId: AgentId): ProjectState {
  return Object.freeze({
    ...state,
    activeBuilders: Object.freeze(state.activeBuilders.filter(id => id !== agentId)),
    completedBuilders: Object.freeze(
      state.completedBuilders.includes(agentId)
        ? state.completedBuilders
        : [...state.completedBuilders, agentId]
    )
  });
}

/**
 * Increment turn count.
 */
export function incrementTurn(state: ProjectState): ProjectState {
  return Object.freeze({
    ...state,
    turnCount: state.turnCount + 1
  });
}

/**
 * Reset for new project round.
 */
export function resetBuilders(state: ProjectState): ProjectState {
  return Object.freeze({
    ...state,
    activeBuilders: Object.freeze([]),
    completedBuilders: Object.freeze([])
  });
}

// ============================================================================
// PROJECT QUERIES (Pure functions)
// ============================================================================

/**
 * Get task by ID.
 */
export function getTask(state: ProjectState, taskId: TaskId): Task | undefined {
  return state.tasks.find(t => t.id === taskId);
}

/**
 * Get unassigned tasks.
 */
export function getUnassignedTasks(state: ProjectState): readonly Task[] {
  return state.tasks.filter(t => t.status === 'unassigned');
}

/**
 * Get tasks assigned to an agent.
 */
export function getAgentTasks(state: ProjectState, agentId: AgentId): readonly Task[] {
  return state.tasks.filter(t => t.assigneeId === agentId);
}

/**
 * Get in-progress tasks.
 */
export function getInProgressTasks(state: ProjectState): readonly Task[] {
  return state.tasks.filter(t => t.status === 'in_progress');
}

/**
 * Get completed tasks.
 */
export function getCompletedTasks(state: ProjectState): readonly Task[] {
  return state.tasks.filter(t => t.status === 'done');
}

/**
 * Get failed tasks.
 */
export function getFailedTasks(state: ProjectState): readonly Task[] {
  return state.tasks.filter(t => t.status === 'failed');
}

/**
 * Check if all tasks are done.
 */
export function allTasksDone(state: ProjectState): boolean {
  return state.tasks.length > 0 &&
         state.tasks.every(t => t.status === 'done' || t.status === 'failed');
}

/**
 * Check if project has exceeded max turns.
 */
export function hasExceededMaxTurns(state: ProjectState): boolean {
  return state.turnCount >= state.maxTurns;
}

/**
 * Check if project is active.
 */
export function isActive(state: ProjectState): boolean {
  return state.phase !== 'idle' && state.phase !== 'done';
}

/**
 * Get project progress percentage.
 */
export function getProgress(state: ProjectState): number {
  if (state.tasks.length === 0) return 0;
  const done = state.tasks.filter(t => t.status === 'done').length;
  return Math.round((done / state.tasks.length) * 100);
}

/**
 * Get project display info.
 */
export function getDisplayInfo(state: ProjectState): {
  id: ProjectId;
  name: string;
  phase: ProjectPhase;
  taskCount: number;
  completedCount: number;
  progress: number;
  turnCount: number;
  maxTurns: number;
} {
  return {
    id: state.id,
    name: state.name,
    phase: state.phase,
    taskCount: state.tasks.length,
    completedCount: getCompletedTasks(state).length,
    progress: getProgress(state),
    turnCount: state.turnCount,
    maxTurns: state.maxTurns
  };
}

/**
 * Get all artifacts from completed tasks.
 */
export function getAllArtifacts(state: ProjectState): readonly string[] {
  return Object.freeze(
    state.tasks
      .filter(t => t.status === 'done')
      .flatMap(t => t.artifacts)
  );
}
