import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/types.js';
import {
  acceptProposals,
  confirmPage,
  distillEpisode,
  ensureBundle,
  findSecret,
  forgetPage,
  isStale,
  listPages,
  memoryBrief,
  memoryDir,
  memoryManifest,
  pageFromRaw,
  parseFrontmatterBlock,
  savePage,
  selectPages,
  trustTier,
  type PageContent,
} from '../src/core/memory.js';
import { newTaskState } from '../src/core/taskstate.js';
import type { Candidate, RoutingTable } from '../src/core/types.js';
import { memoryFilePath } from '../src/web/serve.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-memory-'));
  process.env.AIAX_ROUTER_HOME = home;
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

function page(over: Partial<PageContent> = {}): PageContent {
  return {
    type: 'Preference',
    title: 'Short answers',
    description: 'Wants answers short and plain.',
    tags: ['writing'],
    status: 'draft',
    staleAfter: '2099-01-01',
    generatedBy: 'aiax-router/0.1.0',
    generatedAt: '2026-08-05T10:00:00.000Z',
    machine: 'test-mac',
    body: 'Keep every answer short. No filler.',
    ...over,
  };
}

function seed(rel: string, raw: string): void {
  const path = join(memoryDir(), rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, raw);
}

// --- frontmatter reader ------------------------------------------------------

describe('parseFrontmatterBlock', () => {
  it('reads scalars, inline maps, inline lists and block lists of inline maps', () => {
    const fm = parseFrontmatterBlock(
      [
        'type: Preference',
        'title: "Short: answers"',
        'tags: [writing, style]',
        'generated: { by: aiax-router/0.1.0, at: 2026-08-05T10:00:00Z }',
        'verified:',
        '  - { by: human:jp, at: 2026-08-05T11:00:00Z }',
        '  - { by: process:nightly, at: 2026-08-06T02:00:00Z }',
        'status: stable',
      ].join('\n'),
    );
    expect(fm?.type).toBe('Preference');
    expect(fm?.title).toBe('Short: answers');
    expect(fm?.tags).toEqual(['writing', 'style']);
    expect(fm?.generated).toEqual({ by: 'aiax-router/0.1.0', at: '2026-08-05T10:00:00Z' });
    expect(fm?.verified).toEqual([
      { by: 'human:jp', at: '2026-08-05T11:00:00Z' },
      { by: 'process:nightly', at: '2026-08-06T02:00:00Z' },
    ]);
  });

  it('reads a simple nested map the way a hand author writes one', () => {
    const fm = parseFrontmatterBlock('type: Note\ngenerated:\n  by: human:jp\n  at: 2026-08-05');
    expect(fm?.generated).toEqual({ by: 'human:jp', at: '2026-08-05' });
  });

  it('keeps an unknown nested structure as raw text instead of failing the page', () => {
    const fm = parseFrontmatterBlock(
      'type: Attested Computation\nexecutor:\n  resource: run.md\n  receipt: [job_id, sql]\nruntime: bigquery',
    );
    expect(fm?.type).toBe('Attested Computation');
    expect(fm?.runtime).toBe('bigquery');
  });

  it('returns null on structurally hostile input', () => {
    expect(parseFrontmatterBlock('::::\n{{{{')).toBeNull();
    expect(parseFrontmatterBlock('  leading indent with no key')).toBeNull();
  });
});

