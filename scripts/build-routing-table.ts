/**
 * Rebuilds routing-table.json from public benchmark leaderboards.
 *
 * Run: node dist-scripts/build-routing-table.js [--dry-run] [--out <path>]
 *
 * Zero runtime dependencies: global fetch plus node: builtins only. Every source is
 * fetched behind try/skip, because a leaderboard that changes shape must not be able
 * to stop the weekly refresh. Exit 1 only when no source at all could be fetched.
 *
 * stdout is the summary (the workflow uses it verbatim as the PR body).
 * stderr is the log. Keep it that way.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ponytail: these mirror src/core/types.ts by hand instead of importing it. tsconfig.scripts.json
// has rootDir "scripts" so the compiled entry stays at dist-scripts/build-routing-table.js, and a
// cross-rootDir import (even type-only) is a hard tsc error. validate() below is the runtime guard
// against drift, and src/core/routing-table.ts rejects a bad table at load. If more of the router's
// types are ever needed here, move the shared types into a directory both tsconfigs can root on.
export type Category =
  | 'coding'
  | 'agentic-coding'
  | 'reasoning'
  | 'writing'
  | 'chat'
  | 'long-context';
export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

export interface Candidate {
  provider: string;
  model: string;
  score: number;
  costWeight: number;
  tokensPerTask: number;
  maxEffort?: Effort;
}

export interface RoutingTable {
  schemaVersion: number;
  generatedAt: string;
  sources: { name: string; [k: string]: unknown }[];
  categories: Record<Category, Candidate[]>;
  difficultyFloor: Record<Difficulty, number>;
}

const CATEGORIES: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];

/** A benchmark score before normalization, on whatever scale its source uses. */
export interface Observation {
  source: string;
  category: Category;
  /** The leaderboard's own model name, mapped through model-aliases.json later. */
  name: string;
  value: number;
}

export interface SourceEntry {
  name: string;
  [k: string]: unknown;
}

export interface FetchedSource {
  entry: SourceEntry;
  observations: Observation[];
}

export type Alias = { provider: string; model: string };

/** Candidates gain a curation flag when the pipeline invents them. */
type BuiltCandidate = Candidate & { needsCuration?: boolean };

