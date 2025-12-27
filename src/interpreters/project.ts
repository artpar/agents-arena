/**
 * Project Interpreter
 *
 * Pure function that handles project messages and returns new state + effects.
 *
 * (ProjectState, ProjectMessage) → [ProjectState, Effect[]]
 *
 * NO side effects. NO I/O. Just logic.
 */

import { Effect } from '../effects/index.js';
import {
  dbSaveProject,
  dbSaveTask,
  dbUpdateTask
} from '../effects/database.js';
import {
  broadcastToRoom,
  phaseChanged,
  taskUpdated,
  systemNotification
} from '../effects/broadcast.js';
import {
  sendToAgent,
  sendToRoom,
  ActorMessage
} from '../effects/actor.js';
import {
  ProjectState,
  ProjectPhase,
  Task,
  TaskStatus,
  createProjectState,
  createTask,
  withPhase,
  withTask,
  withUpdatedTask,
  withActiveBuilder,
  withBuilderCompleted,
  incrementTurn,
  resetBuilders,
  getTask,
  getUnassignedTasks,
  getInProgressTasks,
  allTasksDone,
  hasExceededMaxTurns,
  assignTask,
  startTask as startTaskValue,
  completeTask as completeTaskValue,
  failTask
} from '../values/project.js';
import { AgentId, TaskId, RoomId, ProjectId } from '../values/ids.js';
import {
  Interpreter,
  noChange,
  stateOnly,
  stateAndEffects
} from './types.js';

// ============================================================================
// PROJECT MESSAGES
// ============================================================================

/**
 * Start the project.
 */
export interface StartProjectMsg {
  readonly type: 'START_PROJECT';
}

/**
 * Add a task to the project.
 */
export interface AddTaskMsg {
  readonly type: 'ADD_TASK';
  readonly title: string;
  readonly description: string;
  readonly priority?: number;
}

/**
 * Assign a task to an agent.
 */
export interface AssignTaskMsg {
  readonly type: 'ASSIGN_TASK';
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly agentName: string;
}

/**
 * Agent started working on a task.
 */
export interface TaskStartedMsg {
  readonly type: 'TASK_STARTED';
  readonly taskId: TaskId;
  readonly agentId: AgentId;
}

/**
 * Agent completed a task.
 */
export interface TaskCompletedMsg {
  readonly type: 'TASK_COMPLETED';
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly artifacts: readonly string[];
}

/**
 * Task failed.
 */
export interface TaskFailedMsg {
  readonly type: 'TASK_FAILED';
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly error: string;
}

/**
 * Set project phase.
 */
export interface SetPhaseMsg {
  readonly type: 'SET_PHASE';
  readonly phase: ProjectPhase;
}

/**
 * Tick for turn-based execution.
 */
export interface ProjectTickMsg {
  readonly type: 'PROJECT_TICK';
  readonly timestamp: number;
}

/**
 * Agent turn completed.
 */
export interface AgentTurnCompleteMsg {
  readonly type: 'AGENT_TURN_COMPLETE';
  readonly agentId: AgentId;
}

/**
 * Cancel the project.
 */
export interface CancelProjectMsg {
  readonly type: 'CANCEL_PROJECT';
  readonly reason: string;
}

/**
 * Reset project state.
 */
export interface ResetProjectMsg {
  readonly type: 'RESET_PROJECT';
}

/**
 * All tasks have been defined, transition to building.
 */
export interface PlanningCompleteMsg {
  readonly type: 'PLANNING_COMPLETE';
}

/**
 * Union of all project messages.
 */
export type ProjectMessage =
  | StartProjectMsg
  | AddTaskMsg
  | AssignTaskMsg
  | TaskStartedMsg
  | TaskCompletedMsg
  | TaskFailedMsg
  | SetPhaseMsg
  | ProjectTickMsg
  | AgentTurnCompleteMsg
  | CancelProjectMsg
  | ResetProjectMsg
  | PlanningCompleteMsg;

// ============================================================================
// MESSAGE CONSTRUCTORS
// ============================================================================

export function startProject(): StartProjectMsg {
  return Object.freeze({ type: 'START_PROJECT' });
}

