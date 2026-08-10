import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/types.js';
import { LENSES, PASS_MARK, reviewPanel, reviewerPool } from '../src/core/review.js';
import type { Candidate, Difficulty, RoutingTable } from '../src/core/types.js';

let home: string;
let asked: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-review-'));
  process.env.AIAX_ROUTER_HOME = home;
  asked = [];
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

const OPUS: Candidate = {
  provider: 'claude',
  model: 'opus',
  score: 89,
  costWeight: 5,
  tokensPerTask: 1.6,
};
const GROK: Candidate = {
  provider: 'grok',
  model: 'grok-4.5',
  score: 80,
  costWeight: 3,
  tokensPerTask: 1,
};
const FLASH: Candidate = {
  provider: 'kimi',
  model: 'flash',
  score: 74,
  costWeight: 0.5,
  tokensPerTask: 0.6,
};

const TABLE: RoutingTable = {
  schemaVersion: 1,
  generatedAt: '2026-08-04T00:00:00Z',
  sources: [{ name: 'test-fixture' }],
  categories: {
    coding: [],
    'agentic-coding': [],
    reasoning: [],
    writing: [],
    chat: [OPUS, GROK, FLASH],
    'long-context': [],
  },
  difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
};

const ALL = new Set(['claude', 'grok', 'kimi']);

function reviewer(id: string, answer: (n: number) => string | null): Adapter {
  let n = 0;
  return {
    id,
    displayName: id,
    binary: id,
    subscriptionName: `${id} plan`,
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ loggedIn: true, loginHint: id }),
    async *run() {
      asked.push(id);
      const text = answer(n++);
      if (text === null) {
        yield { type: 'error', message: 'not today' };
        yield { type: 'result', ok: false, text: '' };
        return;
      }
      yield { type: 'result', ok: true, text };
    },
  };
}

const scored = (score: number, gaps: string[] = []) =>
  JSON.stringify({ score, note: 'because of reasons', gaps });

function panel(adapters: Adapter[], difficulty: Difficulty = 'easy') {
  return reviewPanel({
    intent: 'Explain what a router does.',
    acceptanceCriteria: ['One short sentence.'],
    work: 'A router picks the right tool for the job.',
    category: 'chat',
    difficulty,
    available: ALL,
    table: TABLE,
    adapters,
  });
}

describe('reviewerPool', () => {
  it('puts the cheap seats first for easy work', () => {
    const pool = reviewerPool(ALL, TABLE, 'chat', 'easy');
    expect(pool.map((c) => c.provider)).toEqual(['kimi', 'grok', 'claude']);
  });

  it('puts the strong models first for hard work', () => {
    const pool = reviewerPool(ALL, TABLE, 'chat', 'hard');
    expect(pool.map((c) => c.provider)).toEqual(['claude', 'grok', 'kimi']);
  });

  it('spreads over providers before it reuses one', () => {
    const table: RoutingTable = {
      ...TABLE,
      categories: {
        ...TABLE.categories,
        chat: [OPUS, { ...OPUS, model: 'sonnet', score: 86 }, GROK],
      },
    };
    expect(reviewerPool(ALL, table, 'chat', 'hard').map((c) => c.model)).toEqual([
      'opus',
      'grok-4.5',
      'sonnet',
    ]);
  });
});

describe('reviewPanel', () => {
  it('passes at the bar and spreads the five lenses over the providers', async () => {
    const outcome = await panel([
      reviewer('kimi', () => scored(9.5)),
      reviewer('grok', () => scored(9.5)),
      reviewer('claude', () => scored(9.5)),
    ]);

    expect(outcome.average).toBe(PASS_MARK);
    expect(outcome.passed).toBe(true);
    expect(outcome.reviewed).toBe(true);
    expect(outcome.scores).toHaveLength(LENSES.length);
    expect(new Set(outcome.scores.map((s) => s.provider)).size).toBe(3);
    expect(outcome.scores.map((s) => s.lens)).toEqual(LENSES.map((l) => l.name));
  });

  it('fails just under the bar and collects the concrete gaps', async () => {
    const outcome = await panel([
      reviewer('kimi', () => scored(9, ['Say what it costs.'])),
      reviewer('grok', () => scored(9.5, ['Say what it costs.'])),
      reviewer('claude', () => scored(9.5, ['Name the alternatives.'])),
    ]);

    expect(outcome.average).toBeLessThan(PASS_MARK);
    expect(outcome.passed).toBe(false);
    expect(outcome.gaps).toEqual(['Say what it costs.', 'Name the alternatives.']);
  });

  it('ignores a reviewer that could not answer and scores the rest', async () => {
    const outcome = await panel([
      reviewer('kimi', () => null),
      reviewer('grok', () => scored(10)),
      reviewer('claude', () => scored(10)),
    ]);

    expect(outcome.reviewed).toBe(true);
    expect(outcome.scores.length).toBeLessThan(LENSES.length);
    expect(outcome.passed).toBe(true);
  });

  it('says so honestly when nobody could check the work', async () => {
    const outcome = await panel([
      reviewer('kimi', () => null),
      reviewer('grok', () => null),
      reviewer('claude', () => null),
    ]);

    expect(outcome.reviewed).toBe(false);
    expect(outcome.passed).toBe(false);
    expect(outcome.scores).toEqual([]);
  });

  it('keeps a wild score inside one and ten', async () => {
    const outcome = await panel([
      reviewer('kimi', () => scored(42)),
      reviewer('grok', () => scored(42)),
      reviewer('claude', () => scored(42)),
    ]);

    expect(outcome.average).toBe(10);
  });
});
