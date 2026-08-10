import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routingOverride, setRouting } from '../src/core/override.js';
import { select } from '../src/core/select.js';
import type { Candidate, Classification, RoutingTable } from '../src/core/types.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-override-'));
  process.env.AIAX_ROUTER_HOME = home;
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

const OPUS: Candidate = { provider: 'claude', model: 'opus', score: 90, costWeight: 5, tokensPerTask: 2 };
const SOL: Candidate = { provider: 'codex', model: 'gpt-5.6-sol', score: 88, costWeight: 3, tokensPerTask: 1.5 };

const TABLE: RoutingTable = {
  schemaVersion: 1,
  generatedAt: '2026-08-10T00:00:00Z',
  sources: [{ name: 'test-fixture' }],
  categories: {
    coding: [OPUS, SOL],
    'agentic-coding': [],
    reasoning: [],
    writing: [],
    chat: [],
    'long-context': [],
  },
  difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
};

const CLS: Classification = { category: 'coding', difficulty: 'hard', rationale: 'fixture', via: 'heuristic' };

describe('routing override', () => {
  it('is off by default and off again after auto', () => {
    expect(routingOverride()).toBeNull();
    setRouting({ mode: 'manual', provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' });
    expect(routingOverride()).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' });
    setRouting({ mode: 'auto' });
    expect(routingOverride()).toBeNull();
  });

  it('pins the decision when the provider can take work', () => {
    setRouting({ mode: 'manual', provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
    const decision = select({
      classification: CLS,
      table: TABLE,
      available: new Set(['claude', 'codex']),
      headroom: () => 1,
    });
    expect(decision).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
  });

  it('falls back to auto when the pinned provider is not available', () => {
    setRouting({ mode: 'manual', provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' });
    const decision = select({
      classification: CLS,
      table: TABLE,
      available: new Set(['claude']),
      headroom: () => 1,
    });
    expect(decision?.provider).toBe('claude');
  });
});
