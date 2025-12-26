/**
 * Agent registry for managing agents in the arena.
 */

import type { Agent } from '../agents/agent.js';

export class AgentRegistry {
  private _agents: Map<string, Agent> = new Map();
  private _byName: Map<string, string> = new Map(); // name -> id mapping

  /**
   * Register an agent.
   */
  register(agent: Agent): void {
    if (this._agents.has(agent.id)) {
      throw new Error(`Agent ${agent.id} already registered`);
    }

    this._agents.set(agent.id, agent);
    this._byName.set(agent.name.toLowerCase(), agent.id);
    console.log(`Registered agent: ${agent.name} (${agent.id})`);
  }

  /**
   * Unregister an agent by ID.
   */
  unregister(agentId: string): Agent | undefined {
    const agent = this._agents.get(agentId);
    if (agent) {
      this._agents.delete(agentId);
      this._byName.delete(agent.name.toLowerCase());
      console.log(`Unregistered agent: ${agent.name}`);
    }
    return agent;
  }

  /**
   * Get an agent by ID.
   */
  get(agentId: string): Agent | undefined {
    return this._agents.get(agentId);
  }

  /**
   * Get an agent by name (case-insensitive).
   */
  getByName(name: string): Agent | undefined {
    const agentId = this._byName.get(name.toLowerCase());
    return agentId ? this._agents.get(agentId) : undefined;
  }

  /**
   * Get all registered agents.
   */
  all(): Agent[] {
    return Array.from(this._agents.values());
  }

  /**
   * Get all agent names.
   */
  names(): string[] {
    return this.all().map(a => a.name);
  }

  /**
   * Get number of registered agents.
   */
  count(): number {
    return this._agents.size;
  }

  /**
   * Check if agent is registered.
   */
  has(agentId: string): boolean {
    return this._agents.has(agentId);
  }

  /**
   * Iterate over agents.
   */
  [Symbol.iterator](): Iterator<Agent> {
    return this._agents.values();
  }
}
