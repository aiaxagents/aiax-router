import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countCandidates, isRoutingTable } from './routing-table.js';
import { configPath, readJson, writeJson } from './store.js';
import type { Candidate, Category, RoutingTable } from './types.js';

export const DEFAULT_TABLE_URL =
  'https://raw.githubusercontent.com/aiaxagents/aiax-router/main/routing-table.json';

/** Documented quickstart endpoint; the older /api/v2/data/llms/models path still answers too. */
export const AA_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models';

const CATEGORIES: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];

/** Hand-curated aliases sit at the repo root; this module runs from dist/core/. */
const ALIASES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'model-aliases.json');

export interface Alias {
  provider: string;
  model: string;
}

export function loadAliases(file = ALIASES): Record<string, Alias> {
  const parsed = readJson<{ aliases?: Record<string, Alias> }>(file, {});
  return parsed.aliases ?? {};
}

// --- fetching ----------------------------------------------------------------

function isUrl(from: string): boolean {
  return /^https?:\/\//i.test(from);
}

/** HTTP/2 responses carry no status text, so the number has to stand on its own. */
function httpError(res: Response): string {
  return `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
}

/**
 * Reads a routing table from an http(s) URL or a local file. Throws with one plain
 * sentence, because the caller prints it straight to the user.
 */
export async function fetchTable(from: string): Promise<RoutingTable> {
  let text: string;
  if (isUrl(from)) {
    let res: Response;
    try {
      res = await fetch(from, { signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error(`Could not reach ${from}, so the routing table was left alone.`);
    }
    if (!res.ok) {
      throw new Error(`Could not download the routing table from ${from}: ${httpError(res)}.`);
    }
    text = await res.text();
  } else {
    try {
      text = readFileSync(resolve(from), 'utf8');
    } catch {
      throw new Error(`Could not read ${from}, so the routing table was left alone.`);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`What came back from ${from} is not JSON, so nothing was written.`);
  }
  if (!isRoutingTable(parsed)) {
    throw new Error(`What came back from ${from} is not a valid routing table, so nothing was written.`);
  }
  return parsed;
}

// --- Artificial Analysis enrichment ------------------------------------------

export interface AaModel {
  name?: string;
  slug?: string;
  [k: string]: unknown;
}

export interface AaResponse {
  data?: AaModel[];
}

/** Free-tier rows carry no token counts, so an absent number is normal, not an error. */
export function aaTokens(model: AaModel): number | undefined {
  const counts = model.artificial_analysis_intelligence_index_token_counts as
    | Record<string, unknown>
    | undefined;
  if (!counts) return undefined;
  const output = Number(counts.output_tokens);
  if (Number.isFinite(output) && output > 0) return output;
  const answer = Number(counts.answer_tokens);
  const reasoning = Number(counts.reasoning_tokens);
  const sum = (Number.isFinite(answer) ? answer : 0) + (Number.isFinite(reasoning) ? reasoning : 0);
  return sum > 0 ? sum : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function key(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/**
 * Rescales tokensPerTask from Artificial Analysis token counts, in place. AA's free tier
 * forbids redistribution, so these numbers stay on this machine: they are written only to
 * the user's local override table and are never sent anywhere or committed to the repo.
 *
 * Returns how many table candidates were touched. Unmapped candidates keep the hand-curated
 * value from the repository, because a missing measurement is not a measurement of 1.
 */
export function enrichWithAa(
  table: RoutingTable,
  aa: AaResponse,
  aliases: Record<string, Alias>,
): number {
  // Several AA rows can resolve to one CLI model (a reasoning tier and its base); average them.
  const perModel = new Map<string, number[]>();
  for (const model of aa.data ?? []) {
    const tokens = aaTokens(model);
    if (tokens === undefined) continue;
    const alias =
      (model.slug ? aliases[model.slug] : undefined) ??
      (model.name ? aliases[model.name] : undefined);
    if (!alias) continue;
    const k = key(alias.provider, alias.model);
    const bucket = perModel.get(k);
    if (bucket) bucket.push(tokens);
    else perModel.set(k, [tokens]);
  }
  if (perModel.size === 0) return 0;

  const averaged = new Map<string, number>();
  for (const [k, list] of perModel) {
    averaged.set(k, list.reduce((a, b) => a + b, 0) / list.length);
  }
  // tokensPerTask is relative, 1 = baseline, so the median measured model defines the baseline.
  const baseline = median([...averaged.values()]);
  if (!(baseline > 0)) return 0;

  let touched = 0;
  for (const category of CATEGORIES) {
    for (const candidate of table.categories[category] ?? ([] as Candidate[])) {
      const tokens = averaged.get(key(candidate.provider, candidate.model));
      if (tokens === undefined) continue;
      // Clamped: one odd AA row must not push a model out of contention or make it free.
      const ratio = Math.min(5, Math.max(0.25, tokens / baseline));
      candidate.tokensPerTask = Math.round(ratio * 100) / 100;
      touched++;
    }
  }
  return touched;
}

export function readAaKey(): string | undefined {
  const config = readJson<{ aaApiKey?: unknown }>(configPath('config.json'), {});
  return typeof config.aaApiKey === 'string' && config.aaApiKey.trim() !== ''
    ? config.aaApiKey.trim()
    : undefined;
}

export async function fetchAa(apiKey: string, url = AA_MODELS_URL): Promise<AaResponse> {
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(httpError(res));
  return (await res.json()) as AaResponse;
}

// --- command -----------------------------------------------------------------

export interface UpdateArgs {
  from: string;
}

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const at = argv.indexOf('--from');
  const value = at >= 0 ? argv[at + 1] : undefined;
  return { from: value && !value.startsWith('--') ? value : DEFAULT_TABLE_URL };
}

export async function update(argv: string[]): Promise<number> {
  const { from } = parseUpdateArgs(argv);

  let table: RoutingTable;
  try {
    table = await fetchTable(from);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const apiKey = readAaKey();
  let enriched = 0;
  let aaFailed = '';
  if (apiKey) {
    try {
      enriched = enrichWithAa(table, await fetchAa(apiKey), loadAliases());
    } catch (err) {
      aaFailed = err instanceof Error ? err.message : String(err);
    }
  }

  const out = configPath('routing-table.json');
  writeJson(out, table);
  console.log(
    `Saved the routing table generated at ${table.generatedAt} with ${countCandidates(table)} candidates.`,
  );
  if (!apiKey) {
    console.log('Add an Artificial Analysis key in config to sharpen token estimates.');
  } else if (aaFailed) {
    console.log(`Artificial Analysis did not answer (${aaFailed}), so token estimates are unchanged.`);
  } else if (enriched === 0) {
    console.log('Artificial Analysis had no token counts we could map, so estimates are unchanged.');
  } else {
    console.log(
      `Sharpened token estimates for ${enriched} ${enriched === 1 ? 'model' : 'models'} using your Artificial Analysis key.`,
    );
  }
  return 0;
}
