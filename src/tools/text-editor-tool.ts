/**
 * Text Editor Tool - File viewing and editing following Anthropic's text_editor_20250728 spec.
 * Operates on files within the agent's sandboxed workspace directory.
 *
 * Commands:
 *   - view: Show file contents with line numbers
 *   - create: Create a new file
 *   - str_replace: Replace text in a file
 *   - insert: Insert text at a specific line
 */

import { Tool, ToolContext, ToolResult } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, relative } from 'path';

interface TextEditorInput {
  command: 'view' | 'create' | 'str_replace' | 'insert';
  path: string;
  file_text?: string;           // For create
  old_str?: string;             // For str_replace
  new_str?: string;             // For str_replace and insert
  insert_line?: number;         // For insert
  view_range?: [number, number]; // For view (optional line range)
}

/**
 * Add line numbers to content for display.
 */
function addLineNumbers(content: string, startLine: number = 1): string {
  const lines = content.split('\n');
  const maxLineNum = startLine + lines.length - 1;
  const padWidth = String(maxLineNum).length;

  return lines.map((line, idx) => {
    const lineNum = String(startLine + idx).padStart(padWidth, ' ');
    return `${lineNum}\t${line}`;
  }).join('\n');
}

/**
 * Get a range of lines from content.
 */
function getLineRange(content: string, range: [number, number]): { content: string; startLine: number } {
  const lines = content.split('\n');
  const [start, end] = range;

  // Validate range (1-indexed)
  const startIdx = Math.max(0, start - 1);
  const endIdx = Math.min(lines.length, end);

  return {
    content: lines.slice(startIdx, endIdx).join('\n'),
    startLine: startIdx + 1
  };
}

/**
 * Resolve and validate a path within the workspace.
 * Handles /shared/ paths for shared workspace access.
 * Prevents path traversal attacks.
 */
function resolveSafePath(workDir: string, sharedDir: string, filePath: string): { path: string; isShared: boolean } | null {
  // Check if this is a shared path
  const isShared = filePath.startsWith('/shared/') || filePath.startsWith('shared/');
  const baseDir = isShared ? sharedDir : workDir;

  // Normalize the path (remove /shared/ prefix if present)
  let normalizedPath = filePath;
  if (isShared) {
    normalizedPath = filePath.replace(/^\/?shared\//, '');
  } else if (filePath.startsWith('/')) {
    normalizedPath = filePath.slice(1);
  }

  const fullPath = resolve(baseDir, normalizedPath);

  // Ensure the resolved path is within the base directory
  const relativePath = relative(baseDir, fullPath);
  if (relativePath.startsWith('..') || resolve(baseDir, relativePath) !== fullPath) {
    return null; // Path traversal attempt
  }

  return { path: fullPath, isShared };
}

/**
 * Ensure the workspace directory exists.
 */
function ensureWorkspace(workDir: string): void {
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }
}

/**
 * List files in directory recursively (for view without path).
 */
function listFiles(dir: string, prefix: string = ''): string[] {
  const files: string[] = [];

  if (!existsSync(dir)) {
    return files;
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(join(dir, entry.name), path));
    } else {
      files.push(path);
    }
  }

  return files;
}

