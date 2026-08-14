import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../src/adapters/types.js';
import { runPipeline, type PipelineEvent } from '../src/core/pipeline.js';
import { readJson } from '../src/core/store.js';
import { taskStatePath, type TaskState } from '../src/core/taskstate.js';
import type { Candidate, Classification, RoutingTable } from '../src/core/types.js';

let home: string;
let seen: { id: string; prompt: string }[];
let scores: number[];
let reviewCalls: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aiax-pipeline-'));
  process.env.AIAX_ROUTER_HOME = home;
  seen = [];
  scores = [9.8];
  reviewCalls = 0;
});

afterEach(() => {
  delete process.env.AIAX_ROUTER_HOME;
  rmSync(home, { recursive: true, force: true });
});

const OPUS: Candidate = {
  provider: 'claude',
  model: 'opus',
  score: 89,
  costWeight: 5,
  tokensPerTask: 1.6,
};
const GROK: Candidate = {
  provider: 'grok',
  model: 'grok-4.5',
  score: 80,
  costWeight: 3,
  tokensPerTask: 1,
};
const FLASH: Candidate = {
  provider: 'kimi',
  model: 'flash',
  score: 74,
  costWeight: 0.5,
  tokensPerTask: 0.6,
};

const TABLE: RoutingTable = {
  schemaVersion: 1,
  generatedAt: '2026-08-04T00:00:00Z',
  sources: [{ name: 'test-fixture' }],
  categories: {
    coding: [],
    'agentic-coding': [],
    reasoning: [],
    writing: [OPUS, GROK, FLASH],
    chat: [OPUS, GROK, FLASH],
    'long-context': [],
  },
  difficultyFloor: { trivial: 0, easy: 40, medium: 65, hard: 80 },
};

const CLASSIFICATION: Classification = {
  category: 'chat',
  difficulty: 'easy',
  rationale: 'fixture',
  via: 'heuristic',
};

const INTENT = {
  intent: 'Say in one plain sentence what a router does.',
  acceptance: ['Exactly one sentence.', 'No jargon.'],
  assumptions: ['Assumed a general reader.'],
  needsUser: ['Do you want a British or American spelling?'],
};

const SPLIT = {
  subtasks: [
    {
      title: 'Draft the sentence',
      task: 'Write one sentence about what a router does.',
      category: 'chat',
      difficulty: 'easy',
      dependsOn: [],
    },
    {
      title: 'Tighten the wording',
      task: 'Tighten the sentence so it reads well.',
      category: 'writing',
      difficulty: 'easy',
      dependsOn: [1],
    },
  ],
};

/** Every stage recognises its own prompt, so the test also pins the prompts. */
function reply(id: string, prompt: string): string | null {
  if (prompt.includes('Work out what a great result looks like')) return JSON.stringify(INTENT);
  if (prompt.includes('Split the job below')) return JSON.stringify(SPLIT);
  if (prompt.includes('Rewrite the instruction below')) {
    return JSON.stringify({ prompt: 'REWRITTEN INSTRUCTION' });
  }
  if (prompt.includes('Turn the finished pieces below')) {
    return JSON.stringify({ answer: 'ASSEMBLED ANSWER' });
  }
  if (prompt.includes('You are one of five reviewers')) {
    const round = Math.floor(reviewCalls++ / 5);
    const score = scores[Math.min(round, scores.length - 1)];
    return JSON.stringify({
      score,
      note: 'because of reasons',
      gaps: score >= 10 ? [] : ['Say what it costs.'],
    });
  }
  if (prompt.includes('Reviewers found the problems listed below')) return 'FIXED ANSWER';
  return `WORK FROM ${id}`;
}

function fake(id: string): Adapter {
  return {
    id,
    displayName: id,
    binary: id,
    subscriptionName: `${id} plan`,
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ loggedIn: true, loginHint: id }),
    async *run(task: string) {
      seen.push({ id, prompt: task });
      const text = reply(id, task);
      if (text === null) {
        yield { type: 'error', message: 'not today' };
        yield { type: 'result', ok: false, text: '' };
        return;
      }
      yield { type: 'result', ok: true, text };
    },
  };
}

