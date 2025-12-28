/**
 * Broadcast Boundary
 *
 * Executes WebSocket broadcast effects. This is where actual network I/O happens.
 *
 * BOUNDARY PRINCIPLE:
 * - Pure interpreters produce BroadcastEffect values
 * - This boundary sends them over WebSocket connections
 * - The actual network I/O is isolated here
 */

import { WebSocket, WebSocketServer } from 'ws';
import {
  BroadcastEffect,
  isBroadcastEffect,
  BroadcastToRoom,
  BroadcastToAll,
  SendToClient,
  UIEvent
} from '../effects/broadcast.js';
import { RoomId } from '../values/ids.js';
import {
  EffectResult,
  EffectExecutor,
  successResult,
  failureResult,
  Logger
} from './types.js';
import { Effect } from '../effects/index.js';

// ============================================================================
// CLIENT CONNECTION
// ============================================================================

/**
 * A connected WebSocket client.
 */
export interface ClientConnection {
  readonly id: string;
  readonly ws: WebSocket;
  readonly roomId: RoomId | null;
  readonly connectedAt: number;
}

/**
 * Create a client connection.
 */
export function createClientConnection(
  id: string,
  ws: WebSocket,
  roomId: RoomId | null = null
): ClientConnection {
  return Object.freeze({
    id,
    ws,
    roomId,
    connectedAt: Date.now()
  });
}

// ============================================================================
// BROADCAST STATE
// ============================================================================

/**
 * State for the broadcast system.
 */
export interface BroadcastState {
  readonly clients: Map<string, ClientConnection>;
  readonly roomClients: Map<string, Set<string>>; // roomId -> clientIds
}

/**
 * Create broadcast state.
 */
export function createBroadcastState(): BroadcastState {
  return {
    clients: new Map(),
    roomClients: new Map()
  };
}

/**
 * Add a client to broadcast state.
 */
export function addClient(
  state: BroadcastState,
  client: ClientConnection
): void {
  state.clients.set(client.id, client);

  if (client.roomId) {
    let roomSet = state.roomClients.get(client.roomId);
    if (!roomSet) {
      roomSet = new Set();
      state.roomClients.set(client.roomId, roomSet);
    }
    roomSet.add(client.id);
  }
}

/**
 * Remove a client from broadcast state.
 */
export function removeClient(
  state: BroadcastState,
  clientId: string
): void {
  const client = state.clients.get(clientId);
  if (client) {
    state.clients.delete(clientId);

    if (client.roomId) {
      const roomSet = state.roomClients.get(client.roomId);
      if (roomSet) {
        roomSet.delete(clientId);
        if (roomSet.size === 0) {
          state.roomClients.delete(client.roomId);
        }
      }
    }
  }
}

/**
 * Move a client to a different room.
 */
export function moveClientToRoom(
  state: BroadcastState,
  clientId: string,
  roomId: RoomId
): void {
  const client = state.clients.get(clientId);
  if (!client) return;

  // Remove from old room
  if (client.roomId) {
    const oldRoomSet = state.roomClients.get(client.roomId);
    if (oldRoomSet) {
      oldRoomSet.delete(clientId);
      if (oldRoomSet.size === 0) {
        state.roomClients.delete(client.roomId);
      }
    }
  }

  // Add to new room
  let roomSet = state.roomClients.get(roomId);
  if (!roomSet) {
    roomSet = new Set();
    state.roomClients.set(roomId, roomSet);
  }
  roomSet.add(clientId);

  // Update client
  const updatedClient = createClientConnection(clientId, client.ws, roomId);
  state.clients.set(clientId, updatedClient);
}

// ============================================================================
// BROADCAST EXECUTOR
// ============================================================================

/**
 * Create a broadcast effect executor.
 */
export function createBroadcastExecutor(
  broadcastState: BroadcastState,
  logger: Logger
): EffectExecutor {
  return {
    canHandle(effect: Effect): boolean {
      return isBroadcastEffect(effect);
    },

    async execute(effect: Effect): Promise<EffectResult> {
      if (!isBroadcastEffect(effect)) {
        return failureResult(effect, 'Not a broadcast effect', 0);
      }

      const start = Date.now();

      try {
        const result = executeBroadcastEffect(
          broadcastState,
          effect as BroadcastEffect,
          logger
        );
        return successResult(effect, result, Date.now() - start);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Broadcast effect failed', { effect: effect.type, error });
        return failureResult(effect, error, Date.now() - start);
      }
    }
  };
}

/**
 * Execute a broadcast effect.
 */
function executeBroadcastEffect(
  state: BroadcastState,
  effect: BroadcastEffect,
  logger: Logger
): BroadcastResult {
  switch (effect.type) {
    case 'BROADCAST_TO_ROOM':
      return broadcastToRoom(state, effect, logger);

    case 'BROADCAST_TO_ALL':
      return broadcastToAll(state, effect, logger);

    case 'SEND_TO_CLIENT':
      return sendToClient(state, effect, logger);

    default:
      const _exhaustive: never = effect;
      throw new Error('Unknown broadcast effect type');
  }
}