describe('pageFromRaw (permissive consumer)', () => {
  it('degrades unparseable frontmatter to a generic concept, never a rejection', () => {
    const got = pageFromRaw('notes/my-note.md', '---\n<<<garbage:::\n---\nhand-written body');
    expect(got.parsed).toBe(false);
    expect(got.type).toBe('Concept');
    expect(got.title).toBe('my note');
    expect(got.status).toBe('stable');
  });

  it('tolerates unknown type, unknown keys, missing optionals and broken links', () => {
    const got = pageFromRaw(
      'x.md',
      '---\ntype: Quantum Ledger\nmystery_key: 42\n---\nSee [gone](/never/was.md).',
    );
    expect(got.parsed).toBe(true);
    expect(got.type).toBe('Quantum Ledger');
    expect(got.title).toBe('x');
    expect(got.status).toBe('stable');
    expect(trustTier(got)).toBe('unverified');
  });

  it('treats a bare verified mapping as a one-element list and reads legacy timestamp', () => {
    const got = pageFromRaw(
      'x.md',
      "---\ntype: Note\nverified: { by: human:jp, at: 2026-08-05 }\ntimestamp: '2026-01-01T00:00:00Z'\n---\nbody",
    );
    expect(got.verified).toEqual([{ by: 'human:jp', at: '2026-08-05' }]);
    expect(got.generatedAt).toBe('2026-01-01T00:00:00Z');
    expect(trustTier(got)).toBe('human');
  });

  it('a file with no frontmatter at all is still a page', () => {
    const got = pageFromRaw('plain.md', '# Just some markdown\n');
    expect(got.parsed).toBe(false);
    expect(got.type).toBe('Concept');
  });
});

// --- secret guard ------------------------------------------------------------

