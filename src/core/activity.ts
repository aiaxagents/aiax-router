import { randomUUID } from 'node:crypto';
import type { Effort } from './types.js';

/**
 * What is on a model right now. Every dispatch and every helper ask registers
 * here for as long as it runs, so the app can show the person which model is
 * working at this moment.
 */
export interface ActiveRun {
  id: string;
  provider: string;
  model: string;
  effort: Effort;
  /** 'work' is the task itself; everything else is a helper around it. */
  role: 'work' | 'planning' | 'review' | 'helper';
  startedAt: string;
}

const runs = new Map<string, ActiveRun>();
const listeners = new Set<(runs: ActiveRun[]) => void>();

export function activeRuns(): ActiveRun[] {
  return [...runs.values()];
}

export function onActivity(fn: (runs: ActiveRun[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function ping(): void {
  const list = activeRuns();
  for (const fn of listeners) {
    try {
      fn(list);
    } catch {
      // one broken listener must never stop a run
    }
  }
}

/** Registers a run and returns the matching "it ended" call. */
export function beginRun(run: Omit<ActiveRun, 'id' | 'startedAt'>): () => void {
  const it: ActiveRun = { ...run, id: randomUUID(), startedAt: new Date().toISOString() };
  runs.set(it.id, it);
  ping();
  return () => {
    runs.delete(it.id);
    ping();
  };
}
