/**
 * Actor System Runtime
 *
 * Manages actor lifecycle, message routing, and effect execution.
 *
 * ARCHITECTURE:
 * ```
 * Message → Actor Mailbox → Interpreter → [NewState, Effects]
 *                                              │
 *                                              ▼
 *                                        Effect Executor
 *                                              │
 *                           ┌──────────────────┼──────────────────┐
 *                           ▼                  ▼                  ▼
 *                      Database           Anthropic          Broadcast
 * ```
 *
 * ACTOR LIFECYCLE:
 * 1. spawn() - Create actor with initial state and interpreter
 * 2. send() - Enqueue message in mailbox
 * 3. process() - Run interpreter, execute effects
 * 4. stop() - Cleanup and remove actor
 */

import { Effect } from '../effects/index.js';
import {
  ActorEffect,
  isActorEffect,
  ActorAddress,
  ActorMessage,
  SendToActor,
  ForwardToActor,
  SpawnRoomActor,
  SpawnAgentActor,
  SpawnProjectActor,
  StopActor,
  RestartActor,
  ScheduleMessage,
  CancelScheduled,
  ScheduleRecurring,
  WatchActor,
  UnwatchActor,
  roomAddress,
  agentAddress,
  projectAddress,
  directorAddress,
  parseAddress
} from '../effects/actor.js';
import {
  roomInterpreter,
  createRoomInterpreterState,
  RoomMessage
} from '../interpreters/room.js';
import {
  agentInterpreter,
  createAgentInterpreterState,
  AgentMessage
} from '../interpreters/agent.js';
import {
  projectInterpreter,
  ProjectMessage
} from '../interpreters/project.js';
import {
  directorInterpreter,
  createDirectorState,
  DirectorMessage
} from '../interpreters/director.js';
import { createRoomState, RoomState } from '../values/room.js';
import { createProjectState, ProjectState } from '../values/project.js';
import {
  RuntimeState,
  ActorInstance,
  ScheduledMessage,
  MessageEnvelope,
  createActorInstance,
  createRuntimeState,
  createEnvelope,
  withActor,
  withoutActor,
  withUpdatedActor,
  withMessage,
  withProcessedMessage,
  withProcessing,
  withScheduledMessage,
  withoutScheduledMessage,
  withRunning,
  withPendingEffects,
  clearPendingEffects,
  EffectExecutor,
  EffectResult,
  successResult,
  failureResult,
  Logger
} from './types.js';

// ============================================================================
// ACTOR RUNTIME
// ============================================================================

/**
 * The actor system runtime.
 */
export interface ActorRuntime {
  readonly state: RuntimeState;
  readonly config: ActorRuntimeConfig;
  readonly executors: readonly EffectExecutor[];
  readonly logger: Logger;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Actor management
  spawn<S, M>(
    address: ActorAddress,
    initialState: S,
    interpreter: (state: S, message: M) => readonly [S, readonly Effect[]]
  ): void;
  send(to: ActorAddress, message: ActorMessage): void;
  stopActor(address: ActorAddress, reason?: string): void;

  // Queries
  getActor(address: ActorAddress): ActorInstance<unknown, unknown> | undefined;
  hasActor(address: ActorAddress): boolean;
  getActorCount(): number;
}

/**
 * Configuration for actor runtime.
 */
export interface ActorRuntimeConfig {
  readonly workspacePath: string;
  readonly sharedWorkspacePath: string;
  readonly maxToolCalls: number;
  readonly schedulerIntervalMs: number;
}

/**
 * Create actor runtime config with defaults.
 */
export function createActorRuntimeConfig(params: {
  workspacePath?: string;
  sharedWorkspacePath?: string;
  maxToolCalls?: number;
  schedulerIntervalMs?: number;
}): ActorRuntimeConfig {
  return Object.freeze({
    workspacePath: params.workspacePath ?? './workspaces',
    sharedWorkspacePath: params.sharedWorkspacePath ?? './shared',
    maxToolCalls: params.maxToolCalls ?? 50,
    schedulerIntervalMs: params.schedulerIntervalMs ?? 100
  });
}

// ============================================================================
// RUNTIME IMPLEMENTATION
// ============================================================================

/**
 * Create an actor runtime.
 */
