/**
 * Tools Boundary
 *
 * Executes tool effects (file system, bash, etc). This is where actual I/O happens.
 *
 * BOUNDARY PRINCIPLE:
 * - Pure interpreters produce ToolEffect values
 * - This boundary executes them (file I/O, process spawning)
 * - Results are returned as values for the runtime to route
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  ToolEffect,
  isToolEffect,
  ExecuteTool,
  ExecuteToolsBatch,
  CancelToolExecution,
  ReadFile,
  WriteFile,
  ListDirectory,
  RunBash,
  ToolContext,
  ToolResult,
  successResult as toolSuccess,
  errorResult as toolError
} from '../effects/tools.js';
import {
  EffectResult,
  EffectExecutor,
  successResult,
  failureResult,
  Logger
} from './types.js';
import { Effect } from '../effects/index.js';

// ============================================================================
// TOOLS EXECUTOR
// ============================================================================

/**
 * Tool execution state.
 */
export interface ToolsState {
  readonly pendingExecutions: Map<string, AbortController>;
  readonly maxExecutionTime: number;
}

/**
 * Create tools state.
 */
export function createToolsState(maxExecutionTime: number = 30000): ToolsState {
  return {
    pendingExecutions: new Map(),
    maxExecutionTime
  };
}

/**
 * Create a tools effect executor.
 */
export function createToolsExecutor(
  toolsState: ToolsState,
  logger: Logger,
  onToolResult?: (agentId: string, roomId: string, results: ToolResult[], replyTag: string) => void
): EffectExecutor {
  return {
    canHandle(effect: Effect): boolean {
      return isToolEffect(effect);
    },

    async execute(effect: Effect): Promise<EffectResult> {
      if (!isToolEffect(effect)) {
        return failureResult(effect, 'Not a tool effect', 0);
      }

      const start = Date.now();

      try {
        const result = await executeToolEffect(
          toolsState,
          effect as ToolEffect,
          logger
        );

        // Route tool results back to agent if callback provided
        if (onToolResult && effect.type === 'EXECUTE_TOOL') {
          const execEffect = effect as ExecuteTool;
          const toolResult = result as ToolResult;
          onToolResult(
            execEffect.context.agentId,
            'general', // TODO: Get actual room from context
            [toolResult],
            execEffect.replyTag
          );
        } else if (onToolResult && effect.type === 'EXECUTE_TOOLS_BATCH') {
          const batchEffect = effect as ExecuteToolsBatch;
          const toolResults = result as readonly ToolResult[];
          onToolResult(
            batchEffect.context.agentId,
            'general', // TODO: Get actual room from context
            [...toolResults],
            batchEffect.replyTag
          );
        }

        return successResult(effect, result, Date.now() - start);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Tool effect failed', { effect: effect.type, error });
        return failureResult(effect, error, Date.now() - start);
      }
    }
  };
}

/**
 * Execute a tool effect.
 */
async function executeToolEffect(
  state: ToolsState,
  effect: ToolEffect,
  logger: Logger
): Promise<unknown> {
  switch (effect.type) {
    case 'EXECUTE_TOOL':
      return executeSingleTool(state, effect, logger);

    case 'EXECUTE_TOOLS_BATCH':
      return executeToolsBatch(state, effect, logger);

    case 'CANCEL_TOOL_EXECUTION':
      return cancelToolExecution(state, effect, logger);

    case 'READ_FILE':
      return readFile(effect, logger);

    case 'WRITE_FILE':
      return writeFile(effect, logger);

    case 'LIST_DIRECTORY':
      return listDirectory(effect, logger);

    case 'RUN_BASH':
      return runBash(state, effect, logger);

    default:
      const _exhaustive: never = effect;
      throw new Error('Unknown tool effect type');
  }
}

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

/**
 * Execute a single tool.
 */
