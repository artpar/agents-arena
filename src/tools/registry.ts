/**
 * Tool Registry - manages registration and execution of tools.
 * Follows the registry pattern for extensibility.
 */

import { Tool, ToolDefinition, ToolContext, ToolResult } from './types.js';

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  /**
   * Register a tool with the registry.
   */
  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
    console.log(`Registered tool: ${tool.definition.name}`);
  }

  /**
   * Get a tool by name.
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool names.
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all tool definitions for Anthropic API.
   */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /**
   * Execute a tool by name.
   * @param name - Tool name
   * @param input - Tool input parameters
   * @param ctx - Execution context
   * @returns Tool result
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        content: `Error: Unknown tool "${name}". Available tools: ${this.getToolNames().join(', ')}`,
        is_error: true
      };
    }

    try {
      return await tool.execute(input, ctx);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: `Error executing tool "${name}": ${errorMessage}`,
        is_error: true
      };
    }
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get the number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();
