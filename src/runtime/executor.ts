/**
 * Effect Executor
 *
 * Combines all boundary executors into a unified effect execution system.
 *
 * This is the main entry point for executing effects produced by interpreters.
 *
 * ARCHITECTURE:
 * ```
 * Effects from Interpreter
 *         │
 *         ▼
 *   ┌─────────────┐
 *   │   Executor  │
 *   │   Router    │
 *   └──────┬──────┘
 *          │
 *    ┌─────┴─────┬─────────┬─────────┬─────────┐
 *    ▼           ▼         ▼         ▼         ▼
 * Database   Anthropic   Tools   Broadcast   Actor
 * Executor   Executor   Executor  Executor  Executor
 * ```
 */

import { Effect, categorizeEffect, EffectCategory } from '../effects/index.js';
import {
  EffectResult,
  EffectExecutor,
  RuntimeConfig,
  Logger,
  successResult,
  failureResult,
  createConsoleLogger
} from './types.js';
import {
  createDatabaseConnection,
  createDatabaseExecutor,
  DatabaseConnection
} from './database.js';
import {
  createAnthropicClient,
  createAnthropicExecutor,
  AnthropicClient
} from './anthropic.js';
import {
  createToolsState,
  createToolsExecutor,
  ToolsState
} from './tools.js';
import {
  createBroadcastState,
  createBroadcastExecutor,
  BroadcastState
} from './broadcast.js';
import {
  createActorRuntime,
  createActorEffectExecutor,
  createActorRuntimeConfig,
  ActorRuntime
} from './actor.js';
import { agentAddress } from '../effects/actor.js';
import { AgentId } from '../values/ids.js';

// ============================================================================
// UNIFIED EXECUTOR
// ============================================================================

/**
 * Unified effect executor that routes to appropriate boundaries.
 */
export interface UnifiedExecutor {
  readonly executors: Readonly<Record<EffectCategory, EffectExecutor>>;
  readonly logger: Logger;

  execute(effect: Effect): Promise<EffectResult>;
  executeAll(effects: readonly Effect[]): Promise<readonly EffectResult[]>;
  executeParallel(effects: readonly Effect[]): Promise<readonly EffectResult[]>;
}

/**
 * Create a unified executor.
 */
export function createUnifiedExecutor(
  executors: Readonly<Record<EffectCategory, EffectExecutor>>,
  logger: Logger
): UnifiedExecutor {
  return {
    executors,
    logger,

    async execute(effect: Effect): Promise<EffectResult> {
      const start = Date.now();

      try {
        const category = categorizeEffect(effect);
        const executor = executors[category];

        if (!executor) {
          return failureResult(
            effect,
            `No executor for category: ${category}`,
            Date.now() - start
          );
        }

        return await executor.execute(effect);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Effect execution error', { effectType: effect.type, error });
        return failureResult(effect, error, Date.now() - start);
      }
    },

    async executeAll(effects: readonly Effect[]): Promise<readonly EffectResult[]> {
      const results: EffectResult[] = [];

      for (const effect of effects) {
        const result = await this.execute(effect);
        results.push(result);
      }

      return Object.freeze(results);
    },

    async executeParallel(effects: readonly Effect[]): Promise<readonly EffectResult[]> {
      const promises = effects.map(effect => this.execute(effect));
      const results = await Promise.all(promises);
      return Object.freeze(results);
    }
  };
}

// ============================================================================
// RUNTIME CONTEXT
// ============================================================================

/**
 * Complete runtime context with all dependencies.
 */
export interface RuntimeContext {
  readonly config: RuntimeConfig;
  readonly logger: Logger;

  // Connections
  readonly database: DatabaseConnection;
  readonly anthropic: AnthropicClient;
  readonly tools: ToolsState;
  readonly broadcast: BroadcastState;

  // Executors
  readonly executor: UnifiedExecutor;

