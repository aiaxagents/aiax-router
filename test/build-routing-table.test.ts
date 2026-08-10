import { describe, expect, it } from 'vitest';
import {
  merge,
  normalize,
  parseAiderYaml,
  parseCsv,
  validate,
  type Alias,
  type Candidate,
  type Category,
  type Observation,
  type RoutingTable,
} from '../scripts/build-routing-table.js';

const CATEGORIES: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];

function table(categories: Partial<Record<Category, Candidate[]>>): RoutingTable {
  const full = {} as Record<Category, Candidate[]>;
  for (const c of CATEGORIES) full[c] = categories[c] ?? [{ ...SEED }];
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00Z',
    sources: [{ name: 'hand-seeded-v0', note: 'curated estimates' }],
    difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
    categories: full,
  };
}

const SEED: Candidate = {
  provider: 'claude',
  model: 'haiku',
  score: 66,
  costWeight: 1,
  tokensPerTask: 0.7,
  maxEffort: 'medium',
};

const OPUS: Candidate = {
  provider: 'claude',
  model: 'opus',
  score: 90,
  costWeight: 5,
  tokensPerTask: 1.8,
  maxEffort: 'xhigh',
};

const ALIASES: Record<string, Alias> = {
  'claude-opus-9-max': { provider: 'claude', model: 'opus' },
  'claude-opus-9-high': { provider: 'claude', model: 'opus' },
  'brand-new-1': { provider: 'newprov', model: 'newmodel' },
};

function obs(source: string, category: Category, name: string, value: number): Observation {
  return { source, category, name, value };
}

describe('normalize', () => {
  it('rank-percentiles each source to 0-100 before averaging', () => {
    const scores = normalize([
      obs('a', 'coding', 'x', 10),
      obs('a', 'coding', 'y', 20),
      obs('a', 'coding', 'z', 30),
      // A different scale entirely (Elo vs percent solved) and the reverse order.
      obs('b', 'coding', 'x', 1500),
      obs('b', 'coding', 'y', 1400),
    ]);
    const coding = scores.get('coding')!;
    // a ranks x 3rd of 3 (0), b ranks it 1st of 2 (100).
    expect(coding.get('x')).toBeCloseTo((0 + 100) / 2);
    expect(coding.get('y')).toBeCloseTo((50 + 0) / 2);
    // Only source a covered z, so no averaging dilutes it.
    expect(coding.get('z')).toBeCloseTo(100);
  });

  it('scores by rank, not by distance to the top of the window', () => {
    // The discriminating case: min-max would put q at 98.99 because it sits a hair under
    // p. A dense leaderboard head must not decide how adequate the runners-up are.
    const scores = normalize([
      obs('a', 'chat', 'p', 100),
      obs('a', 'chat', 'q', 99),
      obs('a', 'chat', 'r', 1),
    ]);
    expect(scores.get('chat')!.get('p')).toBe(100);
    expect(scores.get('chat')!.get('q')).toBe(50);
    expect(scores.get('chat')!.get('r')).toBe(0);
  });

  it('gives tied models the mean of their ranks', () => {
    const scores = normalize([
      obs('a', 'chat', 'x', 5),
      obs('a', 'chat', 'y', 5),
      obs('a', 'chat', 'z', 1),
    ]);
    // x and y hold ranks 1 and 2, mean 1.5 of 3 -> 75.
    expect(scores.get('chat')!.get('x')).toBe(75);
    expect(scores.get('chat')!.get('y')).toBe(75);
    expect(scores.get('chat')!.get('z')).toBe(0);
  });

  it('keeps categories independent', () => {
    const scores = normalize([
      obs('a', 'coding', 'x', 1),
      obs('a', 'coding', 'y', 2),
      obs('a', 'writing', 'x', 90),
      obs('a', 'writing', 'y', 10),
    ]);
    expect(scores.get('coding')!.get('x')).toBe(0);
    expect(scores.get('writing')!.get('x')).toBe(100);
  });

  it('collapses a fully tied group to a neutral 50 instead of a fake 0 or 100', () => {
    const scores = normalize([obs('a', 'chat', 'x', 7), obs('a', 'chat', 'y', 7)]);
    expect(scores.get('chat')!.get('x')).toBe(50);
    expect(scores.get('chat')!.get('y')).toBe(50);
  });

  it('stays neutral when a source returns a window of one', () => {
    const scores = normalize([obs('a', 'chat', 'x', 7)]);
    expect(scores.get('chat')!.get('x')).toBe(50);
  });

  it('keeps only the best run when a source lists a model twice', () => {
    const scores = normalize([
      obs('a', 'coding', 'x', 10),
      obs('a', 'coding', 'x', 30),
      obs('a', 'coding', 'y', 20),
    ]);
    expect(scores.get('coding')!.get('x')).toBe(100);
    expect(scores.get('coding')!.get('y')).toBe(0);
  });
});

