import type { Adapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { grokAdapter } from './grok.js';
import { kimiAdapter } from './kimi.js';

export const adapters: Adapter[] = [claudeAdapter, codexAdapter, grokAdapter, kimiAdapter];

export function adapterById(id: string): Adapter | undefined {
  return adapters.find((a) => a.id === id);
}