// ============================================================================
// EFFECT IMPLEMENTATIONS
// ============================================================================

/**
 * Broadcast to all clients in a room.
 */
function broadcastToRoom(
  state: BroadcastState,
  effect: BroadcastToRoom,
  logger: Logger
): BroadcastResult {
  const { roomId, event } = effect;
  const clientIds = state.roomClients.get(roomId);

  logger.info('Broadcasting to room', {
    roomId,
    eventType: event.type,
    clientCount: clientIds?.size ?? 0,
    allRooms: Array.from(state.roomClients.keys())
  });

  if (!clientIds || clientIds.size === 0) {
    logger.warn('No clients in room', { roomId, allRooms: Array.from(state.roomClients.keys()) });
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const clientId of clientIds) {
    const client = state.clients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      try {
        sendEvent(client.ws, event);
        sent++;
      } catch (err) {
        failed++;
        logger.error('Failed to send to client', { clientId, error: String(err) });
      }
    }
  }

  logger.debug('Broadcast to room', { roomId, sent, failed, eventType: event.type });
  return { sent, failed };
}

/**
 * Broadcast to all connected clients.
 */
function broadcastToAll(
  state: BroadcastState,
  effect: BroadcastToAll,
  logger: Logger
): BroadcastResult {
  const { event } = effect;

  let sent = 0;
  let failed = 0;

  for (const client of state.clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        sendEvent(client.ws, event);
        sent++;
      } catch (err) {
        failed++;
        logger.error('Failed to send to client', { clientId: client.id, error: String(err) });
      }
    }
  }

  logger.debug('Broadcast to all', { sent, failed, eventType: event.type });
  return { sent, failed };
}

/**
 * Send to a specific client.
 */
function sendToClient(
  state: BroadcastState,
  effect: SendToClient,
  logger: Logger
): BroadcastResult {
  const { clientId, event } = effect;
  const client = state.clients.get(clientId);

  if (!client) {
    logger.warn('Client not found', { clientId });
    return { sent: 0, failed: 1 };
  }

  if (client.ws.readyState !== WebSocket.OPEN) {
    logger.warn('Client not connected', { clientId });
    return { sent: 0, failed: 1 };
  }

  try {
    sendEvent(client.ws, event);
    logger.debug('Sent to client', { clientId, eventType: event.type });
    return { sent: 1, failed: 0 };
  } catch (err) {
    logger.error('Failed to send to client', { clientId, error: String(err) });
    return { sent: 0, failed: 1 };
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Send an event over WebSocket.
 */
function sendEvent(ws: WebSocket, event: UIEvent): void {
  ws.send(JSON.stringify(event));
}

/**
 * Result of a broadcast operation.
 */
export interface BroadcastResult {
  readonly sent: number;
  readonly failed: number;
}

/**
 * Get count of connected clients.
 */
export function getClientCount(state: BroadcastState): number {
  return state.clients.size;
}

/**
 * Get count of clients in a room.
 */
export function getRoomClientCount(state: BroadcastState, roomId: RoomId): number {
  return state.roomClients.get(roomId)?.size ?? 0;
}

/**
 * Get all room IDs with clients.
 */
export function getActiveRooms(state: BroadcastState): readonly RoomId[] {
  return Object.freeze(Array.from(state.roomClients.keys()) as RoomId[]);
}

// ============================================================================
// WEBSOCKET SERVER INTEGRATION
// ============================================================================

/**
 * Options for WebSocket server.
 */
export interface WebSocketServerOptions {
  readonly port?: number;
  readonly path?: string;
}

/**
 * Set up WebSocket connection handling.
 */
export function setupWebSocketHandlers(
  wss: WebSocketServer,
  broadcastState: BroadcastState,
  logger: Logger,
  onConnect?: (clientId: string) => void,
  onDisconnect?: (clientId: string) => void,
  onMessage?: (clientId: string, message: unknown) => void
): void {
  wss.on('connection', (ws: WebSocket) => {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    logger.info('Client connected', { clientId });

    // Create and register client
    const client = createClientConnection(clientId, ws);
    addClient(broadcastState, client);

    // Notify connection
    onConnect?.(clientId);

    // Handle messages
    ws.on('message', (data: Buffer | string) => {
      try {
        const message = JSON.parse(data.toString());
        onMessage?.(clientId, message);
      } catch (err) {
        logger.error('Invalid message from client', { clientId, error: String(err) });
      }
    });

    // Handle close
    ws.on('close', () => {
      logger.info('Client disconnected', { clientId });
      removeClient(broadcastState, clientId);
      onDisconnect?.(clientId);
    });

    // Handle errors
    ws.on('error', (err) => {
      logger.error('WebSocket error', { clientId, error: err.message });
    });
  });
}
