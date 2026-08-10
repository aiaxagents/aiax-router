import { join } from 'node:path';
import { appRoot } from './paths.js';
import { configPath, readJson, writeJson } from './store.js';

/**
 * List prices for the models the router can pick, in USD per 1M tokens.
 *
 * Source of truth is OpenRouter's public model list, fetched without any key
 * and cached in the config dir; the checked-in model-prices.json is the
 * fallback for offline machines and for models OpenRouter does not carry.
 * Everything here is an estimate of API list price: the actual runs are
 * covered by the person's subscriptions.
 */

export interface Price {
  input: number;
  output: number;
}

/** Our provider ids against the org prefix OpenRouter files them under. */
const ORG: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'x-ai',
  kimi: 'moonshotai',
  gemini: 'google',
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Cache {
  fetchedAt?: string;
  prices?: Record<string, Price>;
}

function cachePath(): string {
  return configPath('prices-cache.json');
}

interface StaticBook {
  providers?: Record<
    string,
    {
      default?: Partial<Price>;
      models?: Record<string, Partial<Price>>;
    }
  >;
}

export function getPrice(provider: string, model: string): Price | null {
  const cached = readJson<Cache>(cachePath(), {}).prices?.[`${provider} ${model}`];
  if (cached) return cached;
  const book = readJson<StaticBook>(join(appRoot(), 'model-prices.json'), {});
  const entry = book.providers?.[provider];
  const price = entry?.models?.[model] ?? entry?.default;
  if (typeof price?.input !== 'number' || typeof price?.output !== 'number') return null;
  return { input: price.input, output: price.output };
}

/** The models worth pricing: whatever the routing table can route to. */
function knownPairs(): { provider: string; model: string }[] {
  const table = readJson<{ categories?: Record<string, { provider: string; model: string }[]> }>(
    join(appRoot(), 'routing-table.json'),
    {},
  );
  const seen = new Set<string>();
  const out: { provider: string; model: string }[] = [];
  for (const list of Object.values(table.categories ?? {})) {
    for (const c of list ?? []) {
      const key = `${c.provider} ${c.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider: c.provider, model: c.model });
    }
  }
  return out;
}

/**
 * Refreshes the cache from OpenRouter when it is stale. Never throws and never
 * blocks a task: pricing is decoration, not work.
 */
export async function refreshPrices(): Promise<void> {
  const cache = readJson<Cache>(cachePath(), {});
  const age = Date.now() - Date.parse(cache.fetchedAt ?? '');
  if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) return;

  let models: { id: string; created?: number; pricing?: { prompt?: string; completion?: string } }[];
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return;
    models = (await res.json())?.data ?? [];
  } catch {
    return;
  }

  const prices: Record<string, Price> = {};
  for (const { provider, model } of knownPairs()) {
    const org = ORG[provider];
    if (!org) continue;
    // Newest match wins: "opus" alone must land on the current opus. But a
    // priced-up or priced-down variant (gpt-5.5-pro, *-mini) is a different
    // product, so skip those unless the model name itself asks for one.
    const wantsVariant = /-(pro|mini|nano|lite|air|preview|exp)\b/.test(model.toLowerCase());
    const pool = models.filter(
      (m) => m.id.startsWith(`${org}/`) && m.id.toLowerCase().includes(model.toLowerCase()),
    );
    const clean = wantsVariant
      ? pool
      : pool.filter((m) => !/-(pro|mini|nano|lite|air|preview|exp)\b/.test(m.id.toLowerCase()));
    const match = (clean.length ? clean : pool).sort(
      (a, b) => (b.created ?? 0) - (a.created ?? 0),
    )[0];
    const input = Number(match?.pricing?.prompt);
    const output = Number(match?.pricing?.completion);
    if (!match || !Number.isFinite(input) || !Number.isFinite(output)) continue;
    // OpenRouter prices are USD per token; ours are per 1M.
    prices[`${provider} ${model}`] = {
      input: Math.round(input * 1e6 * 100) / 100,
      output: Math.round(output * 1e6 * 100) / 100,
    };
  }

  if (Object.keys(prices).length === 0) return;
  writeJson(cachePath(), { fetchedAt: new Date().toISOString(), prices });
}
