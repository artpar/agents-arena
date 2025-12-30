/**
 * Director Interpreter
 *
 * Pure function that handles director messages and returns new state + effects.
 *
 * The Director is the top-level coordinator that:
 * - Manages room lifecycle
 * - Manages agent lifecycle
 * - Manages project lifecycle
 * - Routes messages between actors
 *
 * (DirectorState, DirectorMessage) → [DirectorState, Effect[]]
 *
 * NO side effects. NO I/O. Just logic.
 */

import { Effect } from '../effects/index.js';
import {
  dbSaveRoom,
  dbSaveAgent,
  dbLoadAllAgents
} from '../effects/database.js';
import {
  broadcastToAll,
  broadcastToRoom,
  systemNotification
} from '../effects/broadcast.js';
import {
  sendToRoom,
  sendToAgent,
  sendToProject,
  spawnRoomActor,
  spawnAgentActor,
  spawnProjectActor,
  stopActor,
  roomAddress,
  agentAddress,
  projectAddress
} from '../effects/actor.js';
import { RoomConfig, createRoomConfig, createGeneralRoom } from '../values/room.js';
import { AgentConfig, createAgentConfig } from '../values/agent.js';
import { ProjectId, RoomId, AgentId, generateProjectId } from '../values/ids.js';
import { agentJoinedMsg, agentLeftMsg, userMessage as userMessageMsg, setScheduleMode } from './room.js';
import { joinRoom, leaveRoom } from './agent.js';
import { startProject, addTask, assignTaskMsg, workOnTask } from './project.js';
import {
  Interpreter,
  noChange,
  stateOnly,
  stateAndEffects
} from './types.js';

// ============================================================================
// DIRECTOR STATE
// ============================================================================

/**
 * Director state tracks all active rooms, agents, and projects.
 */
export interface DirectorState {
  readonly rooms: Readonly<Record<string, RoomConfig>>;
  readonly agents: Readonly<Record<string, AgentConfig>>;
  readonly projects: Readonly<Record<string, ProjectInfo>>;
  readonly agentRooms: Readonly<Record<string, RoomId>>; // agentId -> roomId
  readonly initialized: boolean;
  readonly running: boolean;
  readonly mode: string;
  readonly maxTurns: number;
  readonly currentRoom: RoomId | null;
}

/**
 * Minimal project info tracked by director.
 */
export interface ProjectInfo {
  readonly id: ProjectId;
  readonly name: string;
  readonly roomId: RoomId;
  readonly isActive: boolean;
}

/**
 * Create initial director state.
 */
export function createDirectorState(): DirectorState {
  return Object.freeze({
    rooms: Object.freeze({}),
    agents: Object.freeze({}),
    projects: Object.freeze({}),
    agentRooms: Object.freeze({}),
    initialized: false,
    running: false,
    mode: 'hybrid',
    maxTurns: 20,
    currentRoom: null
  });
}

// ============================================================================
// DIRECTOR MESSAGES
// ============================================================================

/**
 * Initialize the director.
 */
export interface InitDirectorMsg {
  readonly type: 'INIT_DIRECTOR';
}

/**
 * Create a new room.
 */
export interface CreateRoomMsg {
  readonly type: 'CREATE_ROOM';
  readonly config: RoomConfig;
}

/**
 * Delete a room.
 */
export interface DeleteRoomMsg {
  readonly type: 'DELETE_ROOM';
  readonly roomId: RoomId;
}

/**
 * Register an agent.
 */
export interface RegisterAgentMsg {
  readonly type: 'REGISTER_AGENT';
  readonly config: AgentConfig;
}

/**
 * Unregister an agent.
 */
export interface UnregisterAgentMsg {
  readonly type: 'UNREGISTER_AGENT';
  readonly agentId: AgentId;
}

/**
 * Move agent to a room.
 */
export interface MoveAgentToRoomMsg {
  readonly type: 'MOVE_AGENT_TO_ROOM';
  readonly agentId: AgentId;
  readonly roomId: RoomId;
}

/**
 * Remove agent from their current room.
 */
export interface RemoveAgentFromRoomMsg {
  readonly type: 'REMOVE_AGENT_FROM_ROOM';
  readonly agentId: AgentId;
}

/**
 * Start a new project.
 */