describe('secret guard', () => {
  it('names every pattern family', () => {
    expect(findSecret('api_key = "aVeryLongSecretValue123456"')).toBe('credential assignment');
    expect(findSecret(`sk-${'a'.repeat(24)}`)).toBe('provider key');
    expect(findSecret('AKIAABCDEFGHIJKLMNOP')).toBe('AWS access key');
    expect(findSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe('private key block');
    expect(findSecret(`eyJ${'a'.repeat(32)}.${'b'.repeat(12)}.sig`)).toBe('JWT');
    expect(findSecret('a perfectly ordinary sentence')).toBeNull();
  });

  it('savePage drops a secret-bearing page and logs the drop', () => {
    const got = savePage(page({ body: `the key is sk-${'x'.repeat(24)}` }));
    expect(got.ok).toBe(false);
    expect(listPages()).toHaveLength(0);
    const log = readFileSync(join(memoryDir(), 'log.md'), 'utf8');
    expect(log).toContain('**Drop**');
    expect(log).toContain('provider key');
  });

  it('savePage drops a page past the size cap', () => {
    const got = savePage(page({ body: 'x'.repeat(9000) }));
    expect(got.ok).toBe(false);
    expect(listPages()).toHaveLength(0);
  });
});

// --- writes: dedupe, log, index ----------------------------------------------

describe('savePage', () => {
  it('creates a page that carries the full producer contract', () => {
    const got = savePage(page());
    expect(got).toMatchObject({ ok: true, created: true, path: 'preferences/short-answers.md' });
    const raw = readFileSync(join(memoryDir(), 'preferences/short-answers.md'), 'utf8');
    expect(raw).toContain('type: Preference');
    expect(raw).toContain('generated: { by: aiax-router/0.1.0, at: 2026-08-05T10:00:00.000Z }');
    expect(raw).toContain('status: draft');
    expect(raw).toContain('stale_after: 2099-01-01');
    expect(raw).toContain('machine: test-mac');
    const index = readFileSync(join(memoryDir(), 'index.md'), 'utf8');
    expect(index).toContain('okf_version: "0.2"');
    expect(index).toContain('* [Short answers](preferences/short-answers.md) - Wants answers short');
  });

  it('a type + title match updates the page instead of creating a sibling', () => {
    savePage(page());
    const got = savePage(
      page({ body: 'New body.', generatedAt: '2026-08-06T09:00:00.000Z', title: 'SHORT ANSWERS' }),
    );
    expect(got).toMatchObject({ ok: true, created: false });
    const pages = listPages();
    expect(pages).toHaveLength(1);
    expect(pages[0].body.trim()).toBe('New body.');
    expect(pages[0].generatedAt).toBe('2026-08-06T09:00:00.000Z');
  });

  it('an update keeps verified history, status and unknown keys verbatim', () => {
    savePage(page());
    confirmPage('preferences/short-answers.md', 'JP');
    // A hand edit adds a key the router does not know.
    const path = join(memoryDir(), 'preferences/short-answers.md');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('\n---\n\n', '\nmood: cheerful\n---\n\n'),
    );
    const before = listPages()[0];
    expect(before.status).toBe('stable');

    savePage(page({ body: 'Even shorter.', generatedAt: '2026-08-07T00:00:00.000Z' }));
    const after = listPages()[0];
    expect(after.status).toBe('stable');
    expect(trustTier(after)).toBe('human');
    expect(after.raw).toContain('mood: cheerful');
    expect(after.body.trim()).toBe('Even shorter.');
  });

  it('never rewrites a hand-written page the reader could not parse', () => {
    seed('preferences/short-answers.md', '---\n<<<broken\n---\nmy own words\n');
    const got = savePage(page({ title: 'short answers' }));
    expect(got.ok).toBe(true);
    expect(readFileSync(join(memoryDir(), 'preferences/short-answers.md'), 'utf8')).toContain(
      'my own words',
    );
    expect(listPages().filter((p) => p.path.startsWith('preferences/'))).toHaveLength(1);
  });

  it('logs every write under an ISO heading, newest first', () => {
    savePage(page());
    savePage(page({ title: 'Answers in Norwegian', body: 'Answer in Norwegian.' }));
    const log = readFileSync(join(memoryDir(), 'log.md'), 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    const lines = log.split('\n');
    const heading = lines.findIndex((l) => l === `## ${today}`);
    expect(heading).toBeGreaterThan(-1);
    expect(lines[heading + 1]).toContain('Answers in Norwegian');
    expect(lines[heading + 2]).toContain('Short answers');
  });
});

// --- confirm and forget ------------------------------------------------------

describe('confirm and forget', () => {
  it('confirm appends a human verified entry and promotes draft to stable', () => {
    savePage(page());
    const got = confirmPage('preferences/short-answers.md', 'JP');
    expect(got.ok).toBe(true);
    const p = listPages()[0];
    expect(p.status).toBe('stable');
    expect(trustTier(p)).toBe('human');
    expect(p.verified[0].by).toBe('human:JP');
    expect(isStale(p)).toBe(false);
  });

  it('forget deletes the file and logs it', () => {
    savePage(page());
    const got = forgetPage('preferences/short-answers.md');
    expect(got.ok).toBe(true);
    expect(listPages()).toHaveLength(0);
    expect(readFileSync(join(memoryDir(), 'log.md'), 'utf8')).toContain('**Deletion**');
  });

  it('confirm refuses to rewrite an unparseable hand-written note', () => {
    seed('notes/mine.md', '---\n<<<broken\n---\nmine\n');
    expect(confirmPage('notes/mine.md', 'JP').ok).toBe(false);
    expect(readFileSync(join(memoryDir(), 'notes/mine.md'), 'utf8')).toContain('mine');
  });
});

// --- selection ---------------------------------------------------------------

function seedSelection(): void {
  ensureBundle();
  savePage(page()); // draft Preference
  confirmPage('preferences/short-answers.md', 'JP'); // now stable + human
  savePage(
    page({
      type: 'Playbook',
      title: 'Deploy dance',
      tags: ['coding'],
      body: 'Build, verify, ship.',
      generatedAt: '2026-08-01T00:00:00.000Z',
    }),
  );
  savePage(
    page({
      type: 'Project',
      title: 'Router work',
      tags: ['coding'],
      body: 'The router project.',
      generatedAt: '2026-08-03T00:00:00.000Z',
    }),
  );
  seed(
    'projects/old-thing.md',
    '---\ntype: Project\ntitle: Old thing\ntags: [coding]\nstatus: deprecated\n---\nGone.\n',
  );
  seed(
    'projects/stale-thing.md',
    '---\ntype: Project\ntitle: Stale thing\ntags: [coding]\nstale_after: 2020-01-01\n---\nOld news.\n',
  );
}

describe('selection', () => {
  it('always includes stable human-verified preferences, skips deprecated and stale', () => {
    seedSelection();
    const picked = selectPages({ category: 'coding' });
    const titles = picked.map((p) => p.title);
    expect(titles[0]).toBe('Short answers');
    expect(titles).toContain('Deploy dance');
    expect(titles).toContain('Router work');
    expect(titles).not.toContain('Old thing');
    expect(titles).not.toContain('Stale thing');
  });

  it('ranks matches by trust tier, then recency', () => {
    seedSelection();
    confirmPage('playbooks/deploy-dance.md', 'JP');
    const picked = selectPages({ category: 'coding' });
    const titles = picked.map((p) => p.title);
    // Deploy dance is older but human-verified, so it outranks Router work.
    expect(titles.indexOf('Deploy dance')).toBeLessThan(titles.indexOf('Router work'));
  });

  it('memoryBrief leads with the index, embeds pages verbatim and holds the budget', () => {
    seedSelection();
    const brief = memoryBrief({ category: 'coding' }, 100_000);
    expect(brief.startsWith('---\nokf_version: "0.2"')).toBe(true);
    expect(brief).toContain('--- preferences/short-answers.md ---');
    expect(brief).toContain('Keep every answer short. No filler.');
    expect(brief).not.toContain('Old thing');

    const tight = memoryBrief({ category: 'coding' }, 900);
    expect(Buffer.byteLength(tight)).toBeLessThanOrEqual(900);
    const empty = memoryBrief({ category: 'coding' }, 10);
    expect(Buffer.byteLength(empty)).toBeLessThanOrEqual(10);
  });

  it('is empty when there is no bundle at all', () => {
    expect(memoryBrief({ category: 'coding' })).toBe('');
  });
});

// --- distiller ---------------------------------------------------------------

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
    chat: [FLASH],
    'long-context': [],
  },
  difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
};

