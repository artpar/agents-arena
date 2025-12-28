/**
 * Anthropic API Effects
 *
 * Effects that describe calls to the Anthropic Claude API.
 * These are DATA describing what to do, not the execution.
 * The boundary executor will actually make the HTTP calls.
 */

import { AgentId, RoomId } from '../values/index.js';

// ============================================================================
// API REQUEST TYPES (Immutable values for API calls)
// ============================================================================

/**
 * Content block for text.
 */
export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Content block for images.
 */
export interface ImageContent {
  readonly type: 'image';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    readonly data: string;
  };
}

/**
 * Content block for tool use requests.
 */
export interface ToolUseContent {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Content block for tool results.
 */
export interface ToolResultContent {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent;

/**
 * A message in the conversation.
 */
export interface ApiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly ContentBlock[];
}

/**
 * Tool definition for the API.
 * Built-in tools use `type` (e.g., "bash_20250124").
 * Custom tools use `description` and `input_schema`.
 */
export interface ApiToolDefinition {
  readonly name: string;
  readonly type?: string;  // For built-in schema-less tools
  readonly description?: string;
  readonly input_schema?: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
}

/**
 * Complete request to send to the Anthropic API.
 */
export interface AnthropicRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: string;
  readonly messages: readonly ApiMessage[];
  readonly tools?: readonly ApiToolDefinition[];
  readonly temperature?: number;
}

/**
 * Create an Anthropic request value.
 */
export function createAnthropicRequest(params: {
  model: string;
  messages: readonly ApiMessage[];
  system?: string;
  tools?: readonly ApiToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}): AnthropicRequest {
  return Object.freeze({
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    system: params.system,
    messages: Object.freeze([...params.messages]),
    tools: params.tools ? Object.freeze([...params.tools]) : undefined,
    temperature: params.temperature
  });
}

// ============================================================================
// API RESPONSE TYPES (Immutable values from API)
// ============================================================================

/**
 * Text block in response.
 */
export interface ResponseTextBlock {
  readonly type: 'text';
  readonly text: string;
}

/**
 * Tool use block in response.
 */
export interface ResponseToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Server tool use block in response (for server-side tools like web_search).
 */
export interface ResponseServerToolUseBlock {
  readonly type: 'server_tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Web search tool result block.
 */
export interface ResponseWebSearchToolResultBlock {
  readonly type: 'web_search_tool_result';
  readonly tool_use_id: string;
  readonly content: unknown;
}

export type ResponseContentBlock =
  | ResponseTextBlock
  | ResponseToolUseBlock
  | ResponseServerToolUseBlock
  | ResponseWebSearchToolResultBlock;

/**
 * Usage information from API.
 */
export interface ApiUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/**
 * Stop reason from API.
 */
export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

/**
 * Response from the Anthropic API.
 */
export interface AnthropicResponse {
  readonly id: string;
  readonly model: string;
  readonly content: readonly ResponseContentBlock[];
  readonly stop_reason: StopReason;
  readonly usage: ApiUsage;
}

// ============================================================================
// API EFFECT
// ============================================================================

/**
 * Effect to call the Anthropic API.
 */
export interface CallAnthropic {
  readonly type: 'CALL_ANTHROPIC';
  readonly agentId: AgentId;         // Which agent is making this call
  readonly request: AnthropicRequest;
  readonly replyTag: string;         // Tag to correlate response
  readonly roomId: RoomId;           // Room to broadcast response to
}

export function callAnthropic(
  agentId: AgentId,
  request: AnthropicRequest,
  replyTag: string,
  roomId: RoomId
): CallAnthropic {
  return Object.freeze({
    type: 'CALL_ANTHROPIC',
    agentId,
    request,
    replyTag,
    roomId
  });
}

/**
 * Effect to cancel an ongoing API call.
 */
export interface CancelApiCall {
  readonly type: 'CANCEL_API_CALL';
  readonly agentId: AgentId;
  readonly replyTag: string;
}

export function cancelApiCall(agentId: AgentId, replyTag: string): CancelApiCall {
  return Object.freeze({
    type: 'CANCEL_API_CALL',
    agentId,
    replyTag
  });
}

// ============================================================================
// ANTHROPIC EFFECT UNION
// ============================================================================

export type AnthropicEffect = CallAnthropic | CancelApiCall;

/**
 * Type guard for Anthropic effects.
 */
export function isAnthropicEffect(effect: { type: string }): effect is AnthropicEffect {
  return effect.type === 'CALL_ANTHROPIC' || effect.type === 'CANCEL_API_CALL';
}

// ============================================================================
// RESPONSE HELPERS (Pure functions)
// ============================================================================

/**
 * Extract text content from response.
 */
export function extractText(response: AnthropicResponse): string {
  return response.content
    .filter((block): block is ResponseTextBlock => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

/**
 * Extract tool use blocks from response.
 */
export function extractToolUses(response: AnthropicResponse): readonly ResponseToolUseBlock[] {
  return response.content.filter(
    (block): block is ResponseToolUseBlock => block.type === 'tool_use'
  );
}

/**
 * Check if response requires tool execution.
 */
export function requiresToolExecution(response: AnthropicResponse): boolean {
  return response.stop_reason === 'tool_use' &&
         response.content.some(block => block.type === 'tool_use');
}

/**
 * Check if response is final (no more tool calls needed).
 */
export function isFinalResponse(response: AnthropicResponse): boolean {
  return response.stop_reason === 'end_turn' ||
         response.stop_reason === 'max_tokens' ||
         response.stop_reason === 'stop_sequence';
}

/**
 * Build tool result content blocks from executed tools.
 */
export function buildToolResults(
  results: readonly { toolUseId: string; result: string; isError: boolean }[]
): readonly ToolResultContent[] {
  return Object.freeze(
    results.map(r => Object.freeze({
      type: 'tool_result' as const,
      tool_use_id: r.toolUseId,
      content: r.result,
      is_error: r.isError
    }))
  );
}

/**
 * Build a user message containing tool results.
 */
export function buildToolResultMessage(
  results: readonly ToolResultContent[]
): ApiMessage {
  return Object.freeze({
    role: 'user' as const,
    content: Object.freeze([...results])
  });
}

/**
 * Build an assistant message from response content.
 */
export function buildAssistantMessage(
  content: readonly ResponseContentBlock[]
): ApiMessage {
  return Object.freeze({
    role: 'assistant' as const,
    content: Object.freeze([...content]) as readonly ContentBlock[]
  });
}