export interface StartNewProjectMsg {
  readonly type: 'START_NEW_PROJECT';
  readonly name: string;
  readonly goal: string;
  readonly roomId: RoomId;
  readonly maxTurns?: number;
}

/**
 * Stop a project.
 */
export interface StopProjectMsg {
  readonly type: 'STOP_PROJECT';
  readonly projectId: ProjectId;
}

/**
 * Agents loaded from database.
 */
export interface AgentsLoadedMsg {
  readonly type: 'AGENTS_LOADED';
  readonly agents: readonly AgentConfig[];
}

/**
 * Rooms loaded from database.
 */
export interface RoomsLoadedMsg {
  readonly type: 'ROOMS_LOADED';
  readonly rooms: readonly RoomConfig[];
}

/**
 * Get system status.
 */
export interface GetStatusMsg {
  readonly type: 'GET_STATUS';
  readonly replyTag: string;
}

/**
 * Inject a human message into the system.
 */
export interface InjectMessageMsg {
  readonly type: 'INJECT_MESSAGE';
  readonly message: import('../values/message.js').ChatMessage;
}

/**
 * Start the conversation.
 */
export interface StartMsg {
  readonly type: 'START';
  readonly mode: string;
  readonly maxTurns: number;
}

/**
 * Stop the conversation.
 */
export interface StopMsg {
  readonly type: 'STOP';
}

/**
 * Set the conversation mode.
 */
export interface SetModeMsg {
  readonly type: 'SET_MODE';
  readonly mode: string;
}

/**
 * Spawn a new agent (alias for REGISTER_AGENT).
 */
export interface SpawnAgentMsg {
  readonly type: 'SPAWN_AGENT';
  readonly config: AgentConfig;
}

/**
 * Stop an agent (alias for UNREGISTER_AGENT).
 */
export interface StopAgentMsg {
  readonly type: 'STOP_AGENT';
  readonly agentId: AgentId;
}

/**
 * Join a room (creates if needed, joins agent).
 */
export interface JoinRoomMsg {
  readonly type: 'JOIN_ROOM';
  readonly roomId: RoomId;
  readonly roomName: string;
}

/**
 * Union of all director messages.
 */
export type DirectorMessage =
  | InitDirectorMsg
  | CreateRoomMsg
  | DeleteRoomMsg
  | RegisterAgentMsg
  | UnregisterAgentMsg
  | MoveAgentToRoomMsg
  | RemoveAgentFromRoomMsg
  | StartNewProjectMsg
  | StopProjectMsg
  | AgentsLoadedMsg
  | RoomsLoadedMsg
  | GetStatusMsg
  | InjectMessageMsg
  | StartMsg
  | StopMsg
  | SetModeMsg
  | SpawnAgentMsg
  | StopAgentMsg
  | JoinRoomMsg;

// ============================================================================
// MESSAGE CONSTRUCTORS
// ============================================================================

export function initDirector(): InitDirectorMsg {
  return Object.freeze({ type: 'INIT_DIRECTOR' });
}

export function createRoom(config: RoomConfig): CreateRoomMsg {
  return Object.freeze({ type: 'CREATE_ROOM', config });
}

export function deleteRoom(roomId: RoomId): DeleteRoomMsg {
  return Object.freeze({ type: 'DELETE_ROOM', roomId });
}

export function registerAgent(config: AgentConfig): RegisterAgentMsg {
  return Object.freeze({ type: 'REGISTER_AGENT', config });
}

export function unregisterAgent(agentId: AgentId): UnregisterAgentMsg {
  return Object.freeze({ type: 'UNREGISTER_AGENT', agentId });
}

export function moveAgentToRoom(agentId: AgentId, roomId: RoomId): MoveAgentToRoomMsg {
  return Object.freeze({ type: 'MOVE_AGENT_TO_ROOM', agentId, roomId });
}

export function removeAgentFromRoom(agentId: AgentId): RemoveAgentFromRoomMsg {
  return Object.freeze({ type: 'REMOVE_AGENT_FROM_ROOM', agentId });
}

export function startNewProject(
  name: string,
  goal: string,
  roomId: RoomId,
  maxTurns?: number
): StartNewProjectMsg {
  return Object.freeze({ type: 'START_NEW_PROJECT', name, goal, roomId, maxTurns });
}