function fakeCheap(answer: string): Adapter {
  return {
    id: 'kimi',
    displayName: 'kimi',
    binary: 'kimi',
    subscriptionName: 'kimi plan',
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ loggedIn: true, loginHint: 'kimi' }),
    async *run() {
      yield { type: 'result', ok: true, text: answer };
    },
  };
}

describe('distillEpisode', () => {
  it('writes candidates as drafts and dedupes into an existing page', async () => {
    const state = newTaskState('write me a report');
    const answer = JSON.stringify({
      pages: [
        {
          kind: 'preference',
          title: 'Short answers',
          description: 'Short and plain, always.',
          body: 'Keep it short.',
          tags: ['writing'],
        },
        {
          kind: 'person',
          title: 'Kari Nordmann',
          description: 'The accountant the user works with.',
          body: 'Kari handles the accounts.',
          tags: [],
        },
      ],
    });
    await distillEpisode(state, {
      available: new Set(['kimi']),
      table: TABLE,
      adapters: [fakeCheap(answer)],
      machine: 'test-mac',
    });
    const pages = listPages();
    expect(pages.map((p) => p.path).sort()).toEqual([
      'people/kari-nordmann.md',
      'preferences/short-answers.md',
    ]);
    expect(pages.every((p) => p.status === 'draft')).toBe(true);
    expect(pages.every((p) => p.machine === 'test-mac')).toBe(true);

    // The same candidate again updates, never a sibling.
    await distillEpisode(state, {
      available: new Set(['kimi']),
      table: TABLE,
      adapters: [fakeCheap(answer)],
    });
    expect(listPages()).toHaveLength(2);
  });

  it('drops a candidate with a planted credential and logs the drop', async () => {
    const answer = JSON.stringify({
      pages: [
        {
          kind: 'service',
          title: 'Mail service',
          description: 'How mail goes out.',
          body: `Connect with api_key = "FAKEFAKEFAKEFAKEFAKE1234"`,
          tags: [],
        },
      ],
    });
    await distillEpisode(newTaskState('set up mail'), {
      available: new Set(['kimi']),
      table: TABLE,
      adapters: [fakeCheap(answer)],
    });
    expect(listPages()).toHaveLength(0);
    const log = readFileSync(join(memoryDir(), 'log.md'), 'utf8');
    expect(log).toContain('**Drop**');
    expect(log).toContain('credential assignment');
  });

  it('does nothing, silently, when no model is available', async () => {
    await distillEpisode(newTaskState('anything'), {
      available: new Set(),
      table: TABLE,
      adapters: [],
    });
    expect(listPages()).toHaveLength(0);
  });
});

