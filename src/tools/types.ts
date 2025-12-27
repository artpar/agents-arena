/**
 * Tool system types following Anthropic's tool-use specification.
 * Supports both client-side tools (we execute) and server-side tools (Anthropic executes).
 */

/**
 * Context passed to tools during execution.
 */
export interface ToolContext {
  roomId: string;
  agentId: string;
  agentName: string;
  workDir: string;    // Agent's private workspace directory
  sharedDir: string;  // Shared workspace directory for the room
}

/**
 * Result returned from tool execution.
 */
export interface ToolResult {
  content: string;
  is_error?: boolean;
}

/**
 * Tool definition in Anthropic API format.
 * For schema-less built-in tools, use `type` (e.g., "bash_20250124").
 * For custom tools, use `name`, `description`, and `input_schema`.
 */
export interface ToolDefinition {
  // For built-in schema-less tools like bash, text_editor
  type?: string;  // e.g., "bash_20250124", "text_editor_20250728"

  // Tool name (required)
  name: string;

  // Description (optional for schema-less tools)
  description?: string;

  // Input schema (optional for schema-less tools)
  input_schema?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool implementation interface.
 * Each tool must provide a definition and execute function.
 */
export interface Tool {
  /**
   * Tool definition for Anthropic API.
   */
  definition: ToolDefinition;

  /**
   * Execute the tool with given input and context.
   * @param input - Tool input parameters from Claude
   * @param ctx - Execution context with room/agent info
   * @returns Result containing content string and optional error flag
   */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Tool use block from Anthropic API response.
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result block to send back to Anthropic API.
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