export function stopProject(projectId: ProjectId): StopProjectMsg {
  return Object.freeze({ type: 'STOP_PROJECT', projectId });
}

export function agentsLoaded(agents: readonly AgentConfig[]): AgentsLoadedMsg {
  return Object.freeze({ type: 'AGENTS_LOADED', agents });
}

export function roomsLoaded(rooms: readonly RoomConfig[]): RoomsLoadedMsg {
  return Object.freeze({ type: 'ROOMS_LOADED', rooms });
}

export function getStatus(replyTag: string): GetStatusMsg {
  return Object.freeze({ type: 'GET_STATUS', replyTag });
}

// ============================================================================
// DIRECTOR INTERPRETER
// ============================================================================

/**
 * Pure director interpreter.
 *
 * Takes current director state and a message, returns new state and effects.
 */
export const directorInterpreter: Interpreter<DirectorState, DirectorMessage> = (
  state: DirectorState,
  message: DirectorMessage
): readonly [DirectorState, readonly Effect[]] => {
  switch (message.type) {
    case 'INIT_DIRECTOR':
      return handleInitDirector(state);

    case 'CREATE_ROOM':
      return handleCreateRoom(state, message);

    case 'DELETE_ROOM':
      return handleDeleteRoom(state, message);

    case 'REGISTER_AGENT':
      return handleRegisterAgent(state, message);

    case 'UNREGISTER_AGENT':
      return handleUnregisterAgent(state, message);

    case 'MOVE_AGENT_TO_ROOM':
      return handleMoveAgentToRoom(state, message);

    case 'REMOVE_AGENT_FROM_ROOM':
      return handleRemoveAgentFromRoom(state, message);

    case 'START_NEW_PROJECT':
      return handleStartNewProject(state, message);

    case 'STOP_PROJECT':
      return handleStopProject(state, message);

    case 'AGENTS_LOADED':
      return handleAgentsLoaded(state, message);

    case 'ROOMS_LOADED':
      return handleRoomsLoaded(state, message);

    case 'GET_STATUS':
      return handleGetStatus(state, message);

    case 'INJECT_MESSAGE':
      return handleInjectMessage(state, message);

    case 'START':
      return handleStart(state, message);

    case 'STOP':
      return handleStop(state);

    case 'SET_MODE':
      return handleSetMode(state, message);

    case 'SPAWN_AGENT':
      return handleRegisterAgent(state, { type: 'REGISTER_AGENT', config: message.config });

    case 'STOP_AGENT':
      return handleUnregisterAgent(state, { type: 'UNREGISTER_AGENT', agentId: message.agentId });

    case 'JOIN_ROOM':
      return handleJoinRoom(state, message);

    default:
      const _exhaustive: never = message;
      return noChange(state);
  }
};

// ============================================================================
// MESSAGE HANDLERS (Pure functions)
// ============================================================================

function handleInitDirector(
  state: DirectorState
): readonly [DirectorState, readonly Effect[]] {
  if (state.initialized) {
    return noChange(state);
  }

  // Create the general room
  const generalRoom = createGeneralRoom();

  const newState: DirectorState = Object.freeze({
    ...state,
    rooms: Object.freeze({
      ...state.rooms,
      [generalRoom.id]: generalRoom
    }),
    initialized: true
  });

  const effects: Effect[] = [
    spawnRoomActor(generalRoom),
    dbSaveRoom(generalRoom),
    dbLoadAllAgents('agents-loaded')
  ];

  return [newState, Object.freeze(effects)];
}

function handleCreateRoom(
  state: DirectorState,
  msg: CreateRoomMsg
): readonly [DirectorState, readonly Effect[]] {
  const { config } = msg;

  // Check if room already exists
  if (state.rooms[config.id]) {
    return noChange(state);
  }

  const newState: DirectorState = Object.freeze({
    ...state,
    rooms: Object.freeze({
      ...state.rooms,
      [config.id]: config
    })
  });

  const effects: Effect[] = [
    spawnRoomActor(config),
    dbSaveRoom(config),
    broadcastToAll(systemNotification(`Room "${config.name}" created`, 'info'))
  ];

  return [newState, Object.freeze(effects)];
}

