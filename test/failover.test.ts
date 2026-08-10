import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, AdapterEvent } from '../src/adapters/types.js';
import { runWithFailover, type RunEvent } from '../src/core/router.js';
import { isDead } from '../src/core/usage.js';
import type { Candidate, Classification, RoutingTable } from '../src/core/types.js';

let home: string;
let calls: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-failover-'));
  process.env.AIAX_ROUTER_HOME = home;
  calls = [];
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

function fake(id: string, events: AdapterEvent[]): Adapter {
  return {
    id,
    displayName: id,
    binary: id,
    subscriptionName: `${id} plan`,
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ loggedIn: true, loginHint: id }),
    async *run() {
      calls.push(id);
      yield* events;
    },
  };
}

const failing = (message: string): AdapterEvent[] => [
  { type: 'error', message },
  { type: 'result', ok: false, text: '' },
];

const KIMI: Candidate = { provider: 'kimi', model: 'kimi-k3', score: 74, costWeight: 2, tokensPerTask: 0.6 };
const GROK: Candidate = { provider: 'grok', model: 'grok-4.5', score: 80, costWeight: 3, tokensPerTask: 1 };
const SOL: Candidate = { provider: 'codex', model: 'sol', score: 84, costWeight: 4, tokensPerTask: 1.5 };

const TABLE: RoutingTable = {
  schemaVersion: 1,
  generatedAt: '2026-08-04T00:00:00Z',
  sources: [{ name: 'test-fixture' }],
  categories: {
    coding: [],
    'agentic-coding': [],
    reasoning: [],
    writing: [],
    chat: [KIMI, GROK, SOL],
    'long-context': [],
  },
  difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
};

const CLASSIFICATION: Classification = {
  category: 'chat',
  difficulty: 'easy',
  rationale: 'fixture',
  via: 'heuristic',
};

async function run(adapters: Adapter[]): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runWithFailover('say hi', {
    adapters,
    table: TABLE,
    classification: CLASSIFICATION,
    available: new Set(adapters.map((a) => a.id)),
  })) {
    events.push(ev);
  }
  return events;
}

const picked = (events: RunEvent[]): string[] =>
  events.filter((e) => e.type === 'decision').map((e: any) => e.decision.provider);
const failovers = (events: RunEvent[]): string[] =>
  events.filter((e) => e.type === 'failover').map((e: any) => e.message);
const result = (events: RunEvent[]): any => events.filter((e) => e.type === 'result').at(-1);

describe('runWithFailover', () => {
  it('hands the job to the next candidate when a tool cannot serve it', async () => {
    const events = await run([
      fake('kimi', failing('IneligibleTierError: migrate to Antigravity')),
      fake('grok', [{ type: 'result', ok: true, text: 'ROUTER-OK' }]),
      fake('codex', failing('should not be reached')),
    ]);

    expect(calls).toEqual(['kimi', 'grok']);
    expect(picked(events)).toEqual(['kimi', 'grok']);
    expect(failovers(events)).toEqual([
      'That tool could not take the job (IneligibleTierError). Trying grok/grok-4.5 instead.',
    ]);
    expect(result(events).ok).toBe(true);
    expect(result(events).text).toBe('ROUTER-OK');
    expect(isDead('kimi')).toBe(true);
    expect(isDead('grok')).toBe(false);
  });

  it('hands a plain failure to the next candidate without benching the tool', async () => {
    const events = await run([
      fake('kimi', [{ type: 'result', ok: false, text: 'SyntaxError: unexpected token' }]),
      fake('grok', [{ type: 'result', ok: true, text: 'ROUTER-OK' }]),
    ]);

    expect(calls).toEqual(['kimi', 'grok']);
    expect(failovers(events)).toEqual([
      'kimi could not finish this, so grok/grok-4.5 is taking over.',
    ]);
    expect(result(events).ok).toBe(true);
    expect(result(events).text).toBe('ROUTER-OK');
    expect(isDead('kimi')).toBe(false);
  });

  it('does not trust a result that says success while the CLI exited non-zero', async () => {
    // What Claude Code does when it is out of quota.
    const events = await run([
      fake('kimi', [
        { type: 'result', ok: true, text: "You've hit your session limit · resets 11pm" },
        { type: 'error', message: 'exit 1' },
      ]),
      fake('grok', [{ type: 'result', ok: true, text: 'ROUTER-OK' }]),
    ]);

    expect(calls).toEqual(['kimi', 'grok']);
    expect(failovers(events)).toEqual([
      'That tool could not take the job (session limit). Trying grok/grok-4.5 instead.',
    ]);
    expect(result(events).text).toBe('ROUTER-OK');
    expect(isDead('kimi')).toBe(true);
  });

  it('gives up after three attempts', async () => {
    const events = await run([
      fake('kimi', failing('quota exhausted for this tier')),
      fake('grok', failing('rate limit reached')),
      fake('codex', failing("you've hit your session limit")),
    ]);

    expect(calls).toEqual(['kimi', 'grok', 'codex']);
    expect(picked(events)).toHaveLength(3);
    expect(failovers(events)).toHaveLength(2);
    expect(result(events).ok).toBe(false);
    expect([isDead('kimi'), isDead('grok'), isDead('codex')]).toEqual([true, true, true]);
  });

  it('stops when no candidate is left to try', async () => {
    const events = await run([fake('kimi', failing('IneligibleTierError'))]);

    expect(calls).toEqual(['kimi']);
    expect(failovers(events)).toEqual([]);
    expect(result(events).ok).toBe(false);
  });
});