export const textEditorTool: Tool = {
  // Schema-less built-in tool - Anthropic provides the schema automatically
  definition: {
    type: 'text_editor_20250728',
    name: 'str_replace_based_edit_tool'
    // Note: No description or input_schema for built-in schema-less tools
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const { command, path, file_text, old_str, new_str, insert_line, view_range } = input as TextEditorInput;

    // Ensure workspaces exist
    ensureWorkspace(ctx.workDir);
    ensureWorkspace(ctx.sharedDir);

    // List files if path is '.' or empty for view command
    if (command === 'view' && (!path || path === '.' || path === '/')) {
      const privateFiles = listFiles(ctx.workDir);
      const sharedFiles = listFiles(ctx.sharedDir);
      let result = '';
      if (privateFiles.length > 0) {
        result += `Private files:\n${privateFiles.map(f => `  ${f}`).join('\n')}\n`;
      }
      if (sharedFiles.length > 0) {
        result += `\nShared files (use /shared/ prefix):\n${sharedFiles.map(f => `  /shared/${f}`).join('\n')}`;
      }
      if (!result) {
        return { content: 'Both private and shared workspaces are empty.\nUse the create command to add files.' };
      }
      return { content: result.trim() };
    }

    // Resolve safe path (handles /shared/ prefix)
    const resolved = resolveSafePath(ctx.workDir, ctx.sharedDir, path);
    if (!resolved) {
      return { content: 'Error: Invalid path. Path traversal is not allowed.', is_error: true };
    }
    const { path: safePath, isShared } = resolved;
    const locationLabel = isShared ? '(shared)' : '(private)';

    switch (command) {
      case 'view': {
        if (!existsSync(safePath)) {
          return { content: `Error: File not found: ${path}`, is_error: true };
        }

        const stat = statSync(safePath);
        if (stat.isDirectory()) {
          const files = listFiles(safePath);
          if (files.length === 0) {
            return { content: `Directory is empty: ${path}` };
          }
          return { content: `Files in ${path}:\n${files.map(f => `  ${f}`).join('\n')}` };
        }

        const content = readFileSync(safePath, 'utf-8');
        let displayContent = content;
        let startLine = 1;

        if (view_range && Array.isArray(view_range) && view_range.length === 2) {
          const rangeResult = getLineRange(content, view_range as [number, number]);
          displayContent = rangeResult.content;
          startLine = rangeResult.startLine;
        }

        const numbered = addLineNumbers(displayContent, startLine);
        const totalLines = content.split('\n').length;
        return { content: `File ${locationLabel}: ${path} (${totalLines} lines)\n\n${numbered}` };
      }

      case 'create': {
        if (file_text === undefined) {
          return { content: 'Error: file_text is required for create command', is_error: true };
        }

        if (existsSync(safePath)) {
          return { content: `Error: File already exists: ${path}. Use str_replace to modify.`, is_error: true };
        }

        // Ensure parent directory exists
        const parentDir = dirname(safePath);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }

        writeFileSync(safePath, file_text, 'utf-8');
        return { content: `Created file ${locationLabel}: ${path}` };
      }

      case 'str_replace': {
        if (old_str === undefined || new_str === undefined) {
          return { content: 'Error: old_str and new_str are required for str_replace command', is_error: true };
        }

        if (!existsSync(safePath)) {
          return { content: `Error: File not found: ${path}`, is_error: true };
        }

        const content = readFileSync(safePath, 'utf-8');
        const occurrences = content.split(old_str).length - 1;

        if (occurrences === 0) {
          return { content: `Error: old_str not found in file: ${path}`, is_error: true };
        }
        if (occurrences > 1) {
          return { content: `Error: old_str found ${occurrences} times. Must be unique. Add more surrounding context to make it unique.`, is_error: true };
        }

        const newContent = content.replace(old_str, new_str);
        writeFileSync(safePath, newContent, 'utf-8');

        return { content: `Updated file ${locationLabel}: ${path}` };
      }

      case 'insert': {
        if (insert_line === undefined || new_str === undefined) {
          return { content: 'Error: insert_line and new_str are required for insert command', is_error: true };
        }

        if (!existsSync(safePath)) {
          return { content: `Error: File not found: ${path}`, is_error: true };
        }

        const content = readFileSync(safePath, 'utf-8');
        const lines = content.split('\n');
        const insertIdx = Math.max(0, Math.min(insert_line - 1, lines.length));
        lines.splice(insertIdx, 0, new_str);
        const newContent = lines.join('\n');

        writeFileSync(safePath, newContent, 'utf-8');

        return { content: `Inserted text at line ${insert_line} in ${locationLabel}: ${path}` };
      }

      default:
        return { content: `Error: Unknown command: ${command}`, is_error: true };
    }
  }
};
