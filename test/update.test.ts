import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configPath, writeJson } from '../src/core/store.js';
import {
  aaTokens,
  enrichWithAa,
  fetchTable,
  parseUpdateArgs,
  readAaKey,
  update,
  type AaModel,
  type Alias,
  DEFAULT_TABLE_URL,
} from '../src/core/update.js';
import type { Candidate, Category, RoutingTable } from '../src/core/types.js';

const CATEGORIES: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];

function candidate(over: Partial<Candidate> = {}): Candidate {
  return { provider: 'claude', model: 'opus', score: 90, costWeight: 3, tokensPerTask: 1, ...over };
}

function table(coding?: Candidate[]): RoutingTable {
  const categories = {} as Record<Category, Candidate[]>;
  for (const c of CATEGORIES) categories[c] = [candidate()];
  if (coding) categories.coding = coding;
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-04T00:00:00Z',
    sources: [{ name: 'hand-seeded-v0' }],
    difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
    categories,
  };
}

const ALIASES: Record<string, Alias> = {
  'gpt-5.5': { provider: 'codex', model: 'gpt-5.5' },
  'claude-opus-5-max': { provider: 'claude', model: 'opus' },
  'grok-4.5': { provider: 'grok', model: 'grok-4.5' },
};

function aaModel(slug: string, output: number): AaModel {
  return {
    slug,
    name: slug,
    artificial_analysis_intelligence_index_token_counts: {
      input_tokens: 1000,
      output_tokens: output,
      answer_tokens: output / 2,
      reasoning_tokens: output / 2,
    },
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-update-'));
  process.env.AIAX_ROUTER_HOME = home;
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('parseUpdateArgs', () => {
  it('defaults to the published table', () => {
    expect(parseUpdateArgs([]).from).toBe(DEFAULT_TABLE_URL);
  });

  it('takes a local path or a url from --from', () => {
    expect(parseUpdateArgs(['--from', './routing-table.json']).from).toBe('./routing-table.json');
    expect(parseUpdateArgs(['--from', 'https://example.com/t.json']).from).toBe(
      'https://example.com/t.json',
    );
  });

  it('ignores --from without a value', () => {
    expect(parseUpdateArgs(['--from', '--other']).from).toBe(DEFAULT_TABLE_URL);
  });
});

describe('fetchTable', () => {
  it('accepts a valid table from a local file', async () => {
    const file = join(home, 'good.json');
    writeFileSync(file, JSON.stringify(table()));
    await expect(fetchTable(file)).resolves.toMatchObject({ generatedAt: '2026-08-04T00:00:00Z' });
  });

  it('rejects a table with a broken candidate, in one plain sentence', async () => {
    const file = join(home, 'bad.json');
    const broken = table([{ provider: 'claude', model: 'opus' } as Candidate]);
    writeFileSync(file, JSON.stringify(broken));
    await expect(fetchTable(file)).rejects.toThrow(/is not a valid routing table/);
  });

  it('rejects a table with an empty category', async () => {
    const file = join(home, 'empty.json');
    writeFileSync(file, JSON.stringify(table([])));
    await expect(fetchTable(file)).rejects.toThrow(/is not a valid routing table/);
  });

  it('rejects a file that is not JSON', async () => {
    const file = join(home, 'junk.json');
    writeFileSync(file, 'not json at all');
    await expect(fetchTable(file)).rejects.toThrow(/is not JSON/);
  });

  it('says so plainly when a file is missing', async () => {
    await expect(fetchTable(join(home, 'nope.json'))).rejects.toThrow(/Could not read/);
  });

  it('turns an http failure into one sentence with the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404, statusText: 'Not Found' })),
    );
    await expect(fetchTable('https://example.com/t.json')).rejects.toThrow(
      /Could not download the routing table from https:\/\/example\.com\/t\.json: HTTP 404 Not Found\./,
    );
  });

  it('accepts a valid table over http', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(table()), { status: 200 })),
    );
    await expect(fetchTable('https://example.com/t.json')).resolves.toMatchObject({
      schemaVersion: 1,
    });
  });
});

describe('aaTokens', () => {
  it('prefers output_tokens', () => {
    expect(aaTokens(aaModel('gpt-5.5', 4000))).toBe(4000);
  });

  it('falls back to answer plus reasoning', () => {
    expect(
      aaTokens({
        slug: 'x',
        artificial_analysis_intelligence_index_token_counts: {
          answer_tokens: 300,
          reasoning_tokens: 700,
        },
      }),
    ).toBe(1000);
  });

  it('returns nothing when the free tier omits token counts', () => {
    expect(aaTokens({ slug: 'x', name: 'x' })).toBeUndefined();
  });
});

