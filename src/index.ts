/**
 * Agent Arena - Entry point
 *
 * Usage:
 *   npm run dev          # Development with hot reload
 *   npm run serve        # Run directly with tsx
 *   npm run build        # Build TypeScript
 *   npm start            # Run built JavaScript
 */

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './api/app.js';
import { loadAgentsFromDirectory } from './agents/loader.js';
import { ArenaWorld } from './arena/world.js';
import { initDatabase, closeDatabase } from './core/database.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let port = 8888;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[i + 1]) || 8888;
    }
  }

  // Initialize database
  initDatabase();

  // Create world
  const world = new ArenaWorld('Agent Arena');

  // Load agents from configs
  const configsDir = join(__dirname, '..', 'configs', 'agents');
  if (existsSync(configsDir)) {
    const agents = loadAgentsFromDirectory(configsDir);
    console.log(`Loaded ${agents.length} agent configs`);

    for (const agent of agents) {
      try {
        // Register agent without connecting (connect happens on first use)
        world.registry.register(agent);
        const channel = world.getChannel(world.defaultChannel);
        if (channel) {
          channel.addMember(agent.id);
        }
      } catch (err) {
        console.error(`Failed to add agent ${agent.name}:`, err);
      }
    }
  } else {
    console.log('No configs/agents directory found, starting with no agents');
  }

  // Create app
  const { server, world: w } = createApp(world);

  // Print startup banner
  console.log('');
  console.log('╭──────────────────────────── Starting Server ────────────────────────────────╮');
  console.log('│ Agent Arena Web Interface                                                    │');
  console.log('│                                                                              │');
  console.log(`│ URL: http://0.0.0.0:${port}                                                     │`);
  console.log(`│ Agents: ${world.registry.names().join(', ').slice(0, 60).padEnd(60)}│`);
  console.log('│ Mode: hybrid                                                                 │');
  console.log('│                                                                              │');
  console.log('│ Press Ctrl+C to stop.                                                        │');
  console.log('╰──────────────────────────────────────────────────────────────────────────────╯');
  console.log('');

  // Start server
  server.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    world.stop();
    closeDatabase();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