async function executeSingleTool(
  state: ToolsState,
  effect: ExecuteTool,
  logger: Logger
): Promise<ToolResult> {
  const { toolUseId, toolName, input, context } = effect;
  const start = Date.now();

  logger.debug('Executing tool', { toolName, toolUseId, agentId: context.agentId });

  try {
    const result = await dispatchTool(state, toolName, input, context, logger);
    return toolSuccess(
      toolUseId,
      toolName,
      result.content,
      result.artifacts,
      Date.now() - start
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Tool execution failed', { toolName, toolUseId, error });
    return toolError(toolUseId, toolName, error, Date.now() - start);
  }
}

/**
 * Execute multiple tools in parallel.
 */
async function executeToolsBatch(
  state: ToolsState,
  effect: ExecuteToolsBatch,
  logger: Logger
): Promise<readonly ToolResult[]> {
  const { tools, context } = effect;

  logger.debug('Executing tools batch', {
    count: tools.length,
    agentId: context.agentId
  });

  const results = await Promise.all(
    tools.map(tool =>
      executeSingleTool(
        state,
        {
          type: 'EXECUTE_TOOL',
          toolUseId: tool.toolUseId,
          toolName: tool.toolName,
          input: tool.input,
          context,
          replyTag: effect.replyTag
        },
        logger
      )
    )
  );

  return Object.freeze(results);
}

/**
 * Cancel a running tool execution.
 */
function cancelToolExecution(
  state: ToolsState,
  effect: CancelToolExecution,
  logger: Logger
): { cancelled: boolean } {
  const { toolUseId, reason } = effect;

  const controller = state.pendingExecutions.get(toolUseId);
  if (controller) {
    controller.abort();
    state.pendingExecutions.delete(toolUseId);
    logger.info('Cancelled tool execution', { toolUseId, reason });
    return { cancelled: true };
  }

  return { cancelled: false };
}

/**
 * Read a file.
 */
async function readFile(
  effect: ReadFile,
  logger: Logger
): Promise<{ content: string }> {
  const { path: filePath } = effect;

  logger.debug('Reading file', { path: filePath });

  const content = await fs.readFile(filePath, 'utf-8');
  return { content };
}

/**
 * Write a file.
 */
async function writeFile(
  effect: WriteFile,
  logger: Logger
): Promise<{ written: boolean; path: string }> {
  const { path: filePath, content } = effect;

  logger.debug('Writing file', { path: filePath, size: content.length });

  // Ensure directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');

  return { written: true, path: filePath };
}

/**
 * List directory contents.
 */
async function listDirectory(
  effect: ListDirectory,
  logger: Logger
): Promise<{ entries: readonly string[] }> {
  const { path: dirPath } = effect;

  logger.debug('Listing directory', { path: dirPath });

  const entries = await fs.readdir(dirPath);
  return { entries: Object.freeze(entries) };
}

/**
 * Run a bash command.
 */
async function runBash(
  state: ToolsState,
  effect: RunBash,
  logger: Logger
): Promise<BashResult> {
  const { command, cwd, timeout } = effect;
  const effectiveTimeout = timeout ?? state.maxExecutionTime;

  logger.debug('Running bash command', { command, cwd, timeout: effectiveTimeout });

  return new Promise((resolve, reject) => {
    const abortController = new AbortController();
    const child = spawn('bash', ['-c', command], {
      cwd: cwd ?? process.cwd(),
      signal: abortController.signal,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Command timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({
        exitCode: code ?? 0,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

// ============================================================================
// TOOL DISPATCH
// ============================================================================

interface ToolExecutionResult {
  content: string;
  artifacts?: readonly string[];
}

/**
 * Dispatch to the appropriate tool handler.
 */
async function dispatchTool(
  state: ToolsState,
  toolName: string,
  input: unknown,
  context: ToolContext,
  logger: Logger
): Promise<ToolExecutionResult> {
  const inp = input as Record<string, unknown>;

  switch (toolName) {
    case 'bash':
      return handleBashTool(state, inp, context, logger);

    case 'str_replace_based_edit_tool':
      return handleEditTool(inp, context, logger);

    case 'list_files':
      return handleListFilesTool(inp, context, logger);

    case 'read_file':
      return handleReadFileTool(inp, context, logger);

    case 'write_file':
      return handleWriteFileTool(inp, context, logger);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Handle bash tool.
 */
async function handleBashTool(
  state: ToolsState,
  input: Record<string, unknown>,
  context: ToolContext,
  logger: Logger
): Promise<ToolExecutionResult> {
  const command = input.command as string;
  const timeout = input.timeout as number | undefined;

  const result = await runBash(
    state,
    {
      type: 'RUN_BASH',
      command,
      cwd: context.workspacePath,
      timeout,
      replyTag: ''
    },
    logger
  );

  if (result.exitCode !== 0) {
    return {
      content: `Exit code: ${result.exitCode}\n\nStdout:\n${result.stdout}\n\nStderr:\n${result.stderr}`
    };
  }

  return { content: result.stdout || '(no output)' };
}

/**
 * Handle str_replace_based_edit_tool (edit file).
 */
async function handleEditTool(
  input: Record<string, unknown>,
  context: ToolContext,
  logger: Logger
): Promise<ToolExecutionResult> {
  const command = input.command as string;
  const filePath = input.path as string;
  const fullPath = resolvePath(filePath, context);

  switch (command) {
    case 'view': {
      const viewRange = input.view_range as [number, number] | undefined;
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      if (viewRange) {
        const [start, end] = viewRange;
        const selected = lines.slice(start - 1, end);
        return {
          content: selected.map((line, i) => `${start + i}: ${line}`).join('\n')
        };
      }

      return {
        content: lines.map((line, i) => `${i + 1}: ${line}`).join('\n')
      };
    }

    case 'create': {
      const fileText = input.file_text as string;
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, fileText, 'utf-8');
      return {
        content: `File created: ${filePath}`,
        artifacts: [filePath]
      };
    }

    case 'str_replace': {
      const oldStr = input.old_str as string;
      const newStr = input.new_str as string;
      const content = await fs.readFile(fullPath, 'utf-8');

      if (!content.includes(oldStr)) {
        throw new Error(`String not found in file: "${oldStr.slice(0, 50)}..."`);
      }

      const newContent = content.replace(oldStr, newStr);
      await fs.writeFile(fullPath, newContent, 'utf-8');

      return {
        content: `Replaced in ${filePath}`,
        artifacts: [filePath]
      };
    }

    case 'insert': {
      const insertLine = input.insert_line as number;
      const newStr = input.new_str as string;
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');

      lines.splice(insertLine, 0, newStr);
      await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');

      return {
        content: `Inserted at line ${insertLine} in ${filePath}`,
        artifacts: [filePath]
      };
    }

    default:
      throw new Error(`Unknown edit command: ${command}`);
  }
}

/**
 * Handle list_files tool.
 */
async function handleListFilesTool(
  input: Record<string, unknown>,
  context: ToolContext,
  logger: Logger
): Promise<ToolExecutionResult> {
  const dirPath = input.path as string || '.';
  const fullPath = resolvePath(dirPath, context);

  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const formatted = entries.map(e => {
    const suffix = e.isDirectory() ? '/' : '';
    return `${e.name}${suffix}`;
  });

  return { content: formatted.join('\n') };
}

/**
 * Handle read_file tool.
 */
async function handleReadFileTool(
  input: Record<string, unknown>,
  context: ToolContext,
  logger: Logger
): Promise<ToolExecutionResult> {
  const filePath = input.path as string;
  const fullPath = resolvePath(filePath, context);

  const content = await fs.readFile(fullPath, 'utf-8');
  return { content };
}

/**
 * Handle write_file tool.
 */
async function handleWriteFileTool(
  input: Record<string, unknown>,
  context: ToolContext,
  logger: Logger
): Promise<ToolExecutionResult> {
  const filePath = input.path as string;
  const content = input.content as string;
  const fullPath = resolvePath(filePath, context);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');

  return {
    content: `File written: ${filePath}`,
    artifacts: [filePath]
  };
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Resolve a path relative to workspace.
 */
function resolvePath(filePath: string, context: ToolContext): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.join(context.workspacePath, filePath);
}

/**
 * Bash execution result.
 */
interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
