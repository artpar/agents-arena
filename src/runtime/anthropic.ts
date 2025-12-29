/**
 * Anthropic API Boundary
 *
 * Executes Anthropic API effects. This is where actual HTTP calls happen.
 *
 * BOUNDARY PRINCIPLE:
 * - Pure interpreters produce CallAnthropic effect values
 * - This boundary executes them against the real API
 * - Responses are returned as values for the runtime to route
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicEffect,
  isAnthropicEffect,
  CallAnthropic,
  CancelApiCall,
  AnthropicRequest,
  AnthropicResponse,
  ResponseContentBlock
} from '../effects/anthropic.js';
import { AgentId } from '../values/ids.js';
import {
  EffectResult,
  EffectExecutor,
  successResult,
  failureResult,
  Logger
} from './types.js';
import { Effect } from '../effects/index.js';

// ============================================================================
// API CLIENT
// ============================================================================

/**
 * Anthropic API client wrapper.
 */
export interface AnthropicClient {
  readonly client: Anthropic;
  readonly pendingCalls: Map<string, AbortController>;
}

/**
 * Create an Anthropic client.
 */
export function createAnthropicClient(apiKey: string): AnthropicClient {
  const client = new Anthropic({ apiKey });
  return {
    client,
    pendingCalls: new Map()
  };
}

// ============================================================================
// ANTHROPIC EXECUTOR
// ============================================================================

/**
 * Create an Anthropic effect executor.
 */
export function createAnthropicExecutor(
  anthropicClient: AnthropicClient,
  logger: Logger,
  onApiResponse?: (agentId: string, roomId: string, response: AnthropicResponse, replyTag: string) => void
): EffectExecutor {
  return {
    canHandle(effect: Effect): boolean {
      return isAnthropicEffect(effect);
    },

    async execute(effect: Effect): Promise<EffectResult> {
      if (!isAnthropicEffect(effect)) {
        return failureResult(effect, 'Not an Anthropic effect', 0);
      }

      const start = Date.now();

      try {
        const result = await executeAnthropicEffect(
          anthropicClient,
          effect as AnthropicEffect,
          logger
        );

        // If this was an API call and we have a callback, send the response back
        if (effect.type === 'CALL_ANTHROPIC' && onApiResponse && result && typeof result === 'object' && 'response' in result) {
          const apiResult = result as ApiCallResult;
          if (apiResult.type === 'success' && apiResult.response) {
            const callEffect = effect as CallAnthropic;
            onApiResponse(
              callEffect.agentId,
              callEffect.roomId || 'general',
              apiResult.response,
              callEffect.replyTag
            );
          }
        }

        return successResult(effect, result, Date.now() - start);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Anthropic effect failed', { effect: effect.type, error });
        return failureResult(effect, error, Date.now() - start);
      }
    }
  };
}

/**
 * Execute an Anthropic effect.
 */
async function executeAnthropicEffect(
  client: AnthropicClient,
  effect: AnthropicEffect,
  logger: Logger
): Promise<unknown> {
  switch (effect.type) {
    case 'CALL_ANTHROPIC':
      return callAnthropicApi(client, effect, logger);

    case 'CANCEL_API_CALL':
      return cancelApiCall(client, effect, logger);

    default:
      const _exhaustive: never = effect;
      throw new Error('Unknown Anthropic effect type');
  }
}

// ============================================================================
// EFFECT IMPLEMENTATIONS
// ============================================================================

/**
 * Call the Anthropic API.
 */
async function callAnthropicApi(
  client: AnthropicClient,
  effect: CallAnthropic,
  logger: Logger
): Promise<ApiCallResult> {
  const { agentId, request, replyTag } = effect;

  // Log full request details for debugging
  console.log('\n=== LLM REQUEST ===');
  console.log('Agent:', agentId);
  console.log('Model:', request.model);
  console.log('System Prompt:', request.system ? request.system.substring(0, 500) + (request.system.length > 500 ? '...' : '') : '[NONE]');
  console.log('Messages:', JSON.stringify(request.messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content.substring(0, 200) : '[array]'
  })), null, 2));
  console.log('===================\n');

  logger.info('Calling Anthropic API', {
    agentId,
    replyTag,
    model: request.model,
    messageCount: request.messages.length,
    toolCount: request.tools?.length || 0,
    toolNames: request.tools?.map(t => t.name) || [],
    messages: request.messages.map(m => ({ role: m.role, contentLen: typeof m.content === 'string' ? m.content.length : 'array' }))
  });

  // Create abort controller for cancellation
  const abortController = new AbortController();
  client.pendingCalls.set(replyTag, abortController);

  try {
    const response = await client.client.messages.create(
      {
        model: request.model,
        max_tokens: request.max_tokens,
        system: request.system,
        messages: request.messages.map(msg => ({
          role: msg.role,
          content: msg.content as string | Anthropic.ContentBlock[]
        })),
        tools: request.tools?.map(tool => {
          // Built-in schema-less tools (bash, text_editor, web_search, etc.)
          if (tool.type) {
            return {
              type: tool.type,
              name: tool.name
            } as Anthropic.Tool;
          }
          // Custom tools with full schema
          return {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema as Anthropic.Tool.InputSchema
          } as Anthropic.Tool;
        }),
        temperature: request.temperature
      },
      { signal: abortController.signal }
    );

    // Convert to our response type
    const anthropicResponse = toAnthropicResponse(response);

    // Log full response for debugging
    console.log('\n=== LLM RESPONSE ===');
    console.log('Agent:', agentId);
    console.log('Stop Reason:', anthropicResponse.stop_reason);
    console.log('Content:', JSON.stringify(anthropicResponse.content.map(c => {
      if (c.type === 'text') return { type: 'text', text: c.text.substring(0, 300) + (c.text.length > 300 ? '...' : '') };
      if (c.type === 'tool_use') return { type: 'tool_use', name: c.name };
      return c;
    }), null, 2));
    console.log('====================\n');

    logger.debug('Anthropic API response', {
      agentId,
      replyTag,
      stopReason: anthropicResponse.stop_reason,
      contentBlocks: anthropicResponse.content.length,
      inputTokens: anthropicResponse.usage.input_tokens,
      outputTokens: anthropicResponse.usage.output_tokens
    });

    return {
      type: 'success',
      agentId,
      replyTag,
      response: anthropicResponse
    };
  } finally {
    client.pendingCalls.delete(replyTag);
  }
}