function handleDeleteRoom(
  state: DirectorState,
  msg: DeleteRoomMsg
): readonly [DirectorState, readonly Effect[]] {
  const { roomId } = msg;

  if (!state.rooms[roomId]) {
    return noChange(state);
  }

  // Remove room from state
  const { [roomId]: removed, ...remainingRooms } = state.rooms;

  // Remove any agent associations with this room
  const newAgentRooms: Record<string, RoomId> = {};
  for (const [agentId, aRoomId] of Object.entries(state.agentRooms)) {
    if (aRoomId !== roomId) {
      newAgentRooms[agentId] = aRoomId;
    }
  }

  const newState: DirectorState = Object.freeze({
    ...state,
    rooms: Object.freeze(remainingRooms),
    agentRooms: Object.freeze(newAgentRooms)
  });

  const effects: Effect[] = [
    stopActor(roomAddress(roomId), 'Room deleted'),
    broadcastToAll(systemNotification(`Room "${removed.name}" deleted`, 'info'))
  ];

  return [newState, Object.freeze(effects)];
}

function handleRegisterAgent(
  state: DirectorState,
  msg: RegisterAgentMsg
): readonly [DirectorState, readonly Effect[]] {
  const { config } = msg;

  // Default room to join
  const defaultRoomId = 'general' as RoomId;

  const newState: DirectorState = Object.freeze({
    ...state,
    agents: Object.freeze({
      ...state.agents,
      [config.id]: config
    }),
    agentRooms: Object.freeze({
      ...state.agentRooms,
      [config.id]: defaultRoomId
    })
  });

  const effects: Effect[] = [
    spawnAgentActor(config),
    dbSaveAgent(config),
    // Auto-join the agent to the general room
    sendToRoom(defaultRoomId, agentJoinedMsg(config.id, config.name, config.description)),
    sendToAgent(config.id, joinRoom(defaultRoomId))
  ];

  return [newState, Object.freeze(effects)];
}

function handleUnregisterAgent(
  state: DirectorState,
  msg: UnregisterAgentMsg
): readonly [DirectorState, readonly Effect[]] {
  const { agentId } = msg;

  if (!state.agents[agentId]) {
    return noChange(state);
  }

  const agent = state.agents[agentId];
  const { [agentId]: removed, ...remainingAgents } = state.agents;
  const { [agentId]: removedRoom, ...remainingAgentRooms } = state.agentRooms;

  const newState: DirectorState = Object.freeze({
    ...state,
    agents: Object.freeze(remainingAgents),
    agentRooms: Object.freeze(remainingAgentRooms)
  });

  const effects: Effect[] = [
    stopActor(agentAddress(agentId), 'Agent unregistered')
  ];

  // If agent was in a room, notify the room
  if (removedRoom) {
    effects.push(
      sendToRoom(removedRoom, agentLeftMsg(agentId, agent.name))
    );
  }

  return [newState, Object.freeze(effects)];
}

function handleMoveAgentToRoom(
  state: DirectorState,
  msg: MoveAgentToRoomMsg
): readonly [DirectorState, readonly Effect[]] {
  const { agentId, roomId } = msg;

  const agent = state.agents[agentId];
  const room = state.rooms[roomId];

  if (!agent || !room) {
    return noChange(state);
  }

  const currentRoom = state.agentRooms[agentId];

  // Build effects list
  const effects: Effect[] = [];

  // Leave current room if any
  if (currentRoom && currentRoom !== roomId) {
    effects.push(
      sendToRoom(currentRoom, agentLeftMsg(agentId, agent.name)),
      sendToAgent(agentId, leaveRoom())
    );
  }

  // Join new room
  effects.push(
    sendToRoom(roomId, agentJoinedMsg(agentId, agent.name, agent.description)),
    sendToAgent(agentId, joinRoom(roomId))
  );

  // Update state
  const newState: DirectorState = Object.freeze({
    ...state,
    agentRooms: Object.freeze({
      ...state.agentRooms,
      [agentId]: roomId
    })
  });

  return [newState, Object.freeze(effects)];
}

function handleRemoveAgentFromRoom(
  state: DirectorState,
  msg: RemoveAgentFromRoomMsg
): readonly [DirectorState, readonly Effect[]] {
  const { agentId } = msg;

  const agent = state.agents[agentId];
  const currentRoom = state.agentRooms[agentId];

  if (!agent || !currentRoom) {
    return noChange(state);
  }

  const { [agentId]: removed, ...remainingAgentRooms } = state.agentRooms;

  const newState: DirectorState = Object.freeze({
    ...state,
    agentRooms: Object.freeze(remainingAgentRooms)
  });

  const effects: Effect[] = [
    sendToRoom(currentRoom, agentLeftMsg(agentId, agent.name)),
    sendToAgent(agentId, leaveRoom())
  ];

  return [newState, Object.freeze(effects)];
}

