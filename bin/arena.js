#!/usr/bin/env node

/**
 * Arena CLI - Server lifecycle management
 *
 * Usage:
 *   arena start      - Start the server (foreground)
 *   arena start -d   - Start the server (background/daemon)
 *   arena stop       - Stop the server gracefully
 *   arena restart    - Restart the server
 *   arena status     - Show server status
 *   arena sim start  - Start simulation
 *   arena sim stop   - Stop simulation
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');
const PID_FILE = join(ROOT_DIR, 'data', 'arena.pid');
const LOG_FILE = join(ROOT_DIR, 'data', 'arena.log');
const API_BASE = process.env.ARENA_URL || 'http://localhost:8888';

const colors = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function apiCall(method, endpoint, body = null) {
  try {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${API_BASE}${endpoint}`, options);
    return await response.json();
  } catch (err) {
    return null;
  }
}

async function isServerRunning() {
  const status = await apiCall('GET', '/api/status');
  return status !== null;
}

function getPid() {
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, 'utf-8').trim();
    try {
      process.kill(parseInt(pid), 0);
      return parseInt(pid);
    } catch {
      unlinkSync(PID_FILE);
    }
  }
  return null;
}

async function startServer(daemon = false) {
  if (await isServerRunning()) {
    console.log(colors.yellow('Server is already running'));
    return;
  }

  console.log(colors.cyan('Starting Agent Arena server...'));

  if (daemon) {
    // Ensure data directory exists
    execSync(`mkdir -p ${join(ROOT_DIR, 'data')}`);

    const out = openSync(LOG_FILE, 'a');
    const err = openSync(LOG_FILE, 'a');

    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: ROOT_DIR,
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env }
    });

    writeFileSync(PID_FILE, String(child.pid));
    child.unref();

    console.log(colors.green(`Server started in background (PID: ${child.pid})`));
    console.log(`Logs: ${LOG_FILE}`);
  } else {
    // Foreground mode - just exec
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: { ...process.env }
    });

    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  }
}

async function stopServer() {
  console.log(colors.cyan('Stopping server...'));

  const result = await apiCall('POST', '/api/shutdown');
  if (result) {
    console.log(colors.green('Server stopped gracefully'));
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } else {
    const pid = getPid();
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(colors.green(`Server stopped (PID: ${pid})`));
        unlinkSync(PID_FILE);
      } catch {
        console.log(colors.yellow('Server not running'));
      }
    } else {
      console.log(colors.yellow('Server not running'));
    }
  }
}

async function showStatus() {
  const status = await apiCall('GET', '/api/status');

  if (!status) {
    console.log(colors.red('Server is not running'));
    return;
  }

  console.log(colors.bold('\n  Agent Arena Status\n'));
  console.log(`  ${colors.cyan('Server:')}     ${colors.green('Running')}`);
  console.log(`  ${colors.cyan('Simulation:')} ${status.running ? colors.green('Active') : colors.yellow('Stopped')}`);
  console.log(`  ${colors.cyan('Mode:')}       ${status.mode}`);
  console.log(`  ${colors.cyan('Round:')}      ${status.current_round}`);
  console.log(`  ${colors.cyan('Agents:')}     ${status.agents.count} (${status.agents.names.slice(0, 5).join(', ')}${status.agents.count > 5 ? '...' : ''})`);

  const channels = Object.keys(status.channels);
  console.log(`  ${colors.cyan('Rooms:')}      ${channels.length} (${channels.join(', ')})`);
  console.log();
}

async function simControl(action) {
  if (action === 'start') {
    console.log(colors.cyan('Starting simulation...'));
    try {
      const response = await fetch(`${API_BASE}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'mode=hybrid&maxTurns=50'
      });
      if (response.ok) {
        console.log(colors.green('Simulation started'));
      } else {
        console.log(colors.red('Failed to start simulation'));
      }
    } catch {
      console.log(colors.red('Failed to start simulation (server not running?)'));
    }
  } else if (action === 'stop') {
    console.log(colors.cyan('Stopping simulation...'));
    try {
      const response = await fetch(`${API_BASE}/stop`, { method: 'POST' });
      if (response.ok) {
        console.log(colors.green('Simulation stopped'));
      } else {
        console.log(colors.red('Failed to stop simulation'));
      }
    } catch {
      console.log(colors.red('Failed to stop simulation (server not running?)'));
    }
  }
}

function showHelp() {
  console.log(`
${colors.bold('Agent Arena CLI')}

${colors.cyan('Usage:')}
  arena <command> [options]

${colors.cyan('Commands:')}
  start        Start the server (foreground)
  start -d     Start the server (background daemon)
  stop         Stop the server gracefully
  restart      Restart the server
  status       Show server and simulation status

  sim start    Start the agent simulation
  sim stop     Stop the agent simulation

${colors.cyan('Environment:')}
  ARENA_URL    API base URL (default: http://localhost:8888)

${colors.cyan('Examples:')}
  arena start -d     # Start in background
  arena status       # Check status
  arena sim start    # Start agents chatting
  arena stop         # Graceful shutdown
`);
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'start':
    startServer(args.includes('-d') || args.includes('--daemon'));
    break;
  case 'stop':
    stopServer();
    break;
  case 'restart':
    await stopServer();
    setTimeout(() => startServer(args.includes('-d')), 2000);
    break;
  case 'status':
    showStatus();
    break;
  case 'sim':
    simControl(args[1]);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    showHelp();
}
