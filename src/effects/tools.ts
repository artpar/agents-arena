/**
 * Tool Effects
 *
 * Effects that describe tool executions (file system, bash, etc.).
 * These are DATA describing what to do, not the execution.
 * The boundary executor will actually run the tools.
 */

import { AgentId } from '../values/index.js';

// ============================================================================
// TOOL CONTEXT (Immutable value passed to tool executors)
// ============================================================================

/**
 * Context for tool execution.
 */
export interface ToolContext {
  readonly agentId: AgentId;
  readonly agentName: string;
  readonly workspacePath: string;
  readonly sharedWorkspacePath: string;
  readonly projectId?: string;
  readonly taskId?: string;
}

/**
 * Create a tool context value.
 */
export function createToolContext(params: {
  agentId: AgentId;
  agentName: string;
  workspacePath: string;
  sharedWorkspacePath: string;
  projectId?: string;
  taskId?: string;
}): ToolContext {
  return Object.freeze({
    agentId: params.agentId,
    agentName: params.agentName,
    workspacePath: params.workspacePath,
    sharedWorkspacePath: params.sharedWorkspacePath,
    projectId: params.projectId,
    taskId: params.taskId
  });
}

// ============================================================================
// TOOL RESULT (Immutable value returned from execution)
// ============================================================================

/**
 * Result from tool execution.
 */
export interface ToolResult {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly result: string;
  readonly isError: boolean;
  readonly artifacts?: readonly string[];  // Files created/modified
  readonly duration?: number;              // Execution time in ms
}

/**
 * Create a successful tool result.
 */
export function successResult(
  toolUseId: string,
  toolName: string,
  result: string,
  artifacts?: readonly string[],
  duration?: number
): ToolResult {
  return Object.freeze({
    toolUseId,
    toolName,
    result,
    isError: false,
    artifacts: artifacts ? Object.freeze([...artifacts]) : undefined,
    duration
  });
}

/**
 * Create an error tool result.
 */
export function errorResult(
  toolUseId: string,
  toolName: string,
  error: string,
  duration?: number
): ToolResult {
  return Object.freeze({
    toolUseId,
    toolName,
    result: error,
    isError: true,
    duration
  });
}

// ============================================================================
// TOOL EXECUTION EFFECT
// ============================================================================

/**
 * Effect to execute a single tool.
 */
export interface ExecuteTool {
  readonly type: 'EXECUTE_TOOL';
  readonly toolUseId: string;          // ID from API response
  readonly toolName: string;
  readonly input: unknown;
  readonly context: ToolContext;
  readonly replyTag: string;           // Tag to correlate response
}

export function executeTool(
  toolUseId: string,
  toolName: string,
  input: unknown,
  context: ToolContext,
  replyTag: string
): ExecuteTool {
  return Object.freeze({
    type: 'EXECUTE_TOOL',
    toolUseId,
    toolName,
    input,
    context,
    replyTag
  });
}

/**
 * Effect to execute multiple tools in parallel.
 */
export interface ExecuteToolsBatch {
  readonly type: 'EXECUTE_TOOLS_BATCH';
  readonly tools: readonly {
    readonly toolUseId: string;
    readonly toolName: string;
    readonly input: unknown;
  }[];
  readonly context: ToolContext;
  readonly replyTag: string;
}

export function executeToolsBatch(
  tools: readonly { toolUseId: string; toolName: string; input: unknown }[],
  context: ToolContext,
  replyTag: string
): ExecuteToolsBatch {
  return Object.freeze({
    type: 'EXECUTE_TOOLS_BATCH',
    tools: Object.freeze([...tools]),
    context,
    replyTag
  });
}

/**
 * Effect to cancel ongoing tool execution.
 */
export interface CancelToolExecution {
  readonly type: 'CANCEL_TOOL_EXECUTION';
  readonly toolUseId: string;
  readonly reason?: string;
}

export function cancelToolExecution(
  toolUseId: string,
  reason?: string
): CancelToolExecution {
  return Object.freeze({
    type: 'CANCEL_TOOL_EXECUTION',
    toolUseId,
    reason
  });
}

// ============================================================================
// FILE SYSTEM EFFECTS (Specific tool shortcuts)
// ============================================================================

/**
 * Effect to read a file.
 */
export interface ReadFile {
  readonly type: 'READ_FILE';
  readonly path: string;
  readonly replyTag: string;
}

export function readFile(path: string, replyTag: string): ReadFile {
  return Object.freeze({ type: 'READ_FILE', path, replyTag });
}

/**
 * Effect to write a file.
 */
export interface WriteFile {
  readonly type: 'WRITE_FILE';
  readonly path: string;
  readonly content: string;
  readonly replyTag: string;
}

export function writeFile(path: string, content: string, replyTag: string): WriteFile {
  return Object.freeze({ type: 'WRITE_FILE', path, content, replyTag });
}

/**
 * Effect to list directory contents.
 */
export interface ListDirectory {
  readonly type: 'LIST_DIRECTORY';
  readonly path: string;
  readonly replyTag: string;
}

export function listDirectory(path: string, replyTag: string): ListDirectory {
  return Object.freeze({ type: 'LIST_DIRECTORY', path, replyTag });
}

// ============================================================================
// BASH EFFECTS
// ============================================================================

/**
 * Effect to run a bash command.
 */
export interface RunBash {
  readonly type: 'RUN_BASH';
  readonly command: string;
  readonly cwd?: string;
  readonly timeout?: number;
  readonly replyTag: string;
}

export function runBash(
  command: string,
  replyTag: string,
  cwd?: string,
  timeout?: number
): RunBash {
  return Object.freeze({
    type: 'RUN_BASH',
    command,
    cwd,
    timeout,
    replyTag
  });
}

// ============================================================================
// TOOL EFFECT UNION
// ============================================================================

export type ToolEffect =
  | ExecuteTool
  | ExecuteToolsBatch
  | CancelToolExecution
  | ReadFile
  | WriteFile
  | ListDirectory
  | RunBash;

/**
 * Type guard for tool effects.
 */
export function isToolEffect(effect: { type: string }): effect is ToolEffect {
  return [
    'EXECUTE_TOOL',
    'EXECUTE_TOOLS_BATCH',
    'CANCEL_TOOL_EXECUTION',
    'READ_FILE',
    'WRITE_FILE',
    'LIST_DIRECTORY',
    'RUN_BASH'
  ].includes(effect.type);
}

// ============================================================================
// TOOL DEFINITIONS (For API)
// ============================================================================

/**
 * Standard tool names available in the system.
 */
export const TOOL_NAMES = Object.freeze({
  BASH: 'bash',
  READ_FILE: 'str_replace_based_edit_tool',
  WRITE_FILE: 'str_replace_based_edit_tool',
  LIST_FILES: 'list_files',
  SEARCH: 'search',
  MEMORY: 'memory'
} as const);

export type ToolName = typeof TOOL_NAMES[keyof typeof TOOL_NAMES];
