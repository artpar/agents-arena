/**
 * Tool System Entry Point
 *
 * Registers all client-side tools and exports utilities for tool management.
 */

// Export types
export * from './types.js';

// Export registry
export { toolRegistry } from './registry.js';

// Export individual tools
export { memoryTool } from './memory-tool.js';
export { textEditorTool } from './text-editor-tool.js';
export { bashTool } from './bash-tool.js';

// Export server-side tools
export {
  webSearchDefinition,
  getServerToolDefinitions,
  isServerTool
} from './server-tools.js';

// Import for registration
import { toolRegistry } from './registry.js';
import { memoryTool } from './memory-tool.js';
import { textEditorTool } from './text-editor-tool.js';
import { bashTool } from './bash-tool.js';
import { getServerToolDefinitions, isServerTool } from './server-tools.js';
import { ToolDefinition, ToolContext, ToolResult } from './types.js';

/**
 * Initialize and register all tools.
 * Call this once at startup.
 */
export function initializeTools(): void {
  // Register client-side tools
  toolRegistry.register(memoryTool);
  toolRegistry.register(textEditorTool);
  toolRegistry.register(bashTool);

  console.log(`Initialized ${toolRegistry.size} client-side tools`);
}

/**
 * Get all tool definitions for Anthropic API (both client and server-side).
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  const clientTools = toolRegistry.getDefinitions();
  const serverTools = getServerToolDefinitions();
  return [...clientTools, ...serverTools];
}

/**
 * Execute a tool by name.
 * Server-side tools are not executed here - they're handled by Anthropic.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (isServerTool(name)) {
    // Server-side tools are handled by Anthropic API
    return {
      content: `Server-side tool "${name}" is executed by Anthropic API`,
      is_error: false
    };
  }

  return toolRegistry.execute(name, input, ctx);
}

/**
 * Create workspace directory path for an agent.
 */
export function getAgentWorkspace(roomId: string, agentId: string): string {
  // Workspace is relative to data directory
  return `data/workspaces/${roomId}/${agentId}`;
}

/**
 * Get shared workspace directory path for a room.
 */
export function getSharedWorkspace(roomId: string): string {
  return `data/workspaces/${roomId}/shared`;
}