export function addTask(
  title: string,
  description: string,
  priority?: number
): AddTaskMsg {
  return Object.freeze({ type: 'ADD_TASK', title, description, priority });
}

export function assignTaskMsg(
  taskId: TaskId,
  agentId: AgentId,
  agentName: string
): AssignTaskMsg {
  return Object.freeze({ type: 'ASSIGN_TASK', taskId, agentId, agentName });
}

export function taskStarted(taskId: TaskId, agentId: AgentId): TaskStartedMsg {
  return Object.freeze({ type: 'TASK_STARTED', taskId, agentId });
}

export function taskCompleted(
  taskId: TaskId,
  agentId: AgentId,
  artifacts: readonly string[]
): TaskCompletedMsg {
  return Object.freeze({ type: 'TASK_COMPLETED', taskId, agentId, artifacts });
}

export function taskFailed(
  taskId: TaskId,
  agentId: AgentId,
  error: string
): TaskFailedMsg {
  return Object.freeze({ type: 'TASK_FAILED', taskId, agentId, error });
}

export function setPhase(phase: ProjectPhase): SetPhaseMsg {
  return Object.freeze({ type: 'SET_PHASE', phase });
}

export function projectTick(timestamp: number): ProjectTickMsg {
  return Object.freeze({ type: 'PROJECT_TICK', timestamp });
}

export function agentTurnComplete(agentId: AgentId): AgentTurnCompleteMsg {
  return Object.freeze({ type: 'AGENT_TURN_COMPLETE', agentId });
}

export function cancelProject(reason: string): CancelProjectMsg {
  return Object.freeze({ type: 'CANCEL_PROJECT', reason });
}

export function resetProject(): ResetProjectMsg {
  return Object.freeze({ type: 'RESET_PROJECT' });
}

export function planningComplete(): PlanningCompleteMsg {
  return Object.freeze({ type: 'PLANNING_COMPLETE' });
}

// ============================================================================
// AGENT MESSAGES (What we send to agents)
// ============================================================================

export interface WorkOnTaskMsg extends ActorMessage {
  readonly type: 'WORK_ON_TASK';
  readonly projectId: ProjectId;
  readonly task: Task;
  readonly roomId: RoomId;
}

export function workOnTask(
  projectId: ProjectId,
  task: Task,
  roomId: RoomId
): WorkOnTaskMsg {
  return Object.freeze({ type: 'WORK_ON_TASK', projectId, task, roomId });
}

// ============================================================================
// PROJECT INTERPRETER
// ============================================================================

/**
 * Pure project interpreter.
 *
 * Takes current project state and a message, returns new state and effects.
 */
export const projectInterpreter: Interpreter<ProjectState, ProjectMessage> = (
  state: ProjectState,
  message: ProjectMessage
): readonly [ProjectState, readonly Effect[]] => {
  switch (message.type) {
    case 'START_PROJECT':
      return handleStartProject(state);

    case 'ADD_TASK':
      return handleAddTask(state, message);

    case 'ASSIGN_TASK':
      return handleAssignTask(state, message);

    case 'TASK_STARTED':
      return handleTaskStarted(state, message);

    case 'TASK_COMPLETED':
      return handleTaskCompleted(state, message);

    case 'TASK_FAILED':
      return handleTaskFailed(state, message);

    case 'SET_PHASE':
      return handleSetPhase(state, message);

    case 'PROJECT_TICK':
      return handleProjectTick(state, message);

    case 'AGENT_TURN_COMPLETE':
      return handleAgentTurnComplete(state, message);

    case 'CANCEL_PROJECT':
      return handleCancelProject(state, message);

    case 'RESET_PROJECT':
      return handleResetProject(state);

    case 'PLANNING_COMPLETE':
      return handlePlanningComplete(state);

    default:
      const _exhaustive: never = message;
      return noChange(state);
  }
};

// ============================================================================
// MESSAGE HANDLERS (Pure functions)
// ============================================================================

function handleStartProject(
  state: ProjectState
): readonly [ProjectState, readonly Effect[]] {
  // Transition to planning phase
  const newState = withPhase(state, 'planning');

  const effects: Effect[] = [
    dbSaveProject(newState),
    broadcastToRoom(state.roomId, phaseChanged(state.id, 'planning')),
    broadcastToRoom(state.roomId, systemNotification(
      `Project "${state.name}" started. Phase: Planning`,
      'info'
    ))
  ];

  return [newState, Object.freeze(effects)];
}

