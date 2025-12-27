/**
 * Bash Tool - Execute shell commands following Anthropic's bash_20250124 spec.
 * Sandboxed to agent's workspace with timeout and output limits.
 */

import { Tool, ToolContext, ToolResult } from './types.js';
import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';

interface BashInput {
  command: string;
  restart?: boolean;
  timeout?: number;
}

// Maximum output size (10KB)
const MAX_OUTPUT_SIZE = 10000;

// Default timeout (30 seconds)
const DEFAULT_TIMEOUT = 30000;

// Dangerous command patterns to block
const DANGEROUS_PATTERNS = [
  /^\s*rm\s+(-rf?|--force)\s+[\/~]/i,  // rm -rf /
  /^\s*sudo\s+/i,                        // sudo commands
  /^\s*mkfs\s+/i,                        // format disk
  /^\s*dd\s+if=/i,                       // dd dangerous
  />\s*\/dev\//i,                        // write to /dev
  /^\s*:(){ :\|:& };:/,                  // fork bomb
  /^\s*chmod\s+-R?\s+777\s+\//i,         // chmod 777 /
  /^\s*chown\s+-R?\s+.*\s+\//i,          // chown /
];

/**
 * Check if a command is potentially dangerous.
 */
function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some(pattern => pattern.test(command));
}

/**
 * Truncate output if it exceeds the maximum size.
 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_SIZE) {
    return output;
  }
  const half = Math.floor(MAX_OUTPUT_SIZE / 2) - 50;
  return `${output.slice(0, half)}\n\n[...truncated ${output.length - MAX_OUTPUT_SIZE} characters...]\n\n${output.slice(-half)}`;
}

/**
 * Ensure the workspace directory exists.
 */
function ensureWorkspace(workDir: string): void {
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }
}

export const bashTool: Tool = {
  // Schema-less built-in tool - Anthropic provides the schema automatically
  definition: {
    type: 'bash_20250124',
    name: 'bash'
    // Note: No description or input_schema for built-in schema-less tools
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const { command, timeout } = input as BashInput;

    if (!command || typeof command !== 'string') {
      return { content: 'Error: command is required', is_error: true };
    }

    // Check for dangerous commands
    if (isDangerous(command)) {
      return {
        content: 'Error: This command has been blocked for safety. Dangerous operations affecting system directories are not allowed.',
        is_error: true
      };
    }

    // Ensure workspace exists
    ensureWorkspace(ctx.workDir);

    // Calculate timeout (max 2 minutes)
    const timeoutMs = Math.min(timeout || DEFAULT_TIMEOUT, 120000);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      // Ensure shared directory exists
      if (!existsSync(ctx.sharedDir)) {
        mkdirSync(ctx.sharedDir, { recursive: true });
      }

      // Spawn bash with the command
      const proc = spawn('bash', ['-c', command], {
        cwd: ctx.workDir,
        env: {
          ...process.env,
          HOME: ctx.workDir,
          USER: ctx.agentName,
          AGENT_ID: ctx.agentId,
          ROOM_ID: ctx.roomId,
          SHARED_DIR: ctx.sharedDir,  // Access to shared directory
          // Limit PATH to safe directories
          PATH: '/usr/local/bin:/usr/bin:/bin'
        },
        timeout: timeoutMs
      });

      // Timeout handler
      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 1000);
      }, timeoutMs);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        // Early truncation if output is way too large
        if (stdout.length > MAX_OUTPUT_SIZE * 2) {
          stdout = stdout.slice(-MAX_OUTPUT_SIZE);
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE * 2) {
          stderr = stderr.slice(-MAX_OUTPUT_SIZE);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);

        let output = '';

        if (killed) {
          output = `Command timed out after ${timeoutMs / 1000}s\n`;
        }

        if (stdout) {
          output += truncateOutput(stdout);
        }

        if (stderr) {
          output += (output ? '\n\nSTDERR:\n' : '') + truncateOutput(stderr);
        }

        if (!output) {
          output = code === 0 ? '(no output)' : `Command exited with code ${code}`;
        }

        resolve({
          content: output.trim(),
          is_error: code !== 0 || killed
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          content: `Error executing command: ${err.message}`,
          is_error: true
        });
      });
    });
  }
};