  // Actor runtime
  readonly actors: ActorRuntime;

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create a complete runtime context.
 */
export function createRuntimeContext(config: RuntimeConfig): RuntimeContext {
  const logger = config.enableLogging
    ? createConsoleLogger('info')
    : { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

  // Create connections
  const database = createDatabaseConnection(config.databasePath);
  const anthropic = createAnthropicClient(config.anthropicApiKey);
  const tools = createToolsState(config.maxToolExecutionTime);
  const broadcast = createBroadcastState();

  // Create executors
  const databaseExecutor = createDatabaseExecutor(database, logger);
  const broadcastExecutor = createBroadcastExecutor(broadcast, logger);

  // Create actor runtime config
  const actorConfig = createActorRuntimeConfig({
    workspacePath: config.workspacePath,
    sharedWorkspacePath: config.sharedWorkspacePath
  });

  // Use a mutable reference so the callback can access actors after it's created
  let actorsRef: ActorRuntime | null = null;

  // Create Anthropic executor with callback to route responses back to agents
  const anthropicExecutor = createAnthropicExecutor(anthropic, logger, (agentId, roomId, response, replyTag) => {
    if (actorsRef) {
      logger.debug('Routing API response to agent', { agentId, replyTag });
      actorsRef.send(agentAddress(agentId as AgentId), {
        type: 'API_RESPONSE',
        response,
        roomId,
        replyTag
      });
    } else {
      logger.error('Actor runtime not initialized when API response received');
    }
  });

  // Create tools executor with callback to route results back to agents
  const toolsExecutor = createToolsExecutor(tools, logger, (agentId, roomId, results, replyTag) => {
    if (actorsRef) {
      logger.debug('Routing tool results to agent', { agentId, replyTag, resultCount: results.length });
      actorsRef.send(agentAddress(agentId as AgentId), {
        type: 'TOOL_RESULT',
        results,
        roomId,
        replyTag
      });
    } else {
      logger.error('Actor runtime not initialized when tool results received');
    }
  });

  // Create actor runtime (will add actor executor after)
  const executorsList: EffectExecutor[] = [
    databaseExecutor,
    anthropicExecutor,
    toolsExecutor,
    broadcastExecutor
  ];

  const actors = createActorRuntime(actorConfig, executorsList, logger);
  actorsRef = actors; // Set the reference so the callback can use it

  // Create actor executor
  const actorExecutor = createActorEffectExecutor(actors, logger);

  // Create unified executor
  const executor = createUnifiedExecutor(
    {
      database: databaseExecutor,
      anthropic: anthropicExecutor,
      tool: toolsExecutor,
      broadcast: broadcastExecutor,
      actor: actorExecutor
    },
    logger
  );

  let isRunning = false;

  return {
    config,
    logger,
    database,
    anthropic,
    tools,
    broadcast,
    executor,
    actors,

    async start(): Promise<void> {
      if (isRunning) return;

      logger.info('Starting runtime context');
      await actors.start();
      isRunning = true;
      logger.info('Runtime context started');
    },

    async stop(): Promise<void> {
      if (!isRunning) return;

      logger.info('Stopping runtime context');
      await actors.stop();
      database.db.close();
      isRunning = false;
      logger.info('Runtime context stopped');
    }
  };
}

// ============================================================================
// EFFECT BATCHING
// ============================================================================

/**
 * Group effects by category for optimized execution.
 */
export function groupEffectsByCategory(
  effects: readonly Effect[]
): Readonly<Record<EffectCategory, readonly Effect[]>> {
  const groups: Record<EffectCategory, Effect[]> = {
    database: [],
    anthropic: [],
    tool: [],
    broadcast: [],
    actor: []
  };

  for (const effect of effects) {
    const category = categorizeEffect(effect);
    groups[category].push(effect);
  }

  return Object.freeze({
    database: Object.freeze(groups.database),
    anthropic: Object.freeze(groups.anthropic),
    tool: Object.freeze(groups.tool),
    broadcast: Object.freeze(groups.broadcast),
    actor: Object.freeze(groups.actor)
  });
}

/**
 * Execute effects with smart batching.
 * - Database effects: sequential (for consistency)
 * - Anthropic effects: sequential (rate limiting)
 * - Tool effects: can parallel within batch
 * - Broadcast effects: parallel (no dependencies)
 * - Actor effects: sequential (ordering matters)
 */
export async function executeWithBatching(
  executor: UnifiedExecutor,
  effects: readonly Effect[]
): Promise<readonly EffectResult[]> {
  const grouped = groupEffectsByCategory(effects);
  const results: EffectResult[] = [];

  // Execute in order: database → actor → anthropic → tools → broadcast
  // This ensures state is saved before messages are sent

  // 1. Database effects (sequential)
  for (const effect of grouped.database) {
    results.push(await executor.execute(effect));
  }

  // 2. Actor effects (sequential, for message ordering)
  for (const effect of grouped.actor) {
    results.push(await executor.execute(effect));
  }

  // 3. Anthropic effects (sequential, rate limiting)
  for (const effect of grouped.anthropic) {
    results.push(await executor.execute(effect));
  }

  // 4. Tool effects (can parallel)
  const toolResults = await executor.executeParallel(grouped.tool);
  results.push(...toolResults);

  // 5. Broadcast effects (parallel)
  const broadcastResults = await executor.executeParallel(grouped.broadcast);
  results.push(...broadcastResults);

  return Object.freeze(results);
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Get execution statistics.
 */
export function getExecutionStats(results: readonly EffectResult[]): ExecutionStats {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  return {
    total: results.length,
    successful: successful.length,
    failed: failed.length,
    totalDuration,
    averageDuration: results.length > 0 ? totalDuration / results.length : 0,
    byCategory: getCategoryStats(results)
  };
}

function getCategoryStats(
  results: readonly EffectResult[]
): Readonly<Record<EffectCategory, CategoryStats>> {
  const stats: Record<EffectCategory, { count: number; duration: number; failed: number }> = {
    database: { count: 0, duration: 0, failed: 0 },
    anthropic: { count: 0, duration: 0, failed: 0 },
    tool: { count: 0, duration: 0, failed: 0 },
    broadcast: { count: 0, duration: 0, failed: 0 },
    actor: { count: 0, duration: 0, failed: 0 }
  };

  for (const result of results) {
    const category = categorizeEffect(result.effect);
    stats[category].count++;
    stats[category].duration += result.duration;
    if (!result.success) {
      stats[category].failed++;
    }
  }

  return Object.freeze(
    Object.fromEntries(
      Object.entries(stats).map(([cat, s]) => [
        cat,
        Object.freeze({
          count: s.count,
          duration: s.duration,
          failed: s.failed,
          averageDuration: s.count > 0 ? s.duration / s.count : 0
        })
      ])
    ) as Record<EffectCategory, CategoryStats>
  );
}

export interface ExecutionStats {
  total: number;
  successful: number;
  failed: number;
  totalDuration: number;
  averageDuration: number;
  byCategory: Readonly<Record<EffectCategory, CategoryStats>>;
}

export interface CategoryStats {
  count: number;
  duration: number;
  failed: number;
  averageDuration: number;
}