export function createActorRuntime(
  config: ActorRuntimeConfig,
  executors: readonly EffectExecutor[],
  logger: Logger
): ActorRuntime {
  let state = createRuntimeState();
  let schedulerInterval: NodeJS.Timeout | null = null;
  let messageQueue: MessageEnvelope[] = [];
  let isProcessing = false;

  // Process messages in queue
  const processQueue = async (): Promise<void> => {
    if (isProcessing || messageQueue.length === 0) return;
    isProcessing = true;

    while (messageQueue.length > 0) {
      const envelope = messageQueue.shift()!;
      await processMessage(envelope);
    }

    isProcessing = false;
  };

  // Process a single message
  const processMessage = async (envelope: MessageEnvelope): Promise<void> => {
    const { to, message } = envelope;
    const actor = state.actors[to];

    if (!actor) {
      logger.warn('Actor not found', { address: to, messageType: message.type });
      return;
    }

    if (actor.isProcessing) {
      // Re-queue if actor is busy
      messageQueue.push(envelope);
      return;
    }

    // Mark as processing
    state = withUpdatedActor(state, withProcessing(actor, true));

    try {
      // Run interpreter
      const [newState, effects] = actor.interpreter(actor.state, message);

      // Update actor state
      const updatedActor = withProcessedMessage(
        { ...actor, state: newState } as ActorInstance<unknown, unknown>,
        newState
      );
      state = withUpdatedActor(state, updatedActor);

      // Execute effects
      await executeEffects(effects);
    } catch (err) {
      logger.error('Error processing message', {
        address: to,
        messageType: message.type,
        error: err instanceof Error ? err.message : String(err)
      });

      // Reset processing flag on error
      state = withUpdatedActor(state, withProcessing(actor, false));
    }
  };

  // Execute effects
  const executeEffects = async (effects: readonly Effect[]): Promise<void> => {
    for (const effect of effects) {
      // Handle actor effects internally
      if (isActorEffect(effect)) {
        await executeActorEffect(effect as ActorEffect);
        continue;
      }

      // Find executor for other effects
      const executor = executors.find(e => e.canHandle(effect));
      if (executor) {
        const result = await executor.execute(effect);
        if (!result.success) {
          logger.error('Effect execution failed', {
            effectType: effect.type,
            error: result.error
          });
        }
      } else {
        logger.warn('No executor for effect', { effectType: effect.type });
      }
    }
  };

  // Execute actor effects
  const executeActorEffect = async (effect: ActorEffect): Promise<void> => {
    switch (effect.type) {
      case 'SEND_TO_ACTOR':
        runtime.send(effect.to, effect.message);
        break;

      case 'FORWARD_TO_ACTOR':
        runtime.send(effect.to, effect.message);
        break;

      case 'SPAWN_ROOM_ACTOR':
        spawnRoomActor(effect);
        break;

      case 'SPAWN_AGENT_ACTOR':
        spawnAgentActor(effect);
        break;

      case 'SPAWN_PROJECT_ACTOR':
        spawnProjectActor(effect);
        break;

      case 'STOP_ACTOR':
        runtime.stopActor(effect.address, effect.reason);
        break;

      case 'RESTART_ACTOR':
        restartActor(effect);
        break;

      case 'SCHEDULE_MESSAGE':
        scheduleMessage(effect);
        break;

      case 'CANCEL_SCHEDULED':
        cancelScheduledMessage(effect);
        break;

      case 'SCHEDULE_RECURRING':
        scheduleRecurring(effect);
        break;

      case 'WATCH_ACTOR':
      case 'UNWATCH_ACTOR':
        // Supervision not fully implemented
        logger.debug('Supervision effect', { type: effect.type });
        break;
    }
  };

  // Spawn room actor
  const spawnRoomActor = (effect: SpawnRoomActor): void => {
    const address = roomAddress(effect.config.id);
    const initialState = createRoomState(effect.config);
    runtime.spawn(address, initialState, roomInterpreter as any);
    logger.info('Spawned room actor', { address, name: effect.config.name });
  };

  // Spawn agent actor
  const spawnAgentActor = (effect: SpawnAgentActor): void => {
    const address = agentAddress(effect.config.id);
    const initialState = createAgentInterpreterState(
      effect.config,
      config.workspacePath,
      config.sharedWorkspacePath,
      config.maxToolCalls
    );
    runtime.spawn(address, initialState, agentInterpreter as any);
    logger.info('Spawned agent actor', { address, name: effect.config.name });
  };

  // Spawn project actor
  const spawnProjectActor = (effect: SpawnProjectActor): void => {
    const address = projectAddress(effect.projectId);
    const initialState = createProjectState({
      id: effect.projectId,
      name: effect.name,
      goal: effect.goal,
      roomId: effect.roomId
    });
    runtime.spawn(address, initialState, projectInterpreter as any);
    logger.info('Spawned project actor', { address, name: effect.name });
  };

  // Restart actor
  const restartActor = (effect: RestartActor): void => {
    const actor = state.actors[effect.address];
    if (!actor) return;

    // Get the address type to determine restart behavior
    const { type } = parseAddress(effect.address);
    logger.info('Restarting actor', { address: effect.address, type });

    // For now, just log - full restart would require storing initial config
  };

  // Schedule a message
  const scheduleMessage = (effect: ScheduleMessage): void => {
    const scheduled: ScheduledMessage = {
      id: effect.id ?? `sched_${Date.now()}`,
      envelope: createEnvelope(effect.to, effect.message),
      executeAt: Date.now() + effect.delayMs,
      isRecurring: false
    };
    state = withScheduledMessage(state, scheduled);
    logger.debug('Scheduled message', { id: scheduled.id, delayMs: effect.delayMs });
  };

  // Cancel a scheduled message
  const cancelScheduledMessage = (effect: CancelScheduled): void => {
    state = withoutScheduledMessage(state, effect.id);
    logger.debug('Cancelled scheduled message', { id: effect.id });
  };

  // Schedule a recurring message
  const scheduleRecurring = (effect: ScheduleRecurring): void => {
    const scheduled: ScheduledMessage = {
      id: effect.id,
      envelope: createEnvelope(effect.to, effect.message),
      executeAt: Date.now() + effect.intervalMs,
      isRecurring: true,
      intervalMs: effect.intervalMs
    };
    state = withScheduledMessage(state, scheduled);
    logger.debug('Scheduled recurring message', { id: effect.id, intervalMs: effect.intervalMs });
  };

  // Check and process scheduled messages
  const processScheduled = (): void => {
    const now = Date.now();
    const due = state.scheduledMessages.filter(s => s.executeAt <= now);

    for (const scheduled of due) {
      // Remove from scheduled
      state = withoutScheduledMessage(state, scheduled.id);

      // Send the message
      messageQueue.push(scheduled.envelope);

      // Re-schedule if recurring
      if (scheduled.isRecurring && scheduled.intervalMs) {
        const next: ScheduledMessage = {
          ...scheduled,
          executeAt: now + scheduled.intervalMs
        };
        state = withScheduledMessage(state, next);
      }
    }

    // Process any new messages
    processQueue();
  };

  // The runtime object
  const runtime: ActorRuntime = {
    get state() { return state; },
    config,
    executors,
    logger,

    async start(): Promise<void> {
      if (state.isRunning) return;

      state = withRunning(state, true);
      logger.info('Actor runtime started');

      // Spawn director
      const directorAddr = directorAddress();
      this.spawn(directorAddr, createDirectorState(), directorInterpreter as any);

      // Start scheduler
      schedulerInterval = setInterval(processScheduled, config.schedulerIntervalMs);
    },

    async stop(): Promise<void> {
      if (!state.isRunning) return;

      // Stop scheduler
      if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
      }

      // Stop all actors
      for (const address of Object.keys(state.actors)) {
        this.stopActor(address as ActorAddress);
      }

      state = withRunning(state, false);
      logger.info('Actor runtime stopped');
    },

    spawn<S, M>(
      address: ActorAddress,
      initialState: S,
      interpreter: (state: S, message: M) => readonly [S, readonly Effect[]]
    ): void {
      if (state.actors[address]) {
        logger.warn('Actor already exists', { address });
        return;
      }

      const actor = createActorInstance(address, initialState, interpreter);
      state = withActor(state, actor as ActorInstance<unknown, unknown>);
      logger.debug('Spawned actor', { address });
    },

    send(to: ActorAddress, message: ActorMessage): void {
      const envelope = createEnvelope(to, message);
      messageQueue.push(envelope);

      // Trigger processing
      if (!isProcessing) {
        setImmediate(() => processQueue());
      }
    },

    stopActor(address: ActorAddress, reason?: string): void {
      const actor = state.actors[address];
      if (!actor) return;

      state = withoutActor(state, address);
      logger.info('Stopped actor', { address, reason });
    },

    getActor(address: ActorAddress): ActorInstance<unknown, unknown> | undefined {
      return state.actors[address];
    },

    hasActor(address: ActorAddress): boolean {
      return address in state.actors;
    },

    getActorCount(): number {
      return Object.keys(state.actors).length;
    }
  };

  return runtime;
}

