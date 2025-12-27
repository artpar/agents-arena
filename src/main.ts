/**
 * Agent Arena - Main Entry Point
 *
 * Uses the Values & Boundaries architecture with the Actor system.
 *
 * Architecture:
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      HTTP / WebSocket                       │
 * └─────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                         API Layer                           │
 * │  Express routes → Messages → Actor Runtime                  │
 * └─────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      Runtime Layer                          │
 * │  Actor System + Effect Executors (Database, API, WS)       │
 * └─────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    Interpreters Layer                       │
 * │  Pure functions: (State, Message) → [NewState, Effect[]]   │
 * └─────────────────────────────────────────────────────────────┘
 *                              │
 *                              ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      Values Layer                           │
 * │  Immutable data types (ChatMessage, AgentState, etc.)      │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 */

import dotenv from 'dotenv';
dotenv.config();

import { createServer } from './server.js';

async function main(): Promise<void> {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let port = 8888;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[i + 1]) || 8888;
    }
  }

  // Validate required environment variables
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  // Create and start server
  const { server, runtime, shutdown } = await createServer({
    port,
    anthropicApiKey: apiKey,
    databasePath: './data/arena.db',
    workspacePath: './workspaces',
    sharedWorkspacePath: './shared'
  });

  // Print startup banner
  console.log('');
  console.log('╭──────────────────────────────────────────────────────────────────────────────╮');
  console.log('│                          Agent Arena v2.0                                    │');
  console.log('│                    Values & Boundaries Architecture                         │');
  console.log('│                                                                              │');
  console.log(`│  URL: http://0.0.0.0:${port}                                                     │`);
  console.log('│  Architecture: Pure Interpreters + Actor System                             │');
  console.log('│                                                                              │');
  console.log('│  Press Ctrl+C to stop.                                                       │');
  console.log('╰──────────────────────────────────────────────────────────────────────────────╯');
  console.log('');

  // Graceful shutdown
  const handleShutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    await shutdown();
    console.log('Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