export interface UnmappedModel {
  name: string;
  categories: Category[];
  /** Best normalized score, used to rank the checklist so humans see top models first. */
  best: number;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

export interface AiderEntry {
  model: string;
  passRate2: number;
  date: string;
}

/**
 * Minimal parser for aider's polyglot leaderboard: a flat list of `key: value`
 * blocks, no nesting, no anchors. A real YAML dependency would be the only runtime
 * dependency in the project, for one file whose shape has not changed in two years.
 */
export function parseAiderYaml(text: string): AiderEntry[] {
  const out: AiderEntry[] = [];
  for (const block of text.split(/^- /m).slice(1)) {
    const fields: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) fields[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    const pass = Number(fields.pass_rate_2);
    if (fields.model && fields.pass_rate_2 !== undefined && Number.isFinite(pass)) {
      out.push({ model: fields.model, passRate2: pass, date: fields.date ?? '' });
    }
  }
  return out;
}

/** Quote-aware CSV -> row objects. Header row required. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

/**
 * Rank-percentile each (source, category) group to 0-100, then average across sources
 * per (model name, category). This is what lets an Elo rating and a percent-solved rate
 * sit in the same column.
 *
 * Rank rather than min-max, because `score` feeds the difficultyFloor gates and so means
 * adequacy, not distance to rank 1. Min-max over a truncated leaderboard window buries a
 * near-frontier model whenever the top of the window is dense: the whole LMArena top 100
 * spans ~150 Elo, so rank 30 would score under 40 and get benched for anything above
 * trivial work. Ties share the mean of their ranks, so a fully tied group lands on 50.
 */
export function normalize(observations: Observation[]): Map<Category, Map<string, number>> {
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const key = `${o.source}\u0000${o.category}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(o);
    else groups.set(key, [o]);
  }

  const scaled = new Map<Category, Map<string, number[]>>();
  for (const group of groups.values()) {
    // A source that lists the same model twice in a category (aider re-runs one model
    // across releases) must not get double weight; keep its best run.
    const best = new Map<string, number>();
    for (const o of group) {
      const prev = best.get(o.name);
      if (prev === undefined || o.value > prev) best.set(o.name, o.value);
    }
    const category = group[0].category;
    let perName = scaled.get(category);
    if (!perName) {
      perName = new Map<string, number[]>();
      scaled.set(category, perName);
    }
    // Rank by the source's own metric, best first.
    const ranked = [...best].sort((a, b) => b[1] - a[1]);
    const n = ranked.length;
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && ranked[j + 1][1] === ranked[i][1]) j++;
      const meanRank = (i + 1 + (j + 1)) / 2;
      // A window of one says nothing about relative quality, so it stays neutral rather
      // than claiming the top of the category.
      const score = n === 1 ? 50 : (1 - (meanRank - 1) / (n - 1)) * 100;
      for (let k = i; k <= j; k++) {
        const name = ranked[k][0];
        const list = perName.get(name);
        if (list) list.push(score);
        else perName.set(name, [score]);
      }
      i = j + 1;
    }
  }

  const averaged = new Map<Category, Map<string, number>>();
  for (const [category, perName] of scaled) {
    const out = new Map<string, number>();
    for (const [name, list] of perName) {
      out.set(name, list.reduce((a, b) => a + b, 0) / list.length);
    }
    averaged.set(category, out);
  }
  return averaged;
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

export interface MergeResult {
  table: RoutingTable;
  unmapped: UnmappedModel[];
}

/**
 * Benchmarks own `score`. costWeight, tokensPerTask and maxEffort are curated by hand
 * and are carried forward untouched; so are hand-seeded scores in categories no source
 * covered this week. A model no source covers keeps its previous score rather than
 * dropping out of the table.
 */
export function merge(
  prev: RoutingTable,
  scores: Map<Category, Map<string, number>>,
  aliases: Record<string, Alias>,
  opts: { generatedAt: string; sources: SourceEntry[] },
): MergeResult {
  const unmapped = new Map<string, { categories: Set<Category>; best: number }>();
  const categories = {} as Record<Category, Candidate[]>;

  for (const category of CATEGORIES) {
    const byKey = new Map<string, BuiltCandidate>();
    for (const c of prev.categories?.[category] ?? []) {
      byKey.set(`${c.provider}\u0000${c.model}`, { ...c });
    }

    // Several leaderboard names can resolve to one CLI model (gpt-5.6-sol-high and
    // gpt-5.6-sol-xhigh are both `codex gpt-5.6-sol`); average them instead of
    // letting the last one win.
    const fresh = new Map<string, { alias: Alias; scores: number[] }>();
    for (const [name, score] of scores.get(category) ?? []) {
      const alias = aliases[name];
      if (!alias) {
        const seen = unmapped.get(name);
        if (seen) {
          seen.categories.add(category);
          seen.best = Math.max(seen.best, score);
        } else {
          unmapped.set(name, { categories: new Set([category]), best: score });
        }
        continue;
      }
      const key = `${alias.provider}\u0000${alias.model}`;
      const bucket = fresh.get(key);
      if (bucket) bucket.scores.push(score);
      else fresh.set(key, { alias, scores: [score] });
    }

    for (const [key, { alias, scores: list }] of fresh) {
      const score = Math.round(list.reduce((a, b) => a + b, 0) / list.length);
      const existing = byKey.get(key);
      if (existing) existing.score = score;
      else {
        byKey.set(key, {
          provider: alias.provider,
          model: alias.model,
          score,
          costWeight: 3,
          tokensPerTask: 1.0,
          needsCuration: true,
        });
      }
    }

    categories[category] = [...byKey.values()].sort((a, b) => b.score - a.score);
  }

  const table: RoutingTable = {
    schemaVersion: prev.schemaVersion ?? 1,
    generatedAt: opts.generatedAt,
    sources: [...opts.sources, ...(prev.sources ?? []).filter((s) => s.name === 'hand-seeded-v0')],
    difficultyFloor: prev.difficultyFloor,
    categories,
  };

  return {
    table,
    unmapped: [...unmapped]
      .map(([name, v]) => ({ name, categories: [...v.categories], best: v.best }))
      .sort((a, b) => b.best - a.best),
  };
}

/** Throws rather than writing a table the router would reject at load time. */
export function validate(table: RoutingTable): void {
  if (table.schemaVersion !== 1) throw new Error(`schemaVersion must be 1`);
  for (const d of ['trivial', 'easy', 'medium', 'hard'] as const) {
    if (typeof table.difficultyFloor?.[d] !== 'number') {
      throw new Error(`difficultyFloor.${d} is missing`);
    }
  }
  for (const category of CATEGORIES) {
    const list = table.categories[category];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`category ${category} is missing or empty`);
    }
    for (const c of list) {
      const ok =
        typeof c.provider === 'string' &&
        c.provider !== '' &&
        typeof c.model === 'string' &&
        c.model !== '' &&
        Number.isFinite(c.score) &&
        Number.isFinite(c.costWeight) &&
        Number.isFinite(c.tokensPerTask);
      if (!ok) throw new Error(`invalid candidate in ${category}: ${JSON.stringify(c)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

/**
 * HF's datasets-server returns an intermittent 500 on the filter endpoint while it warms
 * a query, so a single attempt gives the weekly job random category coverage. Two retries
 * with a short backoff is the whole fix.
 */
async function get(url: string, attempts = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2000 * i));
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(60_000),
        headers: { 'user-agent': 'aiax-router-routing-table-bot' },
      });
      if (res.ok) return res;
      last = new Error(`${res.status} ${res.statusText} for ${url}`);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