describe('enrichWithAa', () => {
  it('scales tokensPerTask against the median measured model', () => {
    const t = table([
      candidate({ provider: 'codex', model: 'gpt-5.5' }),
      candidate({ provider: 'claude', model: 'opus' }),
      candidate({ provider: 'grok', model: 'grok-4.5' }),
    ]);
    const touched = enrichWithAa(
      t,
      {
        data: [
          aaModel('gpt-5.5', 8000),
          aaModel('claude-opus-5-max', 4000),
          aaModel('grok-4.5', 2000),
        ],
      },
      ALIASES,
    );
    // Median of 8000/4000/2000 is 4000, so opus is the baseline at 1.
    const byModel = new Map(t.categories.coding.map((c) => [c.model, c.tokensPerTask]));
    expect(byModel.get('gpt-5.5')).toBe(2);
    expect(byModel.get('opus')).toBe(1);
    expect(byModel.get('grok-4.5')).toBe(0.5);
    // opus also sits in every other category, so it is touched there too.
    expect(touched).toBe(3 + (CATEGORIES.length - 1));
  });

  it('leaves unmapped candidates alone', () => {
    const t = table([
      candidate({ provider: 'codex', model: 'gpt-5.5' }),
      candidate({ provider: 'kimi', model: 'kimi-k3', tokensPerTask: 1.7 }),
    ]);
    enrichWithAa(t, { data: [aaModel('gpt-5.5', 8000), aaModel('grok-4.5', 2000)] }, ALIASES);
    expect(t.categories.coding[1].tokensPerTask).toBe(1.7);
  });

  it('averages several AA rows that resolve to one CLI model', () => {
    const t = table([candidate({ provider: 'codex', model: 'gpt-5.5' })]);
    const aliases: Record<string, Alias> = {
      ...ALIASES,
      'gpt-5.5-high': { provider: 'codex', model: 'gpt-5.5' },
    };
    enrichWithAa(
      t,
      { data: [aaModel('gpt-5.5', 2000), aaModel('gpt-5.5-high', 6000), aaModel('grok-4.5', 4000)] },
      aliases,
    );
    // gpt-5.5 averages to 4000, grok is 4000, so the median baseline is 4000.
    expect(t.categories.coding[0].tokensPerTask).toBe(1);
  });

  it('clamps an outlier instead of taking a model out of contention', () => {
    const t = table([
      candidate({ provider: 'codex', model: 'gpt-5.5' }),
      candidate({ provider: 'claude', model: 'opus' }),
      candidate({ provider: 'grok', model: 'grok-4.5' }),
    ]);
    enrichWithAa(
      t,
      {
        data: [
          aaModel('gpt-5.5', 4_000_000),
          aaModel('claude-opus-5-max', 4000),
          aaModel('grok-4.5', 1),
        ],
      },
      ALIASES,
    );
    const byModel = new Map(t.categories.coding.map((c) => [c.model, c.tokensPerTask]));
    expect(byModel.get('gpt-5.5')).toBe(5);
    expect(byModel.get('grok-4.5')).toBe(0.25);
  });

  it('changes nothing when no AA row carries token counts', () => {
    const t = table([candidate({ provider: 'codex', model: 'gpt-5.5', tokensPerTask: 1.4 })]);
    expect(enrichWithAa(t, { data: [{ slug: 'gpt-5.5', name: 'gpt-5.5' }] }, ALIASES)).toBe(0);
    expect(t.categories.coding[0].tokensPerTask).toBe(1.4);
  });
});

describe('readAaKey', () => {
  it('finds a key in the user config', () => {
    writeJson(configPath('config.json'), { budgets: {}, aaApiKey: ' abc ' });
    expect(readAaKey()).toBe('abc');
  });

  it('treats a missing or blank key as no key', () => {
    expect(readAaKey()).toBeUndefined();
    writeJson(configPath('config.json'), { budgets: {}, aaApiKey: '   ' });
    expect(readAaKey()).toBeUndefined();
  });
});

describe('update', () => {
  it('writes the local override and reports what landed', async () => {
    const file = join(home, 'src.json');
    writeFileSync(file, JSON.stringify(table()));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await update(['--from', file])).toBe(0);

    const written = JSON.parse(
      readFileSync(configPath('routing-table.json'), 'utf8'),
    ) as RoutingTable;
    expect(written.generatedAt).toBe('2026-08-04T00:00:00Z');
    expect(log.mock.calls[0][0]).toBe(
      'Saved the routing table generated at 2026-08-04T00:00:00Z with 6 candidates.',
    );
    expect(log.mock.calls[1][0]).toBe(
      'Add an Artificial Analysis key in config to sharpen token estimates.',
    );
  });

  it('enriches from AA when a key is configured', async () => {
    const file = join(home, 'src.json');
    writeFileSync(
      file,
      JSON.stringify(
        table([
          candidate({ provider: 'codex', model: 'gpt-5.5' }),
          candidate({ provider: 'grok', model: 'grok-4.5' }),
        ]),
      ),
    );
    writeJson(configPath('config.json'), { budgets: {}, aaApiKey: 'key' });
    const seen: { url: string; key: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, key: (init.headers as Record<string, string>)['x-api-key'] });
        return new Response(
          JSON.stringify({ data: [aaModel('gpt-5.5', 8000), aaModel('grok-4.5', 2000)] }),
          { status: 200 },
        );
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await update(['--from', file])).toBe(0);

    expect(seen[0].key).toBe('key');
    const written = JSON.parse(
      readFileSync(configPath('routing-table.json'), 'utf8'),
    ) as RoutingTable;
    expect(written.categories.coding.map((c) => c.tokensPerTask)).toEqual([1.6, 0.4]);
    expect(log.mock.calls[1][0]).toMatch(/Sharpened token estimates for 2 models/);
  });

  it('keeps the table when AA itself fails', async () => {
    const file = join(home, 'src.json');
    writeFileSync(file, JSON.stringify(table()));
    writeJson(configPath('config.json'), { budgets: {}, aaApiKey: 'key' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' })),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await update(['--from', file])).toBe(0);
    expect(readFileSync(configPath('routing-table.json'), 'utf8')).toContain('"schemaVersion": 1');
    expect(log.mock.calls[1][0]).toMatch(/Artificial Analysis did not answer \(HTTP 401 Unauthorized\)/);
  });

  it('writes nothing and exits 1 when the source is unusable', async () => {
    const file = join(home, 'bad.json');
    writeFileSync(file, '{}');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await update(['--from', file])).toBe(1);
    expect(() => readFileSync(configPath('routing-table.json'), 'utf8')).toThrow();
    expect(err.mock.calls[0][0]).toMatch(/is not a valid routing table, so nothing was written\./);
  });
});