describe('merge', () => {
  const opts = { generatedAt: '2026-08-04T04:00:00Z', sources: [{ name: 'livebench' }] };

  function run(coding: Map<string, number>) {
    return merge(table({ coding: [{ ...OPUS }, { ...SEED }] }), new Map([['coding', coding]]), ALIASES, opts);
  }

  it('preserves curated fields and only rewrites the score', () => {
    const { table: out } = run(new Map([['claude-opus-9-max', 42.4]]));
    const opus = out.categories.coding.find((c) => c.model === 'opus')!;
    expect(opus).toEqual({ ...OPUS, score: 42 });
  });

  it('carries hand-seeded scores forward when no source covered the model', () => {
    const { table: out } = run(new Map([['claude-opus-9-max', 42]]));
    const haiku = out.categories.coding.find((c) => c.model === 'haiku')!;
    expect(haiku).toEqual(SEED);
  });

  it('flags a newly mapped model with needsCuration and neutral defaults', () => {
    const { table: out } = run(new Map([['brand-new-1', 80]]));
    const fresh = out.categories.coding.find((c) => c.model === 'newmodel')!;
    expect(fresh).toEqual({
      provider: 'newprov',
      model: 'newmodel',
      score: 80,
      costWeight: 3,
      tokensPerTask: 1.0,
      needsCuration: true,
    });
  });

  it('excludes unmapped models and lists them, best first', () => {
    const { table: out, unmapped } = run(
      new Map([
        ['mystery-model', 99],
        ['other-mystery', 10],
        ['claude-opus-9-max', 50],
      ]),
    );
    expect(out.categories.coding.map((c) => c.model)).toEqual(['haiku', 'opus']);
    expect(unmapped).toEqual([
      { name: 'mystery-model', categories: ['coding'], best: 99 },
      { name: 'other-mystery', categories: ['coding'], best: 10 },
    ]);
  });

  it('averages several leaderboard names that resolve to one CLI model', () => {
    const { table: out } = run(
      new Map([
        ['claude-opus-9-max', 100],
        ['claude-opus-9-high', 60],
      ]),
    );
    expect(out.categories.coding.find((c) => c.model === 'opus')!.score).toBe(80);
  });

  it('sorts each category by score and keeps difficultyFloor and generatedAt', () => {
    const { table: out } = run(new Map([['claude-opus-9-max', 10]]));
    expect(out.categories.coding.map((c) => c.score)).toEqual([66, 10]);
    expect(out.difficultyFloor).toEqual({ trivial: 0, easy: 40, medium: 65, hard: 80 });
    expect(out.generatedAt).toBe('2026-08-04T04:00:00Z');
  });

  it('records the fetched sources and keeps the hand-seeded provenance', () => {
    const { table: out } = run(new Map());
    expect(out.sources.map((s) => s.name)).toEqual(['livebench', 'hand-seeded-v0']);
  });

  it('emits every category even when no source covered it', () => {
    const { table: out } = run(new Map([['claude-opus-9-max', 50]]));
    expect(Object.keys(out.categories).sort()).toEqual([...CATEGORIES].sort());
    expect(() => validate(out)).not.toThrow();
  });
});

describe('validate', () => {
  it('rejects an empty category', () => {
    const bad = table({ writing: [] });
    expect(() => validate(bad)).toThrow(/writing/);
  });

  it('rejects a candidate missing a curated field', () => {
    const bad = table({ chat: [{ provider: 'x', model: 'y', score: 1 } as Candidate] });
    expect(() => validate(bad)).toThrow(/invalid candidate/);
  });
});

describe('parsers', () => {
  it('reads the flat aider polyglot leaderboard', () => {
    const rows = parseAiderYaml(
      [
        '- dirname: 2026-01-01--run',
        '  model: gpt-9 (high)',
        '  pass_rate_1: 20.4',
        '  pass_rate_2: 35.6',
        '  command: aider --model openai/gpt-9',
        '  date: 2026-01-01',
        '',
        '- dirname: 2026-02-02--run',
        '  model: no-score-model',
        '  date: 2026-02-02',
        '',
      ].join('\n'),
    );
    expect(rows).toEqual([{ model: 'gpt-9 (high)', passRate2: 35.6, date: '2026-01-01' }]);
  });

  it('reads a quoted csv row', () => {
    expect(parseCsv('model,a,b\n"x, jr",1,2\n')).toEqual([{ model: 'x, jr', a: '1', b: '2' }]);
  });
});