// --- proposals from peers ----------------------------------------------------

const PROPOSAL = [
  '---',
  'type: Preference',
  'title: Short answers',
  'description: From the laptop.',
  'tags: [writing]',
  'generated: { by: aiax-router/0.1.0, at: 2026-08-04T12:00:00Z }',
  'status: draft',
  'machine: laptop',
  '---',
  '',
  'Answers should be short.',
  '',
].join('\n');

describe('acceptProposals', () => {
  it('merges a new proposal as a draft and keeps the peer provenance', () => {
    const got = acceptProposals('laptop', [PROPOSAL]);
    expect(got).toEqual({ accepted: 1, corrections: 0, dropped: 0 });
    const p = listPages()[0];
    expect(p.status).toBe('draft');
    expect(p.machine).toBe('laptop');
    expect(p.generatedAt).toBe('2026-08-04T12:00:00Z');
    expect(p.verified).toEqual([]);
  });

  it('never overwrites a human-verified stable page: it files a draft Correction', () => {
    savePage(page({ body: 'Keep every answer short. No filler.' }));
    confirmPage('preferences/short-answers.md', 'JP');
    const before = readFileSync(join(memoryDir(), 'preferences/short-answers.md'), 'utf8');

    const got = acceptProposals('laptop', [PROPOSAL]);
    expect(got).toEqual({ accepted: 0, corrections: 1, dropped: 0 });
    // The confirmed page is untouched.
    expect(readFileSync(join(memoryDir(), 'preferences/short-answers.md'), 'utf8')).toBe(before);
    const correction = listPages().find((p) => p.type === 'Correction');
    expect(correction?.status).toBe('draft');
    expect(correction?.machine).toBe('laptop');
    expect(correction?.body).toContain('/preferences/short-answers.md');
  });

  it('drops a proposal that carries a secret, before anything lands', () => {
    const dirty = PROPOSAL.replace('Answers should be short.', `token = "FAKEFAKEFAKEFAKE12345"`);
    const got = acceptProposals('laptop', [dirty]);
    expect(got).toEqual({ accepted: 0, corrections: 0, dropped: 1 });
    expect(listPages()).toHaveLength(0);
  });
});

// --- manifest and the served paths -------------------------------------------

describe('manifest and endpoint paths', () => {
  it('manifest carries okf_version and per-page path, type, status and hash', () => {
    savePage(page());
    const got = memoryManifest();
    expect(got.okf_version).toBe('0.2');
    expect(got.pages).toHaveLength(1);
    expect(got.pages[0]).toMatchObject({
      path: 'preferences/short-answers.md',
      type: 'Preference',
      title: 'Short answers',
      status: 'draft',
      tier: 'unverified',
      stale: false,
    });
    expect(got.pages[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the page path guard refuses every traversal shape', () => {
    savePage(page());
    expect(memoryFilePath('preferences/short-answers.md')).toContain('short-answers.md');
    expect(memoryFilePath('../../etc/hosts')).toBeNull();
    expect(memoryFilePath('..%2f..%2fetc/hosts')).toBeNull();
    expect(memoryFilePath('%2e%2e/%2e%2e/etc/hosts')).toBeNull();
    expect(memoryFilePath('preferences/../../outside.md')).toBeNull();
    expect(memoryFilePath('log.txt')).toBeNull();
  });
});