function handleAddTask(
  state: ProjectState,
  msg: AddTaskMsg
): readonly [ProjectState, readonly Effect[]] {
  const task = createTask({
    title: msg.title,
    description: msg.description,
    priority: msg.priority
  });

  const newState = withTask(state, task);

  const effects: Effect[] = [
    dbSaveTask(state.id, task),
    broadcastToRoom(state.roomId, taskUpdated(state.id, task))
  ];

  return [newState, Object.freeze(effects)];
}

function handleAssignTask(
  state: ProjectState,
  msg: AssignTaskMsg
): readonly [ProjectState, readonly Effect[]] {
  const task = getTask(state, msg.taskId);
  if (!task) {
    return noChange(state);
  }

  const updatedTask = assignTask(task, msg.agentId, msg.agentName);
  const newState = withUpdatedTask(state, updatedTask);

  const effects: Effect[] = [
    dbUpdateTask(state.id, updatedTask),
    broadcastToRoom(state.roomId, taskUpdated(state.id, updatedTask))
  ];

  return [newState, Object.freeze(effects)];
}

function handleTaskStarted(
  state: ProjectState,
  msg: TaskStartedMsg
): readonly [ProjectState, readonly Effect[]] {
  const task = getTask(state, msg.taskId);
  if (!task) {
    return noChange(state);
  }

  const updatedTask = startTaskValue(task);
  let newState = withUpdatedTask(state, updatedTask);
  newState = withActiveBuilder(newState, msg.agentId);

  const effects: Effect[] = [
    dbUpdateTask(state.id, updatedTask),
    broadcastToRoom(state.roomId, taskUpdated(state.id, updatedTask))
  ];

  return [newState, Object.freeze(effects)];
}

function handleTaskCompleted(
  state: ProjectState,
  msg: TaskCompletedMsg
): readonly [ProjectState, readonly Effect[]] {
  const task = getTask(state, msg.taskId);
  if (!task) {
    return noChange(state);
  }

  const updatedTask = completeTaskValue(task, msg.artifacts);
  let newState = withUpdatedTask(state, updatedTask);
  newState = withBuilderCompleted(newState, msg.agentId);

  const effects: Effect[] = [
    dbUpdateTask(state.id, updatedTask),
    broadcastToRoom(state.roomId, taskUpdated(state.id, updatedTask))
  ];

  // Check if all tasks are done
  if (allTasksDone(newState)) {
    newState = withPhase(newState, 'reviewing');
    effects.push(
      broadcastToRoom(state.roomId, phaseChanged(state.id, 'reviewing')),
      broadcastToRoom(state.roomId, systemNotification(
        'All tasks completed. Moving to review phase.',
        'info'
      ))
    );
  }

  return [newState, Object.freeze(effects)];
}

function handleTaskFailed(
  state: ProjectState,
  msg: TaskFailedMsg
): readonly [ProjectState, readonly Effect[]] {
  const task = getTask(state, msg.taskId);
  if (!task) {
    return noChange(state);
  }

  const updatedTask = failTask(task, msg.error);
  let newState = withUpdatedTask(state, updatedTask);
  newState = withBuilderCompleted(newState, msg.agentId);

  const effects: Effect[] = [
    dbUpdateTask(state.id, updatedTask),
    broadcastToRoom(state.roomId, taskUpdated(state.id, updatedTask)),
    broadcastToRoom(state.roomId, systemNotification(
      `Task "${task.title}" failed: ${msg.error}`,
      'error'
    ))
  ];

  return [newState, Object.freeze(effects)];
}

function handleSetPhase(
  state: ProjectState,
  msg: SetPhaseMsg
): readonly [ProjectState, readonly Effect[]] {
  const newState = withPhase(state, msg.phase);

  const effects: Effect[] = [
    dbSaveProject(newState),
    broadcastToRoom(state.roomId, phaseChanged(state.id, msg.phase))
  ];

  return [newState, Object.freeze(effects)];
}