/**
 * Cancel a pending API call.
 */
function cancelApiCall(
  client: AnthropicClient,
  effect: CancelApiCall,
  logger: Logger
): CancelResult {
  const { agentId, replyTag } = effect;

  const controller = client.pendingCalls.get(replyTag);
  if (controller) {
    controller.abort();
    client.pendingCalls.delete(replyTag);
    logger.info('Cancelled API call', { agentId, replyTag });
    return { type: 'cancelled', agentId, replyTag };
  }

  logger.warn('No pending call to cancel', { agentId, replyTag });
  return { type: 'not_found', agentId, replyTag };
}

// ============================================================================
// RESULT TYPES
// ============================================================================

/**
 * Result of an API call.
 */
export interface ApiCallResult {
  readonly type: 'success';
  readonly agentId: AgentId;
  readonly replyTag: string;
  readonly response: AnthropicResponse;
}

/**
 * Result of a cancel operation.
 */
export interface CancelResult {
  readonly type: 'cancelled' | 'not_found';
  readonly agentId: AgentId;
  readonly replyTag: string;
}

// ============================================================================
// RESPONSE CONVERSION
// ============================================================================

/**
 * Convert SDK response to our response type.
 */
function toAnthropicResponse(response: Anthropic.Message): AnthropicResponse {
  return Object.freeze({
    id: response.id,
    model: response.model,
    content: Object.freeze(response.content.map(toResponseBlock)),
    stop_reason: response.stop_reason as AnthropicResponse['stop_reason'],
    usage: Object.freeze({
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens
    })
  });
}

/**
 * Convert SDK content block to our type.
 */
function toResponseBlock(block: Anthropic.ContentBlock): ResponseContentBlock {
  if (block.type === 'text') {
    return Object.freeze({
      type: 'text',
      text: block.text
    });
  } else if (block.type === 'tool_use') {
    return Object.freeze({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input
    });
  } else if ((block as { type: string }).type === 'server_tool_use') {
    // Server-side tool use (e.g., web_search)
    const serverBlock = block as { type: 'server_tool_use'; id: string; name: string; input: unknown };
    return Object.freeze({
      type: 'server_tool_use',
      id: serverBlock.id,
      name: serverBlock.name,
      input: serverBlock.input
    });
  } else if ((block as { type: string }).type === 'web_search_tool_result') {
    // Web search tool result
    const resultBlock = block as { type: 'web_search_tool_result'; tool_use_id: string; content: unknown };
    return Object.freeze({
      type: 'web_search_tool_result',
      tool_use_id: resultBlock.tool_use_id,
      content: resultBlock.content
    });
  }
  // For any other block types, treat as text with the raw content
  console.warn(`Unhandled content block type: ${(block as { type: string }).type}`);
  return Object.freeze({
    type: 'text',
    text: `[Unhandled block type: ${(block as { type: string }).type}]`
  });
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Check if an API call is pending.
 */
export function isPendingCall(
  client: AnthropicClient,
  replyTag: string
): boolean {
  return client.pendingCalls.has(replyTag);
}

/**
 * Get count of pending calls.
 */
export function getPendingCallCount(client: AnthropicClient): number {
  return client.pendingCalls.size;
}

/**
 * Cancel all pending calls.
 */
export function cancelAllCalls(client: AnthropicClient, logger: Logger): number {
  const count = client.pendingCalls.size;
  for (const [replyTag, controller] of client.pendingCalls) {
    controller.abort();
    logger.info('Cancelled pending call', { replyTag });
  }
  client.pendingCalls.clear();
  return count;
}
