import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPipeline } from '../core/pipeline.js';
import { availability } from '../core/router.js';
import { loadRoutingTable } from '../core/routing-table.js';
import { taskUsage, withTask, type TaskUsage } from '../core/tally.js';
import { configPath, readJson, writeJson } from '../core/store.js';
import {
  oneLine,
  taskStatePath,
  type TaskQuestion,
  type TaskState,
} from '../core/taskstate.js';
import { narrate } from './narrate.js';
import { resultPage } from './result.js';

/** Two at a time, the same gentleness the pipeline uses inside one task. */
const MAX_RUNNING = 2;
const MAX_LINES = 60;

export interface NarrationLine {
  id: string;
  at: string;
  text: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: 'backlog' | 'running' | 'done' | 'failed';
  /** One short plain sentence, the only status the board shows. */
  sentence: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  agent?: string;
  parts: { done: number; total: number };
  score?: number;
  rounds?: number;
  passed?: boolean;
  /** Set while the router is waiting on the person. */
  question?: TaskQuestion;
  unread: boolean;
  lines: NarrationLine[];
  attachments: string[];
  /** The opening of the deliverable, so the thread can show it without a second fetch. */
  excerpt?: string;
  /** Tokens the task used, priced at API list price. Subscriptions paid for it. */
  usage?: TaskUsage;
}

/** Enough to read in the thread; the whole thing lives on the result page. */
const EXCERPT_CHARS = 900;

import type { ActiveRun } from '../core/activity.js';
import type { Effort } from '../core/types.js';

export type BoardEvent =
  | { type: 'task'; task: TaskRecord }
  | { type: 'narration'; taskId: string; line: NarrationLine }
  | { type: 'activity'; runs: ActiveRun[] }
  | {
      type: 'routing';
      routing: {
        mode: 'auto' | 'manual';
        provider: string | null;
        model: string | null;
        effort: Effort | null;
      };
    };

// --- the file the board is drawn from ---------------------------------------

function tasksPath(): string {
  return configPath('tasks.json');
}

export function listTasks(): TaskRecord[] {
  return readJson<TaskRecord[]>(tasksPath(), []);
}

export function getTask(id: string): TaskRecord | undefined {
  return listTasks().find((t) => t.id === id);
}

function putTask(rec: TaskRecord): void {
  const all = listTasks();
  const at = all.findIndex((t) => t.id === rec.id);
  if (at >= 0) all[at] = rec;
  else all.unshift(rec);
  writeJson(tasksPath(), all);
}

export function readState(id: string): TaskState | null {
  return readJson<TaskState | null>(taskStatePath(id), null);
}

// --- who is listening --------------------------------------------------------

const listeners = new Set<(ev: BoardEvent) => void>();

export function subscribe(fn: (ev: BoardEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(ev: BoardEvent): void {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      // one broken client must never stop the run
    }
  }
}

/** For events that come from outside this module, like the routing switch. */
export const broadcast = emit;

function save(rec: TaskRecord, sentence?: string): void {
  if (sentence) rec.sentence = sentence;
  rec.updatedAt = new Date().toISOString();
  putTask(rec);
  emit({ type: 'task', task: rec });
}

// --- narration ---------------------------------------------------------------

/**
 * The deterministic line goes out at once so the app never waits on a model,
 * and the plain-words version replaces it under the same id when it lands.
 * One translation in flight per task keeps this from becoming its own workload.
 */
const translating = new Set<string>();

function pushLine(rec: TaskRecord, text: string, available: Set<string>): NarrationLine {
  const line: NarrationLine = { id: randomUUID(), at: new Date().toISOString(), text };
  rec.lines.push(line);
  if (rec.lines.length > MAX_LINES) rec.lines.splice(0, rec.lines.length - MAX_LINES);
  save(rec, text);
  emit({ type: 'narration', taskId: rec.id, line });

  if (!translating.has(rec.id)) {
    translating.add(rec.id);
    void narrate(text, available, loadRoutingTable())
      .then((plain) => {
        if (!plain) return;
        const current = getTask(rec.id);
        const found = current?.lines.find((l) => l.id === line.id);
        if (!current || !found) return;
        found.text = plain;
        if (current.sentence === text) current.sentence = plain;
        putTask(current);
        emit({ type: 'narration', taskId: current.id, line: found });
        emit({ type: 'task', task: current });
      })
      .catch(() => undefined)
      .finally(() => translating.delete(rec.id));
  }
  return line;
}

// --- questions the person has to settle --------------------------------------

interface Pending {
  questions: TaskQuestion[];
  answers: Record<string, string>;
  resolve: (answers: Record<string, string>) => void;
}

const pending = new Map<string, Pending>();

/** Returns false when this task was not waiting on anybody. */
export function answerTask(id: string, answer: string, questionId?: string): boolean {
  const wait = pending.get(id);
  const rec = getTask(id);
  if (!wait || !rec) return false;
  const open = wait.questions.find((q) =>
    questionId ? q.id === questionId : wait.answers[q.id] === undefined,
  );
  if (!open) return false;

  wait.answers[open.id] = answer;
  open.answer = answer;
  const next = wait.questions.find((q) => wait.answers[q.id] === undefined);
  rec.question = next;
  save(rec, next ? next.question : 'Thanks, carrying on.');
  if (!next) {
    pending.delete(id);
    wait.resolve(wait.answers);
  }
  return true;
}

// --- results -----------------------------------------------------------------

export function resultDir(id: string): string {
  return configPath('results', id);
}

