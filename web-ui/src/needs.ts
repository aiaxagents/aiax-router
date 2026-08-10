import type { AgentTemplate, PluginTemplate, Requirement, Status } from './api';

type Option = Requirement['any'][number];

/** One thing an agent needs, answered against what this computer actually has. */
export function optionMet(
  option: Option,
  status: Status | null,
  plugins: PluginTemplate[],
): boolean {
  if (!status) return false;
  if (option.kind === 'any-subscription') return status.providers.some((p) => p.ready);
  if (option.kind === 'subscription') {
    return status.providers.some((p) => p.id === option.id && p.ready);
  }
  if (option.kind === 'plugin') return plugins.some((p) => p.id === option.id && p.connected);
  return false;
}

function groupMet(
  group: Requirement,
  status: Status | null,
  plugins: PluginTemplate[],
): boolean {
  return group.any.some((option) => optionMet(option, status, plugins));
}

export function agentReady(
  agent: AgentTemplate,
  status: Status | null,
  plugins: PluginTemplate[],
): boolean {
  return (agent.requires ?? []).every((group) => groupMet(group, status, plugins));
}

/** Plain words for the first thing an agent is still missing. */
export function missingLabel(
  agent: AgentTemplate,
  status: Status | null,
  plugins: PluginTemplate[],
): string | null {
  for (const group of agent.requires ?? []) {
    if (groupMet(group, status, plugins)) continue;
    const names = group.any.map((o) => o.name);
    if (group.any.every((o) => o.kind === 'plugin')) {
      return `Needs ${names.join(' or ')}`;
    }
    return names.length > 1 ? `Needs ${names.join(' or ')}` : `Needs ${names[0]}`;
  }
  return null;
}
