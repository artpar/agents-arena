/**
 * Event system using Node's native EventEmitter.
 * Much simpler than Python's asyncio.Queue approach - no stale state issues.
 */

import { EventEmitter } from 'events';

export interface Event {
  type: string;
  data: unknown;
  timestamp: Date;
}

export type EventHandler = (event: Event) => void | Promise<void>;

/**
 * EventBus using Node's native EventEmitter.
 * Synchronous emit means no queue, no race conditions.
 */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    // Increase max listeners since we may have many handlers
    this.setMaxListeners(100);
  }

  /**
   * Subscribe to an event type.
   */
  subscribe(eventType: string, handler: EventHandler): void {
    this.on(eventType, handler);
  }

  /**
   * Unsubscribe from an event type.
   */
  unsubscribe(eventType: string, handler: EventHandler): void {
    this.off(eventType, handler);
  }

  /**
   * Emit an event. Synchronous - handlers run immediately.
   */
  emitEvent(type: string, data?: unknown): void {
    const event: Event = {
      type,
      data,
      timestamp: new Date()
    };

    // Emit to specific handlers
    this.emit(type, event);

    // Also emit to wildcard handlers
    this.emit('*', event);
  }
}