const AIDER_URL =
  'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml';

export async function fetchAider(): Promise<FetchedSource> {
  const entries = parseAiderYaml(await (await get(AIDER_URL)).text());
  if (entries.length === 0) throw new Error('parsed 0 entries');
  const latest = entries.map((e) => e.date).sort().at(-1) ?? '';
  return {
    entry: { name: 'aider-polyglot', url: AIDER_URL, latestEntryDate: latest, models: entries.length },
    observations: entries.map((e) => ({
      source: 'aider-polyglot',
      category: 'coding' as Category,
      name: e.model,
      value: e.passRate2,
    })),
  };
}

const LMARENA_DATASET = 'lmarena-ai/leaderboard-dataset';
/** LMArena's own category ids -> ours. Verified against the datasets-server splits API. */
const LMARENA_CATEGORIES: Record<string, Category> = {
  overall: 'chat',
  coding: 'coding',
  longer_query: 'long-context',
  creative_writing: 'writing',
};

export async function fetchLmArena(): Promise<FetchedSource> {
  const observations: Observation[] = [];
  const covered: string[] = [];
  let publishDate = '';
  for (const [lmCategory, category] of Object.entries(LMARENA_CATEGORIES)) {
    try {
      const url = new URL('https://datasets-server.huggingface.co/filter');
      url.searchParams.set('dataset', LMARENA_DATASET);
      url.searchParams.set('config', 'text');
      url.searchParams.set('split', 'latest');
      // No orderby: the split is already stored in rank order per category, and the
      // datasets-server 500s on orderby for some categories.
      url.searchParams.set('where', `"category"='${lmCategory}'`);
      url.searchParams.set('offset', '0');
      url.searchParams.set('length', '100');
      const body = (await (await get(url.toString())).json()) as {
        rows?: { row?: Record<string, unknown> }[];
      };
      let added = 0;
      for (const { row } of body.rows ?? []) {
        const name = row?.model_name;
        const rating = row?.rating;
        if (typeof name !== 'string' || typeof rating !== 'number') continue;
        observations.push({ source: 'lmarena', category, name, value: rating });
        added++;
        if (typeof row?.leaderboard_publish_date === 'string') {
          publishDate = row.leaderboard_publish_date;
        }
      }
      if (added > 0) covered.push(`${lmCategory}->${category}`);
    } catch (err) {
      console.error(`lmarena: skipping category ${lmCategory}: ${message(err)}`);
    }
  }
  if (observations.length === 0) throw new Error('no category returned rows');
  return {
    entry: {
      name: 'lmarena',
      url: `https://huggingface.co/datasets/${LMARENA_DATASET}`,
      publishDate,
      categories: covered,
    },
    observations,
  };
}

/** LiveBench category names -> ours. Mathematics/Data Analysis/Language have no target. */
const LIVEBENCH_CATEGORIES: Record<string, Category> = {
  Coding: 'coding',
  'Agentic Coding': 'agentic-coding',
  Reasoning: 'reasoning',
  IF: 'writing',
};

/**
 * livebench.ai is a static SPA that fetches `table_<release>.csv`. The release list is
 * only in its JS bundle, so read it from there rather than hardcoding a date that goes
 * stale between two runs of a weekly job.
 */