function handleStartNewProject(
  state: DirectorState,
  msg: StartNewProjectMsg
): readonly [DirectorState, readonly Effect[]] {
  const { name, goal, roomId, maxTurns } = msg;

  if (!state.rooms[roomId]) {
    return noChange(state);
  }

  const projectId = generateProjectId();

  const projectInfo: ProjectInfo = Object.freeze({
    id: projectId,
    name,
    roomId,
    isActive: true
  });

  const newState: DirectorState = Object.freeze({
    ...state,
    projects: Object.freeze({
      ...state.projects,
      [projectId]: projectInfo
    })
  });

  const effects: Effect[] = [
    spawnProjectActor(projectId, name, goal, roomId),
    sendToProject(projectId, startProject()),
    broadcastToRoom(roomId, systemNotification(
      `Project "${name}" started`,
      'info'
    ))
  ];

  return [newState, Object.freeze(effects)];
}

function handleStopProject(
  state: DirectorState,
  msg: StopProjectMsg
): readonly [DirectorState, readonly Effect[]] {
  const { projectId } = msg;

  const project = state.projects[projectId];
  if (!project) {
    return noChange(state);
  }

  const updatedProject: ProjectInfo = Object.freeze({
    ...project,
    isActive: false
  });

  const newState: DirectorState = Object.freeze({
    ...state,
    projects: Object.freeze({
      ...state.projects,
      [projectId]: updatedProject
    })
  });

  const effects: Effect[] = [
    stopActor(projectAddress(projectId), 'Project stopped'),
    broadcastToRoom(project.roomId, systemNotification(
      `Project "${project.name}" stopped`,
      'info'
    ))
  ];

  return [newState, Object.freeze(effects)];
}

function handleAgentsLoaded(
  state: DirectorState,
  msg: AgentsLoadedMsg
): readonly [DirectorState, readonly Effect[]] {
  const { agents } = msg;
  const defaultRoomId = 'general' as RoomId;

  // Build agents record
  const agentsRecord: Record<string, AgentConfig> = { ...state.agents };
  for (const agent of agents) {
    agentsRecord[agent.id] = agent;
  }

  const newState: DirectorState = Object.freeze({
    ...state,
    agents: Object.freeze(agentsRecord)
  });

  // Spawn agent actors AND join them to default room
  const effects: Effect[] = [];
  for (const config of agents) {
    effects.push(
      spawnAgentActor(config),
      sendToRoom(defaultRoomId, agentJoinedMsg(config.id, config.name, config.description)),
      sendToAgent(config.id, joinRoom(defaultRoomId))
    );
  }

  return [newState, Object.freeze(effects)];
}

function handleRoomsLoaded(
  state: DirectorState,
  msg: RoomsLoadedMsg
): readonly [DirectorState, readonly Effect[]] {
  const { rooms } = msg;

  // Build rooms record
  const roomsRecord: Record<string, RoomConfig> = { ...state.rooms };
  for (const room of rooms) {
    roomsRecord[room.id] = room;
  }

  const newState: DirectorState = Object.freeze({
    ...state,
    rooms: Object.freeze(roomsRecord)
  });

  // Spawn room actors
  const effects: Effect[] = rooms.map(config => spawnRoomActor(config));

  return [newState, Object.freeze(effects)];
}

function handleGetStatus(
  state: DirectorState,
  _msg: GetStatusMsg
): readonly [DirectorState, readonly Effect[]] {
  // Status is just state - no side effects needed
  // The runtime would handle sending the reply
  return noChange(state);
}

