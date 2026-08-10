import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJson, writeJson } from '../src/core/store.js';
import {
  DEAD_COOLDOWN_MS,
  deadReason,
  headroomInfo,
  isDead,
  markDead,
  providerHealth,
  readConfig,
  recordRun,
  runsThisWeek,
  type RouterConfig,
} from '../src/core/usage.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-usage-'));
  process.env.AIAX_ROUTER_HOME = home;
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

function log(provider: string, count: number, ts = new Date().toISOString()): void {
  for (let i = 0; i < count; i++) {
    recordRun({ ts, provider, model: 'm', effort: 'low', ok: true, durationMs: 10 });
  }
}

describe('config', () => {
  it('writes rough defaults the first time it is read', () => {
    const config = readConfig();
    expect(config.budgets).toEqual({ claude: 300, codex: 300, grok: 200, kimi: 200 });
    const onDisk = readJson<RouterConfig | null>(join(home, 'config.json'), null);
    expect(onDisk?.budgets.grok).toBe(200);
    expect(onDisk?.comment).toMatch(/rough defaults/);
  });

  it('keeps a hand-edited budget and fills in the rest', () => {
    writeJson(join(home, 'config.json'), { comment: 'mine', budgets: { grok: 10 } });
    const config = readConfig();
    expect(config.budgets.grok).toBe(10);
    expect(config.budgets.claude).toBe(300);
  });

  it('never destroys keys owned by other commands when seeding defaults', () => {
    writeJson(join(home, 'config.json'), { aaApiKey: 'secret' });
    const config = readConfig() as RouterConfig & { aaApiKey?: string };
    expect(config.aaApiKey).toBe('secret');
    expect(config.budgets.claude).toBe(300);
    const onDisk = readJson<Record<string, unknown> | null>(join(home, 'config.json'), null);
    expect(onDisk?.aaApiKey).toBe('secret');
    expect((onDisk?.budgets as Record<string, number>).grok).toBe(200);
  });
});

describe('headroom', () => {
  it('counts this week against the provider budget', () => {
    log('grok', 20); // budget 200
    const { value, measured } = headroomInfo('grok');
    expect(measured).toBe(false);
    expect(value).toBeCloseTo(0.9, 5);
  });

  it('ignores runs from a previous week', () => {
    log('grok', 50, new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString());
    log('grok', 2);
    expect(runsThisWeek('grok')).toBe(2);
    expect(headroomInfo('grok').value).toBeCloseTo(0.99, 5);
  });

  it('clamps at zero once the budget is spent', () => {
    log('kimi', 240); // budget 200
    expect(headroomInfo('kimi').value).toBe(0);
  });

  it('counts only the provider asked about', () => {
    log('grok', 10);
    expect(headroomInfo('claude').value).toBe(1);
  });
});

describe('provider health', () => {
  it('marks a provider dead and reports the reason', () => {
    markDead('kimi', 'IneligibleTierError');
    expect(isDead('kimi')).toBe(true);
    const entry = providerHealth().kimi;
    expect(entry.reason).toBe('IneligibleTierError');
    expect(entry.until - Date.now()).toBeGreaterThan(DEAD_COOLDOWN_MS - 5_000);
  });

  it('expires the mark once the cooldown has passed', () => {
    markDead('claude', 'session limit', -1);
    expect(isDead('claude')).toBe(false);
    expect(providerHealth()).toEqual({});
  });

  it('leaves other providers alone', () => {
    markDead('kimi', 'dead tier');
    expect(isDead('grok')).toBe(false);
  });

  // A health file written before a provider was dropped must not be clobbered or crash a read.
  it('tolerates an entry for a provider the router no longer ships', () => {
    writeJson(join(home, 'health.json'), {
      gemini: { state: 'dead', reason: 'IneligibleTierError', until: Date.now() + DEAD_COOLDOWN_MS },
    });
    markDead('kimi', 'session limit');
    expect(Object.keys(providerHealth()).sort()).toEqual(['gemini', 'kimi']);
  });
});

describe('deadReason', () => {
  it('reads a dead tier as a long cooldown', () => {
    const reason = deadReason('IneligibleTierError: please migrate to Antigravity');
    expect(reason?.cooldownMs).toBe(DEAD_COOLDOWN_MS);
  });

  it('reads a spent session as a short cooldown', () => {
    const reason = deadReason("You've hit your session limit. Try again later.");
    expect(reason?.reason).toBe('session limit');
    expect(reason?.cooldownMs).toBe(60 * 60 * 1000);
  });

  it('does not read a failed task as a provider problem', () => {
    expect(deadReason('TypeError: cannot read property foo of undefined')).toBeNull();
  });
});
