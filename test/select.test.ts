import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { select } from '../src/core/select.js';
import type {
  Candidate,
  Category,
  Classification,
  Difficulty,
  RoutingTable,
} from '../src/core/types.js';

// select() honours the routing override in config.json, so these tests must
// never see the config of the person running them.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-select-'));
  process.env.AIAX_ROUTER_HOME = home;
});
afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

function table(categories: Partial<Record<Category, Candidate[]>>): RoutingTable {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-04T00:00:00Z',
    sources: [{ name: 'test-fixture' }],
    categories: {
      coding: [],
      'agentic-coding': [],
      reasoning: [],
      writing: [],
      chat: [],
      'long-context': [],
      ...categories,
    },
    difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
  };
}

function classification(category: Category, difficulty: Difficulty): Classification {
  return { category, difficulty, rationale: 'fixture', via: 'heuristic' };
}

const full = () => 1;
const allOf = (...providers: string[]) => new Set(providers);

const OPUS: Candidate = {
  provider: 'claude',
  model: 'opus',
  score: 90,
  costWeight: 5,
  tokensPerTask: 2,
  maxEffort: 'xhigh',
};
const HAIKU: Candidate = {
  provider: 'claude',
  model: 'haiku',
  score: 76,
  costWeight: 1,
  tokensPerTask: 0.7,
  maxEffort: 'medium',
};
const FLASH: Candidate = {
  provider: 'kimi',
  model: 'flash',
  score: 74,
  costWeight: 0.5,
  tokensPerTask: 0.6,
};
const SOL: Candidate = {
  provider: 'codex',
  model: 'sol',
  score: 92,
  costWeight: 4,
  tokensPerTask: 1.9,
  maxEffort: 'xhigh',
};

describe('select', () => {
  it('sends a trivial chat task to a cheap model', () => {
    const decision = select({
      classification: classification('chat', 'trivial'),
      table: table({ chat: [OPUS, SOL, HAIKU, FLASH] }),
      available: allOf('claude', 'codex', 'kimi'),
      headroom: full,
    });

    expect(decision).not.toBeNull();
    const picked = [OPUS, SOL, HAIKU, FLASH].find(
      (c) => c.provider === decision?.provider && c.model === decision.model,
    );
    expect(picked?.costWeight).toBeLessThan(4);
    expect(decision?.effort).toBe('low');
  });

  it('sends a hard coding task to a top scorer on high effort', () => {
    const decision = select({
      classification: classification('coding', 'hard'),
      table: table({ coding: [OPUS, SOL, HAIKU, FLASH] }),
      available: allOf('claude', 'codex', 'kimi'),
      headroom: full,
    });

    expect(decision?.model).toBe('sol');
    expect(decision?.effort).toBe('high');
  });

  it('excludes candidates below the difficulty floor even when they are cheap', () => {
    // Flash has by far the best ROI but scores 74, under the hard floor of 80.
    const decision = select({
      classification: classification('coding', 'hard'),
      table: table({ coding: [OPUS, FLASH] }),
      available: allOf('claude', 'kimi'),
      headroom: full,
    });

    expect(decision?.provider).toBe('claude');
    expect(decision?.rankedAlternatives).toHaveLength(0);
  });

  it('skips a provider that is out of quota when another one can take the work', () => {
    const decision = select({
      classification: classification('chat', 'easy'),
      table: table({ chat: [FLASH, HAIKU] }),
      available: allOf('claude', 'kimi'),
      headroom: (p) => (p === 'kimi' ? 0.01 : 1),
    });

    expect(decision?.provider).toBe('claude');
    expect(decision?.rationale).not.toMatch(/quota/);
  });

  it('never selects a provider that is not available', () => {
    const decision = select({
      classification: classification('coding', 'hard'),
      table: table({ coding: [SOL, OPUS] }),
      available: allOf('claude'),
      headroom: full,
    });

    expect(decision?.provider).toBe('claude');
  });

  it('falls back to the best available model and says so when nothing clears the bar', () => {
    const decision = select({
      classification: classification('coding', 'hard'),
      table: table({ coding: [HAIKU, FLASH] }),
      available: allOf('claude', 'kimi'),
      headroom: full,
    });

    // Highest score wins the fallback, not the best ROI.
    expect(decision?.model).toBe('haiku');
    expect(decision?.rationale).toContain('below the ideal bar');
  });

  it('ignores the quota rule, and admits it, when every provider is out', () => {
    const decision = select({
      classification: classification('chat', 'easy'),
      table: table({ chat: [FLASH, HAIKU] }),
      available: allOf('claude', 'kimi'),
      headroom: () => 0,
    });

    expect(decision).not.toBeNull();
    expect(decision?.rationale).toMatch(/quota/);
  });

  it('clamps effort to what the model supports', () => {
    const decision = select({
      classification: classification('chat', 'hard'),
      table: table({ chat: [HAIKU] }),
      available: allOf('claude'),
      headroom: full,
    });

    // Hard would ask for high effort; haiku tops out at medium.
    expect(decision?.effort).toBe('medium');
  });

  it('returns null when no candidate is available at all', () => {
    const decision = select({
      classification: classification('coding', 'easy'),
      table: table({ coding: [OPUS] }),
      available: allOf('kimi'),
      headroom: full,
    });

    expect(decision).toBeNull();
  });
});
