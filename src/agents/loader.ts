/**
 * Load agent configurations from YAML files.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, parse } from 'path';
import yaml from 'js-yaml';
import { AgentConfig } from '../core/types.js';
import { Agent } from './agent.js';

/**
 * Load an agent configuration from a YAML file.
 */
export function loadAgentConfig(filePath: string): AgentConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Agent config not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const config = yaml.load(content) as AgentConfig;

  // Set ID from filename if not specified
  if (!config.id) {
    config.id = parse(filePath).name;
  }

  return config;
}

/**
 * Load all agent configurations from a directory.
 */
export function loadAgentsFromDirectory(directory: string): Agent[] {
  const agents: Agent[] = [];

  if (!existsSync(directory)) {
    console.warn(`Agent directory not found: ${directory}`);
    return agents;
  }

  const files = readdirSync(directory);

  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) {
      continue;
    }

    const filePath = join(directory, file);
    try {
      const config = loadAgentConfig(filePath);
      const agent = Agent.fromConfig(config);
      agents.push(agent);
      console.log(`Loaded agent: ${agent.name} from ${filePath}`);
    } catch (error) {
      console.error(`Failed to load agent from ${filePath}:`, error);
    }
  }

  return agents;
}

/**
 * Create an agent from a dictionary (e.g., from API request).
 */
export function createAgentFromDict(data: AgentConfig): Agent {
  return Agent.fromConfig(data);
}
