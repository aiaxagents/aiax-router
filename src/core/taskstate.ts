import { randomUUID } from 'node:crypto';
import type { Adapter } from '../adapters/types.js';
import { ask, asString, cheapestCandidate, parseJsonObject } from './ask.js';
import { configPath, writeJson } from './store.js';
import type { Category, Difficulty, RoutingTable } from './types.js';

export interface Subtask {
  id: string;
  title: string;
  task: string;
  category: Category;
  difficulty: Difficulty;
  /** Ids of subtasks whose results this one needs. */
  dependsOn: string[];
}

export interface SubtaskResult {
  id: string;
  title: string;
  provider: string;
  model: string;
  ok: boolean;
  /** One line, kept even after the body is compressed away. */
  summary: string;
  text: string;
}

export interface ReviewRound {
  round: number;
  average: number;
  scores: { lens: string; provider: string; model: string; score: number; note: string }[];
  gaps: string[];
}

export interface Choice {
  label: string;
  /** One sentence saying what picking this one means. */
  means: string;
  recommended?: boolean;
}

/** Something only the person who asked can settle, offered as a few plain choices. */
export interface TaskQuestion {
  id: string;
  question: string;
  choices: Choice[];
  /** The label the user picked, or their own words. Absent while it is still open. */
  answer?: string;
}

export interface TaskState {
  id: string;
  createdAt: string;
  task: string;
  intent: string;
  acceptanceCriteria: string[];
  /** Assumption log: what the router decided on the user's behalf, and why. */
  decisions: string[];
  /** The few points that genuinely need the person, shown at the end. */
  needsYourCall: TaskQuestion[];
  subtasks: Subtask[];
  results: SubtaskResult[];
  reviewRounds: ReviewRound[];
  status: 'running' | 'done' | 'needs-work' | 'failed';
}

/** Past this much accumulated text the state is compressed before the next dispatch. */
export const DEFAULT_STATE_BUDGET = 24_000;
/** Every dispatch gets a brief this size at most, never the full history. */
export const DEFAULT_BRIEF_CHARS = 6_000;

const SUMMARY_CHARS = 240;
const COMPACT_TIMEOUT_MS = 90_000;

export function newTaskState(task: string, id: string = randomUUID()): TaskState {
  return {
    id,
    createdAt: new Date().toISOString(),
    task,
    intent: '',
    acceptanceCriteria: [],
    decisions: [],
    needsYourCall: [],
    subtasks: [],
    results: [],
    reviewRounds: [],
    status: 'running',
  };
}

export function taskStatePath(id: string): string {
  return configPath('tasks', id, 'state.json');
}

export function saveTaskState(state: TaskState): void {
  writeJson(taskStatePath(state.id), state);
}

export function oneLine(text: string, limit = SUMMARY_CHARS): string {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > limit ? `${line.slice(0, limit).trimEnd()}...` : line;
}

// --- handoff brief -----------------------------------------------------------

function bullets(items: string[]): string {
  return items.map((i) => `  - ${i}`).join('\n');
}

