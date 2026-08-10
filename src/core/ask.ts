import { adapters as realAdapters } from '../adapters/index.js';
import type { Adapter } from '../adapters/types.js';
import { beginRun, type ActiveRun } from './activity.js';
import { routingOverride } from './override.js';
import { addUsage } from './tally.js';
import { deadReason, markDead } from './usage.js';
import type { Candidate, Category, Effort, RoutingTable } from './types.js';

export const CATEGORIES: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];

/** A helper step must never cost more subscription than the task it helps with. */
export const CHEAP_ENOUGH = 2;

const DEFAULT_TIMEOUT_MS = 180_000;

// --- tolerant JSON -----------------------------------------------------------

/** First balanced {...} block, so fences or chatter around the JSON do no harm. */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const block = firstJsonObject(raw ?? '');
  if (!block) return null;
  try {
    const parsed: unknown = JSON.parse(block);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function asStringList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, limit);
}

// --- picking a model for a helper step ---------------------------------------

/** Cheapest first, then the one that burns fewest tokens getting there. */
export function cheapestCandidate(
  available: Set<string>,
  table: RoutingTable,
): Candidate | undefined {
  const pool: Candidate[] = [];
  for (const category of CATEGORIES) {
    for (const c of table.categories[category] ?? []) {
      if (c.costWeight > CHEAP_ENOUGH || !available.has(c.provider)) continue;
      if (pool.some((p) => p.provider === c.provider && p.model === c.model)) continue;
      pool.push(c);
    }
  }
  return pool.sort((a, b) => a.costWeight - b.costWeight || a.tokensPerTask - b.tokensPerTask)[0];
}

/** Strongest model in the category, price ignored. Used for the steps that set direction. */
export function bestCandidate(
  available: Set<string>,
  table: RoutingTable,
  category: Category,
): Candidate | undefined {
  // A pinned choice also leads: the person picked who does the thinking.
  const pinned = routingOverride();
  if (pinned && available.has(pinned.provider)) {
    for (const cat of CATEGORIES) {
      const hit = (table.categories[cat] ?? []).find(
        (c) => c.provider === pinned.provider && c.model === pinned.model,
      );
      if (hit) return hit;
    }
    return { provider: pinned.provider, model: pinned.model, score: 50, costWeight: 1, tokensPerTask: 1 };
  }
  return (table.categories[category] ?? [])
    .filter((c) => available.has(c.provider))
    .sort((a, b) => b.score - a.score)[0];
}

// --- one read-only question to one model -------------------------------------

export interface Answer {
  ok: boolean;
  text: string;
}

/**
 * A single read-only turn used by the steps around a dispatch (classify, intent,
 * rewrite, assemble, review, compaction). It never throws: every stumble comes
 * back as `ok: false` so the caller can fall back to something deterministic.
 */
export async function ask(
  candidate: Candidate,
  prompt: string,
  opts: {
    effort?: Effort;
    timeoutMs?: number;
    adapters?: Adapter[];
    cwd?: string;
    /** What this ask is for, shown live in the app. */
    role?: ActiveRun['role'];
  } = {},
): Promise<Answer> {
  const adapter = (opts.adapters ?? realAdapters).find((a) => a.id === candidate.provider);
  if (!adapter) return { ok: false, text: '' };

  let text = '';
  let failure = '';
  let ok = false;
  let sawError = false;
  const ended = beginRun({
    provider: candidate.provider,
    model: candidate.model,
    effort: opts.effort ?? 'low',
    role: opts.role ?? 'helper',
  });
  try {
    for await (const ev of adapter.run(prompt, {
      model: candidate.model,
      effort: opts.effort ?? 'low',
      cwd: opts.cwd ?? process.cwd(),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })) {
      if (ev.type === 'text') text += ev.chunk;
      else if (ev.type === 'error') {
        sawError = true;
        failure += `${ev.message}\n`;
      } else if (ev.type === 'result') {
        ok = ev.ok;
        if (ev.text) text = ev.text;
        addUsage(candidate.provider, candidate.model, ev.usage);
      }
    }
  } catch {
    return { ok: false, text: '' };
  } finally {
    ended();
  }

  // A CLI that exits non-zero has failed even when its own result says otherwise,
  // and then its "answer" is really the refusal message.
  if (!ok || sawError) {
    const reason = deadReason(`${failure}${text}`);
    if (reason) markDead(candidate.provider, reason.reason, reason.cooldownMs);
    return { ok: false, text };
  }
  return { ok: true, text };
}
