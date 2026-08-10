import { adapters as realAdapters } from '../adapters/index.js';
import type { Adapter, AdapterEvent } from '../adapters/types.js';
import { beginRun } from './activity.js';
import { classify } from './classify.js';
import { addUsage } from './tally.js';
import { loadRoutingTable } from './routing-table.js';
import { select } from './select.js';
import { deadEntry, deadReason, headroom, isDead, markDead, recordRun } from './usage.js';
import type { Classification, Decision, RoutingTable } from './types.js';

export interface RouteOptions {
  /** Real registry by default; tests pass fakes. */
  adapters?: Adapter[];
  table?: RoutingTable;
  available?: Set<string>;
  /** Skips the model classifier when the caller already knows the shape of the task. */
  classification?: Classification;
  cwd?: string;
  timeoutMs?: number;
}

/** Probes every CLI at once; `available` is installed AND signed in AND not marked dead. */
export async function availability(list: Adapter[] = realAdapters): Promise<{
  available: Set<string>;
  detail: Map<string, string>;
}> {
  const available = new Set<string>();
  const detail = new Map<string, string>();

  await Promise.all(
    list.map(async (a) => {
      const det = await a.detect();
      if (!det.installed) {
        detail.set(a.id, `not installed  (${a.subscriptionName})`);
        return;
      }
      const auth = await a.authStatus();
      if (!auth.loggedIn) {
        detail.set(a.id, `signed out - run: ${auth.loginHint}`);
        return;
      }
      const dead = deadEntry(a.id);
      if (dead) {
        detail.set(a.id, `signed in, but cannot take work: ${dead.reason}`);
        return;
      }
      available.add(a.id);
      detail.set(a.id, `ready ${det.version ?? ''}`.trim());
    }),
  );

  return { available, detail };
}

const NOTHING_AVAILABLE =
  'No AI tool is both installed and signed in, so there is nothing to route to. Run `aiax-router doctor` to see what is missing.';

export async function routeTask(
  task: string,
  available?: Set<string>,
  opts: RouteOptions = {},
): Promise<{ classification: Classification; decision: Decision }> {
  const table = opts.table ?? loadRoutingTable();
  const set = available ?? opts.available ?? (await availability(opts.adapters)).available;
  const classification = opts.classification ?? (await classify(task, set, table, opts.adapters));

  // The classifier itself can discover that a provider is out of quota.
  const live = new Set([...set].filter((p) => !isDead(p)));
  const decision = select({ classification, table, available: live, headroom });
  if (!decision) throw new Error(NOTHING_AVAILABLE);
  return { classification, decision };
}

/** One run on one provider. Every finished dispatch lands in the usage log. */
export async function* dispatch(
  task: string,
  decision: Decision,
  opts: RouteOptions = {},
): AsyncGenerator<AdapterEvent> {
  const adapter = (opts.adapters ?? realAdapters).find((a) => a.id === decision.provider);
  if (!adapter) throw new Error(`No adapter for provider "${decision.provider}".`);

  const started = Date.now();
  let ok = false;
  let sawError = false;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  const ended = beginRun({
    provider: decision.provider,
    model: decision.model,
    effort: decision.effort,
    role: 'work',
  });
  try {
    for await (const ev of adapter.run(task, {
      model: decision.model,
      effort: decision.effort,
      cwd: opts.cwd ?? process.cwd(),
      timeoutMs: opts.timeoutMs ?? 600_000,
    })) {
      if (ev.type === 'result') {
        ok = ev.ok;
        usage = ev.usage;
      } else if (ev.type === 'error') {
        sawError = true;
      }
      yield ev;
    }
  } finally {
    ended();
    addUsage(decision.provider, decision.model, usage);
    recordRun({
      ts: new Date().toISOString(),
      provider: decision.provider,
      model: decision.model,
      effort: decision.effort,
      ok: ok && !sawError,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      durationMs: Date.now() - started,
    });
  }
}

export type RunEvent =
  | AdapterEvent
  | { type: 'decision'; decision: Decision; attempt: number }
  | { type: 'failover'; message: string };

const MAX_ATTEMPTS = 3;

/**
 * Runs the task, and when a provider turns out to be signed in but unable to
 * serve (dead tier, out of quota), marks it dead and hands the same task to the
 * next best candidate. A failure of the task itself is reported as-is: trying
 * another model would only fail the same way, slower.
 */
export async function* runWithFailover(
  task: string,
  opts: RouteOptions = {},
): AsyncGenerator<RunEvent> {
  const table = opts.table ?? loadRoutingTable();
  const set = opts.available ?? (await availability(opts.adapters)).available;
  const { classification, decision } = await routeTask(task, set, { ...opts, table });

  const tried = new Set<string>();
  let current: Decision = decision;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    yield { type: 'decision', decision: current, attempt };
    tried.add(current.provider);

    // Held back so a failed attempt does not print its noise ahead of a retry.
    const held: AdapterEvent[] = [];
    let ok = false;
    let sawError = false;
    let failure = '';
    let answer = '';
    for await (const ev of dispatch(task, current, opts)) {
      if (ev.type === 'error') {
        sawError = true;
        failure += `${ev.message}\n`;
        held.push(ev);
      } else if (ev.type === 'result') {
        ok = ev.ok;
        answer = ev.text;
        held.push(ev);
      } else {
        yield ev;
      }
    }
    // A CLI that exits non-zero has failed even when its own result says
    // otherwise, and then its "answer" is really the refusal message.
    if (ok && !sawError) {
      yield* held;
      return;
    }
    failure += answer;

    // A failed CLI run is a provider problem (crash, bad config, timeout,
    // empty output) far more often than a task problem, so any failure hands
    // the task to the next candidate. Dead-tier reasons also bench the
    // provider for the cooldown; other failures just skip it for this task.
    const reason = deadReason(failure);
    if (reason) markDead(current.provider, reason.reason, reason.cooldownMs);

    const next =
      attempt < MAX_ATTEMPTS
        ? select({
            classification,
            table,
            available: new Set([...set].filter((p) => !tried.has(p) && !isDead(p))),
            headroom,
          })
        : null;
    if (!next) {
      yield* held;
      return;
    }
    yield {
      type: 'failover',
      message: reason
        ? `That tool could not take the job (${reason.reason}). Trying ${next.provider}/${next.model} instead.`
        : `${current.provider} could not finish this, so ${next.provider}/${next.model} is taking over.`,
    };
    current = next;
  }
}