function render(
  state: TaskState,
  current: Subtask | undefined,
  decisions: string[],
  siblings: SubtaskResult[],
): string {
  const parts: string[] = [`What the user wants: ${state.intent || state.task}`];
  if (state.acceptanceCriteria.length) {
    parts.push(`It is done when:\n${bullets(state.acceptanceCriteria)}`);
  }
  if (current) {
    parts.push(`Your part of the job: ${current.title}\n${current.task}`);
  }
  if (decisions.length) {
    parts.push(`Already settled, do not reopen:\n${bullets(decisions)}`);
  }
  if (siblings.length) {
    parts.push(
      `Work already finished by others:\n${bullets(
        siblings.map((r) => `${r.title}: ${r.summary || oneLine(r.text)}`),
      )}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * The bounded package a dispatch gets instead of the whole history. Deterministic:
 * the same state always produces the same brief, and when it does not fit, the
 * least useful lines go first (unrelated results, then oldest decisions).
 */
export function handoffBrief(
  state: TaskState,
  maxChars = DEFAULT_BRIEF_CHARS,
  current?: Subtask,
): string {
  const needed = new Set(current?.dependsOn ?? []);
  const others: SubtaskResult[] = [];
  const deps: SubtaskResult[] = [];
  for (const r of state.results) {
    if (r.id === current?.id) continue;
    (needed.has(r.id) ? deps : others).push(r);
  }

  let dropOthers = 0;
  let dropDeps = 0;
  let dropDecisions = 0;
  for (;;) {
    const siblings = [...others.slice(dropOthers), ...deps.slice(dropDeps)];
    const text = render(state, current, state.decisions.slice(dropDecisions), siblings);
    if (text.length <= maxChars) return text;
    if (dropOthers < others.length) dropOthers++;
    else if (dropDecisions < state.decisions.length) dropDecisions++;
    else if (dropDeps < deps.length) dropDeps++;
    else return text.slice(0, maxChars);
  }
}

// --- compaction --------------------------------------------------------------

export function stateChars(state: TaskState): number {
  return JSON.stringify(state).length;
}

/** Fallback: oldest result bodies go first, and each keeps its one-line summary. */
export function truncateState(state: TaskState, budget = DEFAULT_STATE_BUDGET): boolean {
  let changed = false;
  for (const r of state.results) {
    if (stateChars(state) <= budget) break;
    if (!r.text) continue;
    if (!r.summary) r.summary = oneLine(r.text);
    r.text = '';
    changed = true;
  }
  return changed;
}

function compactPrompt(state: TaskState, results: SubtaskResult[]): string {
  const pieces = results
    .map((r) => `--- piece ${r.id}: ${r.title} ---\n${r.text}`)
    .join('\n\n');
  return `Shorten the finished pieces below so a later step can still use them.

Keep every fact, number, name, file path and decision that is needed to satisfy the goal and the criteria. Drop wording, repetition and anything already covered by the goal. Do not add anything new and do not judge the work.

Goal: ${state.intent || state.task}

It is done when:
${bullets(state.acceptanceCriteria)}

${pieces}

Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"results":[{"id":"the piece id","summary":"the shortened piece"}]}`;
}

/**
 * Keeps the running state inside its budget without the user ever hearing about
 * context limits. A cheap model condenses the finished pieces; if it cannot, the
 * deterministic truncation does the same job with less nuance.
 */
export async function compactState(
  state: TaskState,
  opts: {
    budget?: number;
    available?: Set<string>;
    table?: RoutingTable;
    adapters?: Adapter[];
  } = {},
): Promise<'none' | 'model' | 'truncated'> {
  const budget = opts.budget ?? DEFAULT_STATE_BUDGET;
  if (stateChars(state) <= budget) return 'none';

  const candidate =
    opts.available && opts.table ? cheapestCandidate(opts.available, opts.table) : undefined;
  const heavy = state.results.filter((r) => r.text.length > 400);

  if (candidate && heavy.length) {
    const { ok, text } = await ask(candidate, compactPrompt(state, heavy), {
      effort: 'low',
      timeoutMs: COMPACT_TIMEOUT_MS,
      adapters: opts.adapters,
    });
    const parsed = ok ? parseJsonObject(text) : null;
    const list = Array.isArray(parsed?.results) ? (parsed.results as unknown[]) : [];
    let applied = 0;
    for (const entry of list) {
      const row = entry as Record<string, unknown>;
      const target = state.results.find((r) => r.id === asString(row.id));
      const summary = asString(row.summary);
      if (!target || !summary || !target.text) continue;
      if (!target.summary) target.summary = oneLine(target.text);
      target.text = summary;
      applied++;
    }
    if (applied && stateChars(state) <= budget) return 'model';
  }

  truncateState(state, budget);
  return 'truncated';
}