export async function fetchLiveBench(): Promise<FetchedSource> {
  const index = await (await get('https://livebench.ai/')).text();
  const bundlePath = /static\/js\/main\.[A-Za-z0-9]+\.js/.exec(index)?.[0];
  if (!bundlePath) throw new Error('no fetchable source found (bundle path missing)');
  const bundle = await (await get(`https://livebench.ai/${bundlePath}`)).text();
  const release = /\[(?:"\d{4}-\d{2}-\d{2}",\s*){3,}"(\d{4}-\d{2}-\d{2})"\]/.exec(bundle)?.[1];
  if (!release) throw new Error('no fetchable source found (release list missing)');

  const slug = release.replaceAll('-', '_');
  const groups = (await (
    await get(`https://livebench.ai/categories_${slug}.json`)
  ).json()) as Record<string, string[]>;
  const rows = parseCsv(await (await get(`https://livebench.ai/table_${slug}.csv`)).text());
  if (rows.length === 0) throw new Error('table csv had no rows');

  const observations: Observation[] = [];
  for (const row of rows) {
    const name = row.model;
    if (!name) continue;
    for (const [group, category] of Object.entries(LIVEBENCH_CATEGORIES)) {
      const tasks = groups[group] ?? [];
      const values = tasks.map((t) => Number(row[t])).filter((v) => Number.isFinite(v));
      if (values.length === 0) continue;
      observations.push({
        source: 'livebench',
        category,
        name,
        value: values.reduce((a, b) => a + b, 0) / values.length,
      });
    }
  }
  if (observations.length === 0) throw new Error('no scores in the table csv');
  return {
    entry: {
      name: 'livebench',
      url: `https://livebench.ai/table_${slug}.csv`,
      release,
      models: rows.length,
    },
    observations,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarize(
  table: RoutingTable,
  unmapped: UnmappedModel[],
  observations: Observation[],
  ok: SourceEntry[],
  failed: { name: string; reason: string }[],
): string {
  const lines: string[] = [];
  lines.push('## Weekly routing table update', '');
  lines.push(`Generated at: \`${table.generatedAt}\``, '');

  lines.push('### Sources', '');
  for (const s of ok) {
    const detail = Object.entries(s)
      .filter(([k]) => k !== 'name')
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      .join(' | ');
    lines.push(`- ok \`${s.name}\`${detail ? ` - ${detail}` : ''}`);
  }
  for (const f of failed) lines.push(`- SKIPPED \`${f.name}\` - ${f.reason}`);
  lines.push('');

  lines.push('### Candidates per category', '');
  lines.push('| category | candidates | new (needs curation) | sources this run |');
  lines.push('| --- | --- | --- | --- |');
  for (const category of CATEGORIES) {
    const list = (table.categories[category] ?? []) as BuiltCandidate[];
    const fresh = list.filter((c) => c.needsCuration).length;
    const contributors = [
      ...new Set(observations.filter((o) => o.category === category).map((o) => o.source)),
    ].sort();
    lines.push(
      `| ${category} | ${list.length} | ${fresh} | ${contributors.join(', ') || 'none (hand-seeded carried forward)'} |`,
    );
  }
  lines.push('');

  lines.push('### Unmapped leaderboard models', '');
  if (unmapped.length === 0) {
    lines.push('None: every scored model resolved through `model-aliases.json`.');
  } else {
    lines.push(
      `${unmapped.length} leaderboard names have no entry in \`model-aliases.json\` and were excluded.`,
      'Top 25 by normalized score - add a mapping only where the CLI model id is certain:',
      '',
    );
    for (const u of unmapped.slice(0, 25)) {
      lines.push(`- [ ] \`${u.name}\` (${u.categories.join(', ')}, best ${u.best.toFixed(1)})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const outFlag = argv.indexOf('--out');
  const out = outFlag >= 0 && argv[outFlag + 1] ? resolve(argv[outFlag + 1]) : join(ROOT, 'routing-table.json');

  const prev = JSON.parse(readFileSync(join(ROOT, 'routing-table.json'), 'utf8')) as RoutingTable;
  const aliases = (
    JSON.parse(readFileSync(join(ROOT, 'model-aliases.json'), 'utf8')) as {
      aliases: Record<string, Alias>;
    }
  ).aliases;

  const ok: SourceEntry[] = [];
  const failed: { name: string; reason: string }[] = [];
  const observations: Observation[] = [];
  for (const [name, fn] of [
    ['aider-polyglot', fetchAider],
    ['lmarena', fetchLmArena],
    ['livebench', fetchLiveBench],
  ] as const) {
    try {
      const result = await fn();
      ok.push(result.entry);
      observations.push(...result.observations);
      console.error(`${name}: ok, ${result.observations.length} observations`);
    } catch (err) {
      failed.push({ name, reason: message(err) });
      console.error(`${name}: ${message(err)}`);
    }
  }

  if (ok.length === 0) {
    console.error('every source failed; refusing to rewrite the routing table');
    return 1;
  }

  const { table, unmapped } = merge(prev, normalize(observations), aliases, {
    // Some runners have no wall clock worth trusting; the workflow passes one in.
    generatedAt: process.env.GENERATED_AT ?? prev.generatedAt ?? 'unset',
    sources: ok,
  });
  validate(table);

  if (!dryRun) {
    writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`);
    console.error(`wrote ${out}`);
  }
  console.log(summarize(table, unmapped, observations, ok, failed));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(message(err));
      process.exitCode = 1;
    },
  );
}
