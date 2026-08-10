import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, configPath, readJson, readJsonl, writeJson } from './store.js';
import type { Effort } from './types.js';

export interface UsageRecord {
  ts: string;
  provider: string;
  model: string;
  effort: Effort;
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export interface HealthEntry {
  state: 'ok' | 'dead';
  reason: string;
  /** Epoch ms after which the provider is tried again. */
  until: number;
}

export interface RouterConfig {
  comment: string;
  /** Runs per week a provider may take before headroom hits zero. */
  budgets: Record<string, number>;
}

const DEFAULT_CONFIG: RouterConfig = {
  comment:
    'budgets are runs per week per provider - rough defaults, not published limits; edit them to match what your plan actually takes',
  budgets: { claude: 300, codex: 300, grok: 200, kimi: 200 },
};

const HOUR = 60 * 60 * 1000;
export const DEAD_COOLDOWN_MS = 6 * HOUR;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// --- usage log ---------------------------------------------------------------

export function recordRun(rec: UsageRecord): void {
  appendJsonl(configPath('usage.jsonl'), rec);
}

export function readUsage(): UsageRecord[] {
  return readJsonl<UsageRecord>(configPath('usage.jsonl'));
}

/** Monday 00:00 local time. */
function startOfWeek(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export function runsThisWeek(provider?: string): number {
  const since = startOfWeek();
  return readUsage().filter(
    (r) => (!provider || r.provider === provider) && Date.parse(r.ts) >= since,
  ).length;
}

// --- config ------------------------------------------------------------------

export function readConfig(): RouterConfig {
  const path = configPath('config.json');
  const found = readJson<(Partial<RouterConfig> & Record<string, unknown>) | null>(path, null);
  // Merge, never replace: config.json holds keys owned by other commands
  // (aaApiKey for one), and seeding defaults must not destroy them.
  const merged = {
    ...found,
    comment: found?.comment ?? DEFAULT_CONFIG.comment,
    budgets: { ...DEFAULT_CONFIG.budgets, ...found?.budgets },
  };
  if (!found?.budgets) writeJson(path, merged);
  return merged;
}

// --- headroom ----------------------------------------------------------------

const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');

let codexCache: { at: number; value: number | null } | null = null;

function listDesc(dir: string): string[] {
  try {
    return readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
}

/** ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl - newest day directories first. */
function newestSessionFiles(limit: number): string[] {
  const dirs: string[] = [];
  outer: for (const y of listDesc(CODEX_SESSIONS)) {
    for (const m of listDesc(join(CODEX_SESSIONS, y))) {
      for (const d of listDesc(join(CODEX_SESSIONS, y, m))) {
        dirs.push(join(CODEX_SESSIONS, y, m, d));
        if (dirs.length >= 3) break outer;
      }
    }
  }

  const files: { path: string; mtime: number }[] = [];
  for (const dir of dirs) {
    for (const name of listDesc(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      try {
        files.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        // vanished between listing and stat
      }
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => f.path);
}

/**
 * Codex logs its own quota into the session transcript:
 * {"type":"event_msg","payload":{"type":"token_count","rate_limits":{
 *   "primary":{"used_percent":22,"window_minutes":10080,"resets_at":<unix s>},
 *   "secondary":null,...}}}
 * Windows whose resets_at has passed have already rolled over, so they are skipped.
 */
function snapshotFrom(file: string): number | null {
  let lines: string[];
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('rate_limits')) continue;
    let obj: any;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const limits = obj?.payload?.rate_limits ?? obj?.rate_limits;
    if (!limits) continue;

    let used = -1;
    for (const w of [limits.primary, limits.secondary]) {
      if (typeof w?.used_percent !== 'number') continue;
      if (typeof w.resets_at === 'number' && w.resets_at * 1000 < Date.now()) continue;
      used = Math.max(used, w.used_percent);
    }
    return used < 0 ? 1 : clamp01(1 - used / 100);
  }
  return null;
}

/** Null when no snapshot can be found; the caller falls back to the counter. */
export function codexHeadroom(): number | null {
  const now = Date.now();
  if (codexCache && now - codexCache.at < 60_000) return codexCache.value;

  let value: number | null = null;
  for (const file of newestSessionFiles(5)) {
    value = snapshotFrom(file);
    if (value !== null) break;
  }
  codexCache = { at: now, value };
  return value;
}

export function headroomInfo(provider: string): { value: number; measured: boolean } {
  if (provider === 'codex') {
    const measured = codexHeadroom();
    if (measured !== null) return { value: measured, measured: true };
  }
  const budget = readConfig().budgets[provider] ?? 200;
  return { value: clamp01(1 - runsThisWeek(provider) / Math.max(budget, 1)), measured: false };
}

export function headroom(provider: string): number {
  return headroomInfo(provider).value;
}

// --- health ------------------------------------------------------------------

/** Only providers that are still dead; expired entries are dropped on read. */
export function providerHealth(): Record<string, HealthEntry> {
  const all = readJson<Record<string, HealthEntry>>(configPath('health.json'), {});
  const now = Date.now();
  const live: Record<string, HealthEntry> = {};
  for (const [provider, entry] of Object.entries(all)) {
    if (entry?.state === 'dead' && entry.until > now) live[provider] = entry;
  }
  return live;
}

export function markDead(provider: string, reason: string, cooldownMs = DEAD_COOLDOWN_MS): void {
  writeJson(configPath('health.json'), {
    ...providerHealth(),
    [provider]: { state: 'dead', reason, until: Date.now() + cooldownMs },
  });
}

export function deadEntry(provider: string): HealthEntry | undefined {
  return providerHealth()[provider];
}

export function isDead(provider: string): boolean {
  return deadEntry(provider) !== undefined;
}

/**
 * "Available but unable to serve". A tier or auth problem outlives a quota one,
 * so it earns the longer cooldown.
 */
const TIER_OR_AUTH =
  /IneligibleTierError|migrate to Antigravity|unauthorized|not logged in|please log ?in|invalid api key|authentication failed/i;
const QUOTA = /session limit|rate.?limit|quota|usage limit|too many requests|\b429\b/i;

export function deadReason(text: string): { reason: string; cooldownMs: number } | null {
  const tier = TIER_OR_AUTH.exec(text ?? '');
  if (tier) return { reason: tier[0], cooldownMs: DEAD_COOLDOWN_MS };
  const quota = QUOTA.exec(text ?? '');
  if (quota) return { reason: quota[0].toLowerCase(), cooldownMs: HOUR };
  return null;
}