// ============================================================================
// ACTOR EFFECT EXECUTOR
// ============================================================================

/**
 * Create an actor effect executor.
 * Note: Most actor effects are handled internally by the runtime.
 * This executor is for cases where actor effects need to be processed externally.
 */
export function createActorEffectExecutor(
  runtime: ActorRuntime,
  logger: Logger
): EffectExecutor {
  return {
    canHandle(effect: Effect): boolean {
      return isActorEffect(effect);
    },

    async execute(effect: Effect): Promise<EffectResult> {
      if (!isActorEffect(effect)) {
        return failureResult(effect, 'Not an actor effect', 0);
      }

      const start = Date.now();

      try {
        // Actor effects are handled by runtime.send()
        if (effect.type === 'SEND_TO_ACTOR') {
          runtime.send(effect.to, effect.message);
        } else if (effect.type === 'FORWARD_TO_ACTOR') {
          runtime.send(effect.to, effect.message);
        }
        // Other actor effects are internal to runtime

        return successResult(effect, { executed: true }, Date.now() - start);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return failureResult(effect, error, Date.now() - start);
      }
    }
  };
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Get runtime statistics.
 */
export function getRuntimeStats(runtime: ActorRuntime): RuntimeStats {
  const actors = Object.values(runtime.state.actors);
  return {
    actorCount: actors.length,
    runningActors: actors.filter(a => a.isProcessing).length,
    pendingMessages: runtime.state.scheduledMessages.length,
    uptime: runtime.state.startedAt
      ? Date.now() - runtime.state.startedAt
      : 0
  };
}

export interface RuntimeStats {
  actorCount: number;
  runningActors: number;
  pendingMessages: number;
  uptime: number;
}
