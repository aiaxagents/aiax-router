import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter, AdapterEvent } from '../src/adapters/types.js';
import { readJson } from '../src/core/store.js';
import {
  compactState,
  handoffBrief,
  newTaskState,
  saveTaskState,
  stateChars,
  taskStatePath,
  truncateState,
  type SubtaskResult,
  type TaskState,
} from '../src/core/taskstate.js';
import type { Candidate, RoutingTable } from '../src/core/types.js';

let home: string;
let asked: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-state-'));
  process.env.AIAX_ROUTER_HOME = home;
  asked = [];
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

const FLASH: Candidate = {
  provider: 'kimi',
  model: 'flash',
  score: 74,
  costWeight: 0.5,
  tokensPerTask: 0.6,
};
const OPUS: Candidate = {
  provider: 'claude',
  model: 'opus',
  score: 89,
  costWeight: 5,
  tokensPerTask: 1.6,
};

const TABLE: RoutingTable = {
  schemaVersion: 1,
  generatedAt: '2026-08-04T00:00:00Z',
  sources: [{ name: 'test-fixture' }],
  categories: {
    coding: [],
    'agentic-coding': [],
    reasoning: [],
    writing: [],
    chat: [OPUS, FLASH],
    'long-context': [],
  },
  difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
};

function fake(id: string, events: AdapterEvent[] | null): Adapter {
  return {
    id,
    displayName: id,
    binary: id,
    subscriptionName: `${id} plan`,
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ loggedIn: true, loginHint: id }),
    async *run() {
      asked.push(id);
      yield* events ?? [
        { type: 'error', message: 'nothing doing' },
        { type: 'result', ok: false, text: '' },
      ];
    },
  };
}

function result(id: string, size: number): SubtaskResult {
  return {
    id,
    title: `Step ${id}`,
    provider: 'kimi',
    model: 'flash',
    ok: true,
    summary: `summary of ${id}`,
    text: `body of ${id} `.padEnd(size, 'x'),
  };
}

function state(): TaskState {
  const s = newTaskState('write the thing');
  s.intent = 'Produce the thing the user asked for.';
  s.acceptanceCriteria = ['It is correct.', 'It is short.'];
  s.decisions = ['Assumed British English.', 'Assumed markdown output.'];
  s.subtasks = [
    { id: 's1', title: 'Step s1', task: 'do one', category: 'chat', difficulty: 'easy', dependsOn: [] },
    { id: 's2', title: 'Step s2', task: 'do two', category: 'chat', difficulty: 'easy', dependsOn: [] },
    {
      id: 's3',
      title: 'Step s3',
      task: 'do three',
      category: 'chat',
      difficulty: 'easy',
      dependsOn: ['s2'],
    },
  ];
  return s;
}

describe('handoffBrief', () => {
  it('carries intent, criteria, decisions and the sibling summaries', () => {
    const s = state();
    s.results = [result('s1', 50), result('s2', 50)];
    const brief = handoffBrief(s, 4_000, s.subtasks[2]);

    expect(brief).toContain('Produce the thing the user asked for.');
    expect(brief).toContain('It is correct.');
    expect(brief).toContain('Assumed British English.');
    expect(brief).toContain('Step s3');
    expect(brief).toContain('do three');
    expect(brief).toContain('summary of s1');
    expect(brief).not.toContain('body of s1');
  });

  it('never goes past maxChars, and is the same every time', () => {
    const s = state();
    s.results = [result('s1', 4_000), result('s2', 4_000)];
    const first = handoffBrief(s, 300, s.subtasks[2]);
    const second = handoffBrief(s, 300, s.subtasks[2]);

    expect(first.length).toBeLessThanOrEqual(300);
    expect(first).toBe(second);
    expect(first).toContain('Produce the thing the user asked for.');
  });

  it('drops unrelated work before the work this step depends on', () => {
    const s = state();
    s.results = [result('s1', 50), result('s2', 50)];
    const brief = handoffBrief(s, 330, s.subtasks[2]);

    expect(brief.length).toBeLessThanOrEqual(330);
    expect(brief).toContain('summary of s2');
    expect(brief).not.toContain('summary of s1');
  });

  it('works before anything has been split up', () => {
    const s = newTaskState('just this');
    expect(handoffBrief(s)).toContain('just this');
  });
});

describe('compactState', () => {
  it('leaves a small state alone', async () => {
    const s = state();
    s.results = [result('s1', 100)];
    expect(await compactState(s, { budget: 24_000, available: new Set(['kimi']), table: TABLE })).toBe(
      'none',
    );
    expect(s.results[0].text).toContain('body of s1');
  });

  it('has a cheap model shorten the finished pieces once the budget is passed', async () => {
    const s = state();
    s.results = [result('s1', 600), result('s2', 600), result('s3', 600)];
    const shortened = JSON.stringify({
      results: [
        { id: 's1', summary: 'short one' },
        { id: 's2', summary: 'short two' },
        { id: 's3', summary: 'short three' },
      ],
    });

    const how = await compactState(s, {
      budget: 1_200,
      available: new Set(['kimi', 'claude']),
      table: TABLE,
      adapters: [
        fake('kimi', [{ type: 'result', ok: true, text: shortened }]),
        fake('claude', [{ type: 'result', ok: true, text: 'must not be asked' }]),
      ],
    });

    expect(how).toBe('model');
    expect(asked).toEqual(['kimi']);
    expect(s.results.map((r) => r.text)).toEqual(['short one', 'short two', 'short three']);
    expect(s.intent).toBe('Produce the thing the user asked for.');
    expect(s.acceptanceCriteria).toEqual(['It is correct.', 'It is short.']);
    expect(stateChars(s)).toBeLessThanOrEqual(1_200);
  });

  it('falls back to dropping the oldest bodies when the model cannot help', async () => {
    const s = state();
    s.results = [result('s1', 600), result('s2', 600), result('s3', 600)];
    // Room enough that two bodies have to go and the newest one survives.
    const budget = stateChars(s) - 1_000;

    const how = await compactState(s, {
      budget,
      available: new Set(['kimi']),
      table: TABLE,
      adapters: [fake('kimi', null)],
    });

    expect(how).toBe('truncated');
    expect(s.results[0].text).toBe('');
    expect(s.results[0].summary).toBe('summary of s1');
    expect(s.results[2].text).toContain('body of s3');
    expect(s.intent).toBe('Produce the thing the user asked for.');
    expect(s.decisions).toEqual(['Assumed British English.', 'Assumed markdown output.']);
  });

  it('truncates without any model at all', () => {
    const s = state();
    s.results = [result('s1', 600), result('s2', 600)];
    expect(truncateState(s, 800)).toBe(true);
    expect(s.results[0].text).toBe('');
    expect(s.results[0].summary).toBe('summary of s1');
  });
});

describe('saveTaskState', () => {
  it('writes one state file per task', () => {
    const s = state();
    saveTaskState(s);
    const back = readJson<TaskState | null>(taskStatePath(s.id), null);
    expect(back?.id).toBe(s.id);
    expect(back?.intent).toBe(s.intent);
    expect(taskStatePath(s.id).startsWith(join(home, 'tasks'))).toBe(true);
  });
});
