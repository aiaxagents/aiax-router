import { configPath, readJson, writeJson } from './store.js';
import type { Effort } from './types.js';

/**
 * The routing switch in the app: "Auto" lets the router pick per task, "Manual"
 * pins the model and effort the person chose. Stored in config.json so it
 * survives a restart and the CLI honours it too.
 */
export interface RoutingChoice {
  provider: string;
  model: string;
  effort: Effort;
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];

interface Config {
  routing?: { mode?: string; provider?: string; model?: string; effort?: string };
  [k: string]: unknown;
}

/** The pinned choice, or null when the router decides on its own. */
export function routingOverride(): RoutingChoice | null {
  const routing = readJson<Config>(configPath('config.json'), {}).routing;
  if (routing?.mode !== 'manual') return null;
  const { provider, model, effort } = routing;
  if (!provider || !model || !EFFORTS.includes(effort as Effort)) return null;
  return { provider, model, effort: effort as Effort };
}

export function setRouting(next: { mode: 'auto' } | ({ mode: 'manual' } & RoutingChoice)): void {
  const path = configPath('config.json');
  const config = readJson<Config>(path, {});
  config.routing = next;
  writeJson(path, config);
}