function handleProjectTick(
  state: ProjectState,
  _msg: ProjectTickMsg
): readonly [ProjectState, readonly Effect[]] {
  // Check if we've exceeded max turns
  if (hasExceededMaxTurns(state)) {
    const newState = withPhase(state, 'done');
    const effects: Effect[] = [
      broadcastToRoom(state.roomId, phaseChanged(state.id, 'done')),
      broadcastToRoom(state.roomId, systemNotification(
        `Project reached max turns (${state.maxTurns}). Completing.`,
        'warning'
      ))
    ];
    return [newState, Object.freeze(effects)];
  }

  // If in building phase and no active builders, start next round
  if (state.phase === 'building' && state.activeBuilders.length === 0) {
    return startBuildRound(state);
  }

  return noChange(state);
}

function handleAgentTurnComplete(
  state: ProjectState,
  msg: AgentTurnCompleteMsg
): readonly [ProjectState, readonly Effect[]] {
  const newState = withBuilderCompleted(state, msg.agentId);

  // If all builders done, increment turn and check for more work
  if (newState.activeBuilders.length === 0) {
    const withTurn = incrementTurn(newState);

    // Check if done
    if (allTasksDone(withTurn)) {
      const doneState = withPhase(withTurn, 'reviewing');
      const effects: Effect[] = [
        broadcastToRoom(state.roomId, phaseChanged(state.id, 'reviewing'))
      ];
      return [doneState, Object.freeze(effects)];
    }

    // Start next round
    return startBuildRound(withTurn);
  }

  return stateOnly(newState);
}

function handleCancelProject(
  state: ProjectState,
  msg: CancelProjectMsg
): readonly [ProjectState, readonly Effect[]] {
  const newState = withPhase(state, 'done');

  const effects: Effect[] = [
    dbSaveProject(newState),
    broadcastToRoom(state.roomId, phaseChanged(state.id, 'done')),
    broadcastToRoom(state.roomId, systemNotification(
      `Project cancelled: ${msg.reason}`,
      'warning'
    ))
  ];

  return [newState, Object.freeze(effects)];
}

function handleResetProject(
  state: ProjectState
): readonly [ProjectState, readonly Effect[]] {
  const newState = createProjectState({
    name: state.name,
    goal: state.goal,
    roomId: state.roomId,
    maxTurns: state.maxTurns,
    id: state.id
  });

  const effects: Effect[] = [
    dbSaveProject(newState),
    broadcastToRoom(state.roomId, phaseChanged(state.id, 'idle')),
    broadcastToRoom(state.roomId, systemNotification('Project reset', 'info'))
  ];

  return [newState, Object.freeze(effects)];
}

function handlePlanningComplete(
  state: ProjectState
): readonly [ProjectState, readonly Effect[]] {
  if (state.tasks.length === 0) {
    // No tasks defined, go back to idle
    const effects: Effect[] = [
      broadcastToRoom(state.roomId, systemNotification(
        'No tasks defined. Please add tasks before building.',
        'warning'
      ))
    ];
    return [state, Object.freeze(effects)];
  }

  // Transition to building
  const newState = withPhase(state, 'building');

  const effects: Effect[] = [
    dbSaveProject(newState),
    broadcastToRoom(state.roomId, phaseChanged(state.id, 'building')),
    broadcastToRoom(state.roomId, systemNotification(
      `Planning complete. ${state.tasks.length} tasks defined. Starting build phase.`,
      'info'
    ))
  ];

  return [newState, Object.freeze(effects)];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Start a new build round - assign unassigned tasks to available agents.
 * This is a placeholder - actual agent selection logic would be here.
 */
function startBuildRound(
  state: ProjectState
): readonly [ProjectState, readonly Effect[]] {
  const unassigned = getUnassignedTasks(state);
  const inProgress = getInProgressTasks(state);

  // If nothing to do, we're done
  if (unassigned.length === 0 && inProgress.length === 0) {
    if (allTasksDone(state)) {
      const newState = withPhase(state, 'reviewing');
      const effects: Effect[] = [
        broadcastToRoom(state.roomId, phaseChanged(state.id, 'reviewing'))
      ];
      return [newState, Object.freeze(effects)];
    }
  }

  // Just return state - task assignment would be triggered by director
  return [resetBuilders(state), []];
}

export default projectInterpreter;