function handleInjectMessage(
  state: DirectorState,
  msg: InjectMessageMsg
): readonly [DirectorState, readonly Effect[]] {
  const { message } = msg;
  const roomId = message.roomId || state.currentRoom || ('general' as RoomId);

  const effects: Effect[] = [];
  let newState = state;

  // Auto-create room if it doesn't exist
  if (!state.rooms[roomId]) {
    const roomConfig = createRoomConfig({
      id: roomId,
      name: roomId,
      description: `Room ${roomId}`,
      topic: ''
    });

    newState = Object.freeze({
      ...state,
      rooms: Object.freeze({
        ...state.rooms,
        [roomId]: roomConfig
      })
    });

    effects.push(spawnRoomActor(roomConfig));
    effects.push(dbSaveRoom(roomConfig));
  }

  // Route message to room for processing
  effects.push(sendToRoom(roomId, userMessageMsg(message, message.mentions || [])));

  return [newState, Object.freeze(effects)];
}

function handleStart(
  state: DirectorState,
  msg: StartMsg
): readonly [DirectorState, readonly Effect[]] {
  if (state.running) {
    return noChange(state);
  }

  const newState: DirectorState = Object.freeze({
    ...state,
    running: true,
    mode: msg.mode,
    maxTurns: msg.maxTurns
  });

  const effects: Effect[] = [
    broadcastToAll(systemNotification('Conversation started', 'info'))
  ];

  return [newState, Object.freeze(effects)];
}

function handleStop(
  state: DirectorState
): readonly [DirectorState, readonly Effect[]] {
  if (!state.running) {
    return noChange(state);
  }

  const newState: DirectorState = Object.freeze({
    ...state,
    running: false
  });

  const effects: Effect[] = [
    broadcastToAll(systemNotification('Conversation stopped', 'info'))
  ];

  return [newState, Object.freeze(effects)];
}

function handleSetMode(
  state: DirectorState,
  msg: SetModeMsg
): readonly [DirectorState, readonly Effect[]] {
  const newState: DirectorState = Object.freeze({
    ...state,
    mode: msg.mode
  });

  // Propagate mode change to all rooms
  const roomIds = Object.keys(state.rooms) as RoomId[];
  const effects: Effect[] = roomIds.map(roomId =>
    sendToRoom(roomId, setScheduleMode(msg.mode))
  );

  return [newState, Object.freeze(effects)];
}

function handleJoinRoom(
  state: DirectorState,
  msg: JoinRoomMsg
): readonly [DirectorState, readonly Effect[]] {
  const { roomId, roomName } = msg;

  // Check if room exists
  if (state.rooms[roomId]) {
    // Just update current room
    const newState: DirectorState = Object.freeze({
      ...state,
      currentRoom: roomId
    });
    return stateOnly(newState);
  }

  // Create new room
  const roomConfig = createRoomConfig({
    id: roomId,
    name: roomName,
    description: `Discussion room: ${roomName}`,
    topic: ''
  });

  const newState: DirectorState = Object.freeze({
    ...state,
    rooms: Object.freeze({
      ...state.rooms,
      [roomId]: roomConfig
    }),
    currentRoom: roomId
  });

  const effects: Effect[] = [
    spawnRoomActor(roomConfig),
    dbSaveRoom(roomConfig),
    broadcastToAll(systemNotification(`Room "${roomName}" created`, 'info'))
  ];

  return [newState, Object.freeze(effects)];
}

// ============================================================================
// QUERIES (Pure functions)
// ============================================================================

/**
 * Get count of active rooms.
 */
export function getRoomCount(state: DirectorState): number {
  return Object.keys(state.rooms).length;
}

/**
 * Get count of registered agents.
 */
export function getAgentCount(state: DirectorState): number {
  return Object.keys(state.agents).length;
}

/**
 * Get count of active projects.
 */
export function getActiveProjectCount(state: DirectorState): number {
  return Object.values(state.projects).filter(p => p.isActive).length;
}

/**
 * Get agents in a room.
 */
export function getAgentsInRoom(state: DirectorState, roomId: RoomId): readonly AgentId[] {
  return Object.freeze(
    Object.entries(state.agentRooms)
      .filter(([_, rid]) => rid === roomId)
      .map(([agentId]) => agentId as AgentId)
  );
}

/**
 * Get system status summary.
 */
export function getStatusSummary(state: DirectorState): {
  roomCount: number;
  agentCount: number;
  activeProjectCount: number;
  initialized: boolean;
} {
  return {
    roomCount: getRoomCount(state),
    agentCount: getAgentCount(state),
    activeProjectCount: getActiveProjectCount(state),
    initialized: state.initialized
  };
}

export default directorInterpreter;
