import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classify, classifyHeuristic, looksConversational } from '../src/core/classify.js';
import { isDead } from '../src/core/usage.js';
import type { Adapter, AdapterEvent } from '../src/adapters/types.js';
import type { Candidate, RoutingTable } from '../src/core/types.js';

describe('classifyHeuristic', () => {
  it('reads a rename as small coding work', () => {
    const c = classifyHeuristic('rename the variable x to y in main.py');
    expect(c.category).toBe('agentic-coding');
    expect(['trivial', 'easy']).toContain(c.difficulty);
    expect(c.via).toBe('heuristic');
  });

  it('keeps a plain code fix out of the agentic bucket', () => {
    expect(classifyHeuristic('fix the bug in the date parser function').category).toBe('coding');
  });

  it('reads a complexity question as reasoning', () => {
    expect(classifyHeuristic('why is this O(n^2)').category).toBe('reasoning');
  });

  it('reads a blog request as writing', () => {
    const c = classifyHeuristic('write a blog post about local-first software');
    expect(c.category).toBe('writing');
    expect(c.difficulty).toBe('easy');
  });

  it('calls architecture work hard', () => {
    const c = classifyHeuristic(
      'design the end to end architecture for a multi tenant billing system',
    );
    expect(c.category).toBe('reasoning');
    expect(c.difficulty).toBe('hard');
  });

  it('treats a long paste as long-context', () => {
    expect(classifyHeuristic('a'.repeat(9000)).category).toBe('long-context');
  });

  it('falls back to chat', () => {
    const c = classifyHeuristic('what is the capital of France');
    expect(c.category).toBe('chat');
    expect(c.difficulty).toBe('trivial');
  });
});

// --- model-based classifier --------------------------------------------------

let home: string;
let asked: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-classify-'));
  process.env.AIAX_ROUTER_HOME = home;
  asked = [];
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

function answering(id: string, events: AdapterEvent[]): Adapter {
  return {
    id,
    displayName: id,
    binary: id,
    subscriptionName: `${id} plan`,
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ loggedIn: true, loginHint: id }),
    async *run() {
      asked.push(id);
      yield* events;
    },
  };
}

const says = (text: string): AdapterEvent[] => [{ type: 'result', ok: true, text }];

const FLASH: Candidate = {
  provider: 'kimi',
  model: 'flash',
  score: 74,
  costWeight: 0.5,
  tokensPerTask: 0.6,
};
const HAIKU: Candidate = {
  provider: 'claude',
  model: 'haiku',
  score: 76,
  costWeight: 1,
  tokensPerTask: 0.7,
};
const SOL: Candidate = {
  provider: 'codex',
  model: 'sol',
  score: 92,
  costWeight: 4,
  tokensPerTask: 1.9,
};

function table(chat: Candidate[]): RoutingTable {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-04T00:00:00Z',
    sources: [{ name: 'test-fixture' }],
    categories: {
      coding: [],
      'agentic-coding': [],
      reasoning: [],
      writing: [],
      chat,
      'long-context': [],
    },
    difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
  };
}

const ALL = new Set(['kimi', 'claude', 'codex']);

describe('classify', () => {
  it('takes the answer of the cheapest available model', async () => {
    const c = await classify('write a haiku', ALL, table([SOL, HAIKU, FLASH]), [
      answering('kimi', says('{"category":"writing","difficulty":"easy","rationale":"short poem"}')),
      answering('claude', says('unused')),
    ]);

    expect(asked).toEqual(['kimi']);
    expect(c).toEqual({
      category: 'writing',
      difficulty: 'easy',
      rationale: 'short poem',
      via: 'model',
      // Absent from the model's answer means "this is work", never small talk.
      conversational: false,
    });
  });

  it('strips markdown fences', async () => {
    const c = await classify('fix the parser', ALL, table([FLASH]), [
      answering(
        'kimi',
        says('```json\n{"category":"coding","difficulty":"medium","rationale":"parser bug"}\n```'),
      ),
    ]);

    expect(c.category).toBe('coding');
    expect(c.via).toBe('model');
  });

  it('digs the JSON out of surrounding prose', async () => {
    const c = await classify('design a schema', ALL, table([FLASH]), [
      answering(
        'kimi',
        says(
          'Sure! Here is the classification you asked for:\n' +
            '{"category":"reasoning","difficulty":"hard","rationale":"data model {design} work"}\n' +
            'Let me know if you want more detail.',
        ),
      ),
    ]);

    expect(c.category).toBe('reasoning');
    expect(c.difficulty).toBe('hard');
    expect(c.rationale).toBe('data model {design} work');
  });

  it('falls back to the heuristic on an unusable answer', async () => {
    const c = await classify('why is this O(n^2)', ALL, table([FLASH]), [
      answering('kimi', says('I think it is a reasoning task, difficulty medium.')),
    ]);

    expect(c.via).toBe('heuristic');
    expect(c.category).toBe('reasoning');
  });

  it('rejects a category it does not know', async () => {
    const c = await classify('write a haiku', ALL, table([FLASH]), [
      answering('kimi', says('{"category":"poetry","difficulty":"easy","rationale":"nope"}')),
    ]);

    expect(c.via).toBe('heuristic');
  });

  it('marks the classifier dead when it cannot serve, and still classifies', async () => {
    const c = await classify('write a haiku', ALL, table([FLASH]), [
      answering('kimi', [
        { type: 'error', message: 'IneligibleTierError: migrate to Antigravity' },
        { type: 'result', ok: false, text: '' },
      ]),
    ]);

    expect(c.via).toBe('heuristic');
    expect(isDead('kimi')).toBe(true);
  });

  it('does not spend an expensive model on classifying', async () => {
    const c = await classify('write a haiku', ALL, table([SOL]), [answering('codex', says('{}'))]);

    expect(asked).toEqual([]);
    expect(c.via).toBe('heuristic');
  });
});

describe('looksConversational', () => {
  it('catches Norwegian and English small talk', () => {
    for (const line of ['Er du der?', 'hei!', 'Takk :)', 'hvem er du', 'are you there?', 'hello']) {
      expect(looksConversational(line)).toBe(true);
    }
  });

  it('leaves real requests alone, however short or chatty they open', () => {
    for (const line of [
      'Turn my meeting notes into a two page report',
      'Book a table for six on Friday',
      'hei, kan du skrive et sammendrag av rapporten jeg sendte deg i går',
      'fix the bug in the date parser',
    ]) {
      expect(looksConversational(line)).toBe(false);
    }
  });
});