async function pipeline(
  opts: Parameters<typeof runPipeline>[1] = {},
): Promise<{ events: PipelineEvent[]; lines: string[]; done: Extract<PipelineEvent, { type: 'done' }> }> {
  const adapters = [fake('claude'), fake('grok'), fake('kimi')];
  const events: PipelineEvent[] = [];
  for await (const ev of runPipeline('explain what a router does', {
    adapters,
    table: TABLE,
    available: new Set(['claude', 'grok', 'kimi']),
    classification: CLASSIFICATION,
    ...opts,
  })) {
    events.push(ev);
  }
  const done = events.at(-1);
  if (!done || done.type !== 'done') throw new Error('pipeline never finished');
  return {
    events,
    lines: events.filter((e) => e.type === 'progress').map((e: any) => e.message),
    done,
  };
}

const sentTo = (id: string) => seen.filter((s) => s.id === id).map((s) => s.prompt);
const anyPrompt = (needle: string) => seen.some((s) => s.prompt.includes(needle));

describe('runPipeline', () => {
  it('runs the whole thing and hands back a checked answer', async () => {
    const { lines, done } = await pipeline();

    expect(lines[0]).toBe('Working out what you actually want.');
    expect(lines).toContain('Here is the aim: Say in one plain sentence what a router does.');
    expect(lines).toContain('Breaking this into 2 smaller jobs.');
    expect(lines).toContain('Putting it all together.');
    expect(lines).toContain('Five review agents are going over the work.');
    expect(lines).toContain('The review agents are happy with it, 9.8 out of 10.');
    expect(lines.some((l) => l.includes('em dash') || l.includes('—'))).toBe(false);

    expect(done.ok).toBe(true);
    expect(done.answer).toBe('ASSEMBLED ANSWER');
    expect(done.rounds).toBe(1);
    expect(done.outcome?.passed).toBe(true);
    expect(done.state.needsYourCall).toEqual([
      { id: 'q1', question: INTENT.needsUser[0], choices: [] },
    ]);
    expect(done.state.decisions).toEqual(INTENT.assumptions);
  });

  it('leads with the strongest model and hands the work itself to the cheap one', async () => {
    const { lines } = await pipeline();

    // claude is the strongest in the category, so it sets intent and merges.
    expect(sentTo('claude').some((p) => p.includes('Work out what a great result looks like'))).toBe(
      true,
    );
    expect(sentTo('claude').some((p) => p.includes('Turn the finished pieces below'))).toBe(true);
    // kimi wins on value, so it does the actual jobs.
    expect(lines).toContain('Kimi is taking on: Draft the sentence.');
    expect(lines).toContain('Kimi is taking on: Tighten the wording.');
  });

  it('gives each dispatch the brief and the rewritten prompt, not the whole history', async () => {
    await pipeline();
    const work = sentTo('kimi').filter((p) => p.includes('REWRITTEN INSTRUCTION'));

    expect(work).toHaveLength(2);
    expect(work[0]).toContain('What the user wants: Say in one plain sentence what a router does.');
    expect(work[0]).toContain('Exactly one sentence.');
    expect(work[0]).toContain('Already settled, do not reopen:');
    // The second job knows what the first one produced, as a summary.
    expect(work[1]).toContain('Work already finished by others:');
    expect(work[1]).toContain('WORK FROM kimi');
  });

  it('writes the state file as it goes', async () => {
    const { done } = await pipeline();
    const saved = readJson<TaskState | null>(taskStatePath(done.state.id), null);

    expect(saved?.status).toBe('done');
    expect(saved?.intent).toBe(INTENT.intent);
    expect(saved?.subtasks.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(saved?.subtasks[1].dependsOn).toEqual(['s1']);
    expect(saved?.results).toHaveLength(2);
    expect(saved?.reviewRounds).toHaveLength(1);
  });

  it('skips the split with simple, and still runs the review gate', async () => {
    const { lines, done } = await pipeline({ simple: true });

    expect(anyPrompt('Split the job below')).toBe(false);
    expect(lines).toContain('Small enough to do in one go.');
    expect(done.state.subtasks).toHaveLength(1);
    expect(done.outcome?.passed).toBe(true);
    expect(done.rounds).toBe(1);
  });

  it('sends only the gaps back round, then passes', async () => {
    scores = [8, 9.6];
    const { lines, done } = await pipeline();

    expect(lines).toContain('The review agents want 2 things fixed, so it goes back for another pass.');
    expect(anyPrompt('Say what it costs.')).toBe(true);
    expect(anyPrompt('judge scored this lowest')).toBe(true);
    expect(anyPrompt('The current work:\nASSEMBLED ANSWER')).toBe(true);
    expect(done.answer).toBe('FIXED ANSWER');
    expect(done.rounds).toBe(2);
    expect(done.outcome?.average).toBe(9.6);
    expect(done.outcome?.passed).toBe(true);
    expect(done.state.reviewRounds.map((r) => r.average)).toEqual([8, 9.6]);
  });

  it('stops once a pass comes back no better than the best one', async () => {
    // What a real run did: 7.6, then 6.9, then two more rounds to land lower
    // than it started. On work whose facts nobody can check the panel swings
    // instead of converging, and every swing costs minutes and money.
    scores = [7.6, 6.9, 8.5, 6.4];
    const { lines, done } = await pipeline();

    expect(done.rounds).toBe(2);
    expect(reviewCalls).toBe(10);
    // The first pass was the best, so that is the one that comes back.
    expect(done.answer).toBe('ASSEMBLED ANSWER');
    expect(done.outcome?.average).toBe(7.6);
    expect(done.state.status).toBe('needs-work');
    expect(lines.at(-1)).toContain('no better than the best pass');
  });

  it('keeps going while each pass is still an improvement', async () => {
    scores = [7.6, 8.5, 9.6];
    const { done } = await pipeline();

    expect(done.rounds).toBe(3);
    expect(done.outcome?.passed).toBe(true);
  });

  it('stops at the round cap and says what is still missing', async () => {
    scores = [8.2];
    const { lines, done } = await pipeline({ maxRounds: 2 });

    expect(done.rounds).toBe(2);
    expect(done.outcome?.passed).toBe(false);
    expect(done.outcome?.average).toBe(8.2);
    expect(done.outcome?.gaps).toEqual(['Say what it costs.']);
    expect(done.state.status).toBe('needs-work');
    expect(lines.at(-1)).toContain('best it got');
    expect(reviewCalls).toBe(10);
  });

  it('does not review work that never got done', async () => {
    const adapters = [
      {
        ...fake('claude'),
        async *run(task: string) {
          seen.push({ id: 'claude', prompt: task });
          const text = reply('claude', task);
          // The lead model answers; nobody can do the work itself.
          if (text === null || task.includes('REWRITTEN')) {
            yield { type: 'error' as const, message: 'no' };
            yield { type: 'result' as const, ok: false, text: '' };
            return;
          }
          yield { type: 'result' as const, ok: true, text };
        },
      },
    ];
    const events: PipelineEvent[] = [];
    for await (const ev of runPipeline('explain what a router does', {
      adapters,
      table: TABLE,
      available: new Set(['claude']),
      classification: CLASSIFICATION,
      simple: true,
    })) {
      events.push(ev);
    }

    const done = events.at(-1) as Extract<PipelineEvent, { type: 'done' }>;
    expect(done.ok).toBe(false);
    expect(done.outcome).toBe(null);
    expect(done.state.status).toBe('failed');
    expect(anyPrompt('You are one of five reviewers')).toBe(false);
  });
});

describe('small talk', () => {
  it('answers in one pass, with no planning and no review panel', async () => {
    const { done, lines } = await pipeline({
      classification: { ...CLASSIFICATION, difficulty: 'trivial', conversational: true },
    });

    expect(done.ok).toBe(true);
    expect(done.outcome).toBe(null);
    expect(done.rounds).toBe(0);
    expect(done.state.status).toBe('done');
    // The three stages that made a greeting cost a dozen model calls.
    expect(anyPrompt('You are one of five reviewers')).toBe(false);
    expect(anyPrompt('Work out what a great result looks like')).toBe(false);
    expect(anyPrompt('Break the job below')).toBe(false);
    expect(lines).not.toContain('Five review agents are going over the work.');
    expect(seen.length).toBe(1);
  });

  it('still runs the full pipeline for a small but real request', async () => {
    const { done } = await pipeline({
      classification: { ...CLASSIFICATION, conversational: false },
    });

    expect(done.outcome).not.toBe(null);
    expect(anyPrompt('You are one of five reviewers')).toBe(true);
  });
});
