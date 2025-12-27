/**
 * Memory Tool - Persistent storage for agents following Anthropic's memory_20250818 spec.
 * Provides file-like storage that persists across conversations.
 *
 * Commands:
 *   - view: Show file contents with line numbers
 *   - create: Create a new file
 *   - str_replace: Replace text in a file
 *   - insert: Insert text at a specific line
 *   - delete: Delete a file
 *   - rename: Rename a file
 */

import { Tool, ToolContext, ToolResult } from './types.js';
import {
  createArtifact,
  getArtifact,
  listArtifacts,
  listAllArtifactsInRoom,
  updateArtifact,
  deleteArtifact,
  renameArtifact,
  artifactExists
} from '../core/database.js';
import { randomUUID } from 'crypto';

interface MemoryInput {
  command: 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename';
  path?: string;
  file_text?: string;           // For create
  old_str?: string;             // For str_replace
  new_str?: string;             // For str_replace
  insert_line?: number;         // For insert
  new_path?: string;            // For rename
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
 * Normalize path and detect if it's a shared path.
 * Shared paths start with /shared/
 */
function normalizePath(path: string): { path: string; isShared: boolean } {
  let normalizedPath = path;
  if (!normalizedPath.startsWith('/')) {
    normalizedPath = '/' + normalizedPath;
  }

  const isShared = normalizedPath.startsWith('/shared/');

  return { path: normalizedPath, isShared };
}

/**
 * Get the effective agent ID for storage (use room-level for shared).
 */
function getStorageAgentId(agentId: string, isShared: boolean): string {
  return isShared ? '_shared_' : agentId;
}

export const memoryTool: Tool = {
  definition: {
    // Memory is a custom tool (not a built-in schema-less type)
    name: 'memory',
    description: 'Persistent storage for notes, plans, and files that persist across conversations. Use this to remember important information.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
          description: 'The command to execute'
        },
        path: {
          type: 'string',
          description: 'Path to the file (e.g., /notes/plan.md)'
        },
        file_text: {
          type: 'string',
          description: 'Content for create command'
        },
        old_str: {
          type: 'string',
          description: 'String to replace (for str_replace command)'
        },
        new_str: {
          type: 'string',
          description: 'Replacement string (for str_replace command)'
        },
        insert_line: {
          type: 'number',
          description: 'Line number to insert at (for insert command)'
        },
        new_path: {
          type: 'string',
          description: 'New path for rename command'
        },
        view_range: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional [start, end] line range for view command'
        }
      },
      required: ['command']
    }
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const { command, path, file_text, old_str, new_str, insert_line, new_path, view_range } = input as MemoryInput;

    // List files if no path for view command
    if (command === 'view' && !path) {
      const privateArtifacts = listArtifacts(ctx.roomId, ctx.agentId);
      const sharedArtifacts = listArtifacts(ctx.roomId, '_shared_');
      // Show ALL files in room so agents can see what others have created
      const allArtifacts = listAllArtifactsInRoom(ctx.roomId, ctx.agentId);

      let result = '';
      if (privateArtifacts.length > 0) {
        result += `Your files:\n${privateArtifacts.map(a => `  ${a.path}`).join('\n')}\n`;
      }
      if (sharedArtifacts.length > 0) {
        result += `\nShared files:\n${sharedArtifacts.map(a => `  ${a.path}`).join('\n')}\n`;
      }
      if (allArtifacts.length > 0) {
        result += `\nOther agents' files (read-only):\n${allArtifacts.map(a => `  [${a.agentName}] ${a.path}`).join('\n')}`;
      }
      if (!result) {
        return { content: 'No files found. Use create to add files. Use /shared/ prefix to share.' };
      }
      return { content: result.trim() };
    }

    // Path is required for all other operations
    if (!path) {
      return { content: 'Error: path is required', is_error: true };
    }

    const { path: normalizedPath, isShared } = normalizePath(path);
    const storageAgentId = getStorageAgentId(ctx.agentId, isShared);
    const locationLabel = isShared ? '(shared)' : '(private)';

    switch (command) {
      case 'view': {
        const artifact = getArtifact(ctx.roomId, storageAgentId, normalizedPath);
        if (!artifact) {
          // Try listing files with this prefix (directory-like behavior)
          const privateFiles = listArtifacts(ctx.roomId, storageAgentId);
          const sharedFiles = listArtifacts(ctx.roomId, '_shared_');
          const allFiles = [...privateFiles, ...sharedFiles];
          const pathPrefix = normalizedPath.endsWith('/') ? normalizedPath : normalizedPath + '/';
          const matching = allFiles.filter(a => a.path.startsWith(pathPrefix) || a.path === normalizedPath);

          if (matching.length > 0) {
            return { content: `Files under ${normalizedPath}/:\n${matching.map(a => `  ${a.path}`).join('\n')}` };
          }
          return { content: `Error: No files found at ${normalizedPath}. Use 'view' without path to list all files, or create a file with 'create'.`, is_error: true };
        }

        let displayContent = artifact.content;
        let startLine = 1;

        if (view_range && Array.isArray(view_range) && view_range.length === 2) {
          const rangeResult = getLineRange(artifact.content, view_range as [number, number]);
          displayContent = rangeResult.content;
          startLine = rangeResult.startLine;
        }

        const numbered = addLineNumbers(displayContent, startLine);
        return { content: `File ${locationLabel}: ${normalizedPath}\n\n${numbered}` };
      }

      case 'create': {
        if (file_text === undefined) {
          return { content: 'Error: file_text is required for create command', is_error: true };
        }

        if (artifactExists(ctx.roomId, storageAgentId, normalizedPath)) {
          return { content: `Error: File already exists: ${normalizedPath}. Use str_replace to modify.`, is_error: true };
        }

        createArtifact({
          id: randomUUID(),
          roomId: ctx.roomId,
          agentId: storageAgentId,
          path: normalizedPath,
          content: file_text
        });

        return { content: `Created file ${locationLabel}: ${normalizedPath}` };
      }

      case 'str_replace': {
        if (old_str === undefined || new_str === undefined) {
          return { content: 'Error: old_str and new_str are required for str_replace command', is_error: true };
        }

        const artifact = getArtifact(ctx.roomId, storageAgentId, normalizedPath);
        if (!artifact) {
          return { content: `Error: File not found: ${normalizedPath}`, is_error: true };
        }

        const occurrences = artifact.content.split(old_str).length - 1;
        if (occurrences === 0) {
          return { content: `Error: old_str not found in file: ${normalizedPath}`, is_error: true };
        }
        if (occurrences > 1) {
          return { content: `Error: old_str found ${occurrences} times. Must be unique. Add more context to make it unique.`, is_error: true };
        }

        const newContent = artifact.content.replace(old_str, new_str);
        updateArtifact(ctx.roomId, storageAgentId, normalizedPath, newContent);

        return { content: `Updated file ${locationLabel}: ${normalizedPath}` };
      }

      case 'insert': {
        if (insert_line === undefined || new_str === undefined) {
          return { content: 'Error: insert_line and new_str are required for insert command', is_error: true };
        }

        const artifact = getArtifact(ctx.roomId, storageAgentId, normalizedPath);
        if (!artifact) {
          return { content: `Error: File not found: ${normalizedPath}`, is_error: true };
        }

        const lines = artifact.content.split('\n');
        const insertIdx = Math.max(0, Math.min(insert_line - 1, lines.length));
        lines.splice(insertIdx, 0, new_str);
        const newContent = lines.join('\n');

        updateArtifact(ctx.roomId, storageAgentId, normalizedPath, newContent);

        return { content: `Inserted text at line ${insert_line} in ${locationLabel}: ${normalizedPath}` };
      }

      case 'delete': {
        if (!artifactExists(ctx.roomId, storageAgentId, normalizedPath)) {
          return { content: `Error: File not found: ${normalizedPath}`, is_error: true };
        }

        deleteArtifact(ctx.roomId, storageAgentId, normalizedPath);
        return { content: `Deleted file ${locationLabel}: ${normalizedPath}` };
      }

      case 'rename': {
        if (!new_path) {
          return { content: 'Error: new_path is required for rename command', is_error: true };
        }

        const { path: normalizedNewPath, isShared: newIsShared } = normalizePath(new_path);
        const newStorageAgentId = getStorageAgentId(ctx.agentId, newIsShared);

        if (!artifactExists(ctx.roomId, storageAgentId, normalizedPath)) {
          return { content: `Error: File not found: ${normalizedPath}`, is_error: true };
        }

        if (artifactExists(ctx.roomId, newStorageAgentId, normalizedNewPath)) {
          return { content: `Error: File already exists at new path: ${normalizedNewPath}`, is_error: true };
        }

        // If moving between private and shared, need to copy and delete
        if (isShared !== newIsShared) {
          const artifact = getArtifact(ctx.roomId, storageAgentId, normalizedPath);
          if (artifact) {
            createArtifact({
              id: randomUUID(),
              roomId: ctx.roomId,
              agentId: newStorageAgentId,
              path: normalizedNewPath,
              content: artifact.content
            });
            deleteArtifact(ctx.roomId, storageAgentId, normalizedPath);
          }
        } else {
          renameArtifact(ctx.roomId, storageAgentId, normalizedPath, normalizedNewPath);
        }

        const newLocationLabel = newIsShared ? '(shared)' : '(private)';
        return { content: `Moved ${normalizedPath} ${locationLabel} to ${normalizedNewPath} ${newLocationLabel}` };
      }

      default:
        return { content: `Error: Unknown command: ${command}`, is_error: true };
    }
  }
};