function writeResult(rec: TaskRecord, answer: string): void {
  const dir = resultDir(rec.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'answer.md'), answer.endsWith('\n') ? answer : `${answer}\n`);
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    files = ['answer.md'];
  }
  writeFileSync(
    join(dir, 'index.html'),
    resultPage(
      {
        id: rec.id,
        title: rec.title,
        sentence: rec.sentence,
        // a person reads "5 August at 22:11", not a slashed timestamp with seconds
        finishedAt: new Date(rec.finishedAt ?? Date.now()).toLocaleString('en-GB', {
          day: 'numeric',
          month: 'long',
          hour: '2-digit',
          minute: '2-digit',
        }),
        score: rec.score,
        rounds: rec.rounds,
        files,
      },
      answer,
    ),
  );
}

// --- running -----------------------------------------------------------------

function partsOf(state: TaskState | null): { done: number; total: number } {
  if (!state) return { done: 0, total: 0 };
  return {
    total: state.subtasks.length,
    done: state.results.filter((r) => r.ok && !r.id.startsWith('fix-')).length,
  };
}

function doneSentence(rec: TaskRecord): string {
  if (rec.passed === false) return 'Done, but not everything is right yet.';
  if (rec.rounds && rec.rounds > 1) return `Done after ${rec.rounds} review rounds.`;
  return 'Saved to your results.';
}

function runOne(rec: TaskRecord): Promise<void> {
  // Everything inside runs in this task's tally context, so every model call
  // underneath, helpers included, lands on this task's token count.
  return withTask(rec.id, () => runOneInner(rec));
}

async function runOneInner(rec: TaskRecord): Promise<void> {
  const cwd = taskCwd(rec.id);
  mkdirSync(cwd, { recursive: true });
  rec.status = 'running';
  rec.startedAt = new Date().toISOString();
  save(rec, 'Getting started.');

  const { available } = await availability();

  try {
    for await (const ev of runPipeline(rec.title, {
      id: rec.id,
      cwd,
      available,
      decide: (questions) =>
        new Promise((resolve) => {
          pending.set(rec.id, { questions, answers: {}, resolve });
          rec.question = questions[0];
          save(rec, questions[0].question);
        }),
    })) {
      if (ev.type === 'progress') {
        rec.parts = partsOf(readState(rec.id));
        rec.question = pending.get(rec.id) ? rec.question : undefined;
        rec.usage = taskUsage(rec.id) ?? rec.usage;
        pushLine(rec, ev.message, available);
        continue;
      }

      rec.finishedAt = new Date().toISOString();
      rec.question = undefined;
      rec.parts = partsOf(ev.state);
      rec.unread = true;
      rec.usage = taskUsage(rec.id, { end: true }) ?? rec.usage;
      if (!ev.ok) {
        rec.status = 'failed';
        save(rec, 'Nothing usable came back, so nothing was saved.');
        return;
      }
      rec.status = 'done';
      rec.rounds = ev.rounds;
      rec.passed = ev.outcome?.passed ?? undefined;
      rec.score = ev.outcome?.reviewed ? ev.outcome.average : undefined;
      rec.sentence = doneSentence(rec);
      rec.excerpt =
        ev.answer.length > EXCERPT_CHARS
          ? `${ev.answer.slice(0, EXCERPT_CHARS).trimEnd()}...`
          : ev.answer;
      writeResult(rec, ev.answer);
      save(rec);
    }
  } catch (err) {
    rec.status = 'failed';
    rec.finishedAt = new Date().toISOString();
    rec.question = undefined;
    rec.usage = taskUsage(rec.id, { end: true }) ?? rec.usage;
    pending.delete(rec.id);
    save(rec, oneLine(err instanceof Error ? err.message : String(err), 120) || 'This one stopped.');
  }
}

/** Starts whatever the running slots allow, oldest first. */
function pump(): void {
  const all = listTasks();
  let running = all.filter((t) => t.status === 'running').length;
  const queued = all.filter((t) => t.status === 'backlog').reverse();
  for (const rec of queued) {
    if (running >= MAX_RUNNING) break;
    running++;
    void runOne(rec).finally(pump);
  }
}

export function taskCwd(id: string): string {
  return configPath('tasks', id, 'cwd');
}

export interface NewTask {
  text: string;
  agent?: string;
  files?: { name: string; data: Buffer }[];
}

/** Filenames come from a browser, so only the base name is ever trusted. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean.slice(0, 120) || 'attachment';
}

export function startTask(input: NewTask): TaskRecord {
  const id = randomUUID();
  const cwd = taskCwd(id);
  mkdirSync(cwd, { recursive: true });

  const attachments: string[] = [];
  for (const file of input.files ?? []) {
    const name = safeName(file.name);
    writeFileSync(join(cwd, name), file.data);
    attachments.push(name);
  }

  const now = new Date().toISOString();
  const rec: TaskRecord = {
    id,
    title: input.text.trim(),
    status: 'backlog',
    sentence: 'Waiting for the running work.',
    createdAt: now,
    updatedAt: now,
    agent: input.agent,
    parts: { done: 0, total: 0 },
    unread: false,
    lines: [],
    attachments,
  };
  putTask(rec);
  emit({ type: 'task', task: rec });
  pump();
  return rec;
}

export function markRead(id: string): TaskRecord | undefined {
  const rec = getTask(id);
  if (!rec || !rec.unread) return rec;
  rec.unread = false;
  save(rec);
  return rec;
}

/**
 * A card left in Running by a crash is not running any more, whatever the file
 * says, so the board tells the truth about it at startup.
 */
export function recoverRunning(): void {
  const all = listTasks();
  let changed = false;
  for (const rec of all) {
    if (rec.status !== 'running') continue;
    rec.status = 'failed';
    rec.question = undefined;
    rec.sentence = 'The app stopped while this was running.';
    rec.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) writeJson(tasksPath(), all);
}
