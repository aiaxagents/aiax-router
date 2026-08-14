import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candidate, Category, RoutingTable } from '../src/core/types.js';

/**
 * The table that ships with the app, not a fixture. A vendor shipping a new
 * default model is the routine change here, and the router must not keep
 * spawning last generation's id after the CLI has moved on.
 */
const ROOT = join(import.meta.dirname, '..');
const table = JSON.parse(readFileSync(join(ROOT, 'routing-table.json'), 'utf8')) as RoutingTable;
const aliases = JSON.parse(readFileSync(join(ROOT, 'model-aliases.json'), 'utf8')) as {
  aliases: Record<string, { provider: string; model: string }>;
};

const CATEGORIES = Object.keys(table.categories) as Category[];
const grokIn = (category: Category): Candidate[] =>
  table.categories[category].filter((c) => c.provider === 'grok');

describe('shipped routing table', () => {
  it('offers grok-4.6 in every category, ahead of 4.5', () => {
    for (const category of CATEGORIES) {
      const models = grokIn(category).map((c) => c.model);
      expect(models, category).toContain('grok-4.6');
      // Equal scores tie, and the sort is stable, so position is what decides.
      expect(models.indexOf('grok-4.6'), category).toBeLessThan(models.indexOf('grok-4.5'));
    }
  });

  it('never scores a successor below the model it replaces', () => {
    for (const category of CATEGORIES) {
      const grok = grokIn(category);
      const next = grok.find((c) => c.model === 'grok-4.6');
      const prev = grok.find((c) => c.model === 'grok-4.5');
      if (!next || !prev) continue;
      expect(next.score, category).toBeGreaterThanOrEqual(prev.score);
    }
  });

  it('leaves grok-4.6 reachable from the leaderboard names', () => {
    const aliased = new Set(Object.values(aliases.aliases).map((a) => `${a.provider}/${a.model}`));
    // Its score is seeded from 4.5, so the weekly merge has to be able to find
    // it and replace that seed with a measured one.
    expect(aliased).toContain('grok/grok-4.6');
  });
});
