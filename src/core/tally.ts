import { AsyncLocalStorage } from 'node:async_hooks';
import { getPrice } from './prices.js';

/**
 * Counts what one task actually used, model call by model call. The runs are
 * covered by subscriptions; the dollar figure only says what the same tokens
 * would have cost at the vendor's public API list price (model-prices.json,
 * editable), so the person can see the value they got.
 *
 * Attribution is ambient: the web board wraps each task in `withTask`, and
 * every ask() and dispatch() inside reports here without knowing about tasks.
 * The CLI runs outside any context and nothing is counted.
 */

export interface UsageLine {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  /** Null when no line could be priced; partial sums count the priced lines. */
  costUsd: number | null;
  lines: UsageLine[];
}

const context = new AsyncLocalStorage<string>();
interface Row {
  input: number;
  output: number;
  /** Sum of CLI-reported API costs; null until any call reports one. */
  cost: number | null;
}

const tallies = new Map<string, Map<string, Row>>();

export function withTask<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  return context.run(taskId, fn);
}

export function addUsage(
  provider: string,
  model: string,
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number },
): void {
  const taskId = context.getStore();
  if (!taskId || !usage) return;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (!input && !output && usage.costUsd == null) return;
  let byModel = tallies.get(taskId);
  if (!byModel) tallies.set(taskId, (byModel = new Map()));
  const key = `${provider}\u0000${model}`;
  const row = byModel.get(key) ?? { input: 0, output: 0, cost: null };
  row.input += input;
  row.output += output;
  if (usage.costUsd != null) row.cost = (row.cost ?? 0) + usage.costUsd;
  byModel.set(key, row);
}

/** The task's totals so far. `end` drops the tally once the task is finished. */
export function taskUsage(taskId: string, opts: { end?: boolean } = {}): TaskUsage | undefined {
  const byModel = tallies.get(taskId);
  if (opts.end) tallies.delete(taskId);
  if (!byModel || byModel.size === 0) return undefined;

  const lines: UsageLine[] = [];
  for (const [key, row] of byModel) {
    const [provider, model] = key.split('\u0000');
    // The CLI's own cost figure beats our list-price math when it gives one.
    const price = row.cost == null ? getPrice(provider, model) : null;
    const priced =
      row.cost ?? (price ? (row.input * price.input + row.output * price.output) / 1e6 : null);
    lines.push({
      provider,
      model,
      inputTokens: row.input,
      outputTokens: row.output,
      costUsd: priced == null ? null : Math.round(priced * 10000) / 10000,
    });
  }
  lines.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  const priced = lines.filter((l) => l.costUsd !== null);
  return {
    inputTokens: lines.reduce((sum, l) => sum + l.inputTokens, 0),
    outputTokens: lines.reduce((sum, l) => sum + l.outputTokens, 0),
    costUsd: priced.length
      ? Math.round(priced.reduce((sum, l) => sum + (l.costUsd ?? 0), 0) * 10000) / 10000
      : null,
    lines,
  };
}
