/**
 * Server-Side Tools - Tools executed by Anthropic's API.
 *
 * These tools don't require client-side implementation - we just include
 * their definitions in the tools array and Anthropic handles execution.
 *
 * The API returns `server_tool_use` blocks which we don't need to handle;
 * results are automatically included in the response.
 */

import { ToolDefinition } from './types.js';

/**
 * Web Search Tool (server-side)
 * Type: web_search_20250305
 *
 * Allows Claude to search the web for current information.
 * Results include citations that Claude can reference.
 */
export const webSearchDefinition: ToolDefinition = {
  type: 'web_search_20250305',
  name: 'web_search'
};

// Note: web_fetch requires beta access - commenting out for now
// export const webFetchDefinition: ToolDefinition = {
//   type: 'web_fetch_20250910',
//   name: 'web_fetch'
// };

/**
 * Get all server-side tool definitions.
 */
export function getServerToolDefinitions(): ToolDefinition[] {
  return [
    webSearchDefinition
    // webFetchDefinition - requires beta access
  ];
}

/**
 * Check if a tool name is a server-side tool.
 */
export function isServerTool(name: string): boolean {
  return name === 'web_search';
}
