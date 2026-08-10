import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from './paths.js';
import { configPath } from './store.js';
import type { Candidate, Category, Difficulty, RoutingTable } from './types.js';

const CATEGORIES: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];
const DIFFICULTIES: Difficulty[] = ['trivial', 'easy', 'medium', 'hard'];

/** Bundled table sits next to the files the router ships with. */
function bundledPath(): string {
  return join(appRoot(), 'routing-table.json');
}

function isCandidate(value: unknown): boolean {
  const c = value as Candidate | null;
  return (
    !!c &&
    typeof c.provider === 'string' &&
    c.provider !== '' &&
    typeof c.model === 'string' &&
    c.model !== '' &&
    Number.isFinite(c.score) &&
    Number.isFinite(c.costWeight) &&
    Number.isFinite(c.tokensPerTask)
  );
}

/** The one gate every table passes, whether it is bundled, hand edited or downloaded. */
export function isRoutingTable(value: unknown): value is RoutingTable {
  const t = value as RoutingTable | null;
  if (!t || t.schemaVersion !== 1 || !t.categories || !t.difficultyFloor) return false;
  if (!CATEGORIES.every((c) => Array.isArray(t.categories[c]) && t.categories[c].length > 0)) {
    return false;
  }
  if (!CATEGORIES.every((c) => t.categories[c].every(isCandidate))) return false;
  return DIFFICULTIES.every((d) => typeof t.difficultyFloor[d] === 'number');
}

/** Every candidate in the table, across all categories. */
export function countCandidates(table: RoutingTable): number {
  return CATEGORIES.reduce((sum, c) => sum + (table.categories[c]?.length ?? 0), 0);
}

/**
 * The user's own `~/.aiax-router/routing-table.json` wins over the bundled seed,
 * so a weekly refresh (or a hand edit) never needs a reinstall.
 */
export function loadRoutingTable(): RoutingTable {
  const override = configPath('routing-table.json');
  let raw: string | undefined;
  try {
    raw = readFileSync(override, 'utf8');
  } catch {
    // no override, which is the normal case
  }
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRoutingTable(parsed)) return parsed;
    } catch {
      // fall through to the same warning
    }
    console.error(`Ignoring ${override}: not a valid routing table. Using the bundled one.`);
  }

  const path = bundledPath();
  const bundled: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRoutingTable(bundled)) throw new Error(`Bundled routing table is invalid: ${path}`);
  return bundled;
}
