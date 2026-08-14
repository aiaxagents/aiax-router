import type { Adapter } from '../adapters/types.js';
import { ask, asString, asStringList, bestCandidate, parseJsonObject } from './ask.js';
import { classify } from './classify.js';
import { distillEpisode, memoryBrief } from './memory.js';
import { MIN_JUDGE, reviewPanel, type ReviewOutcome } from './review.js';
import { routingOverride } from './override.js';
import { availability, routeTask, runWithFailover } from './router.js';
import { loadRoutingTable } from './routing-table.js';
import { EFFORT_BY_DIFFICULTY } from './select.js';
import { matchSkills, skillPreamble, type Skill } from './skills.js';
import {
  compactState,
  handoffBrief,
  newTaskState,
  oneLine,
  saveTaskState,
  DEFAULT_BRIEF_CHARS,
  DEFAULT_STATE_BUDGET,
  type Choice,
  type Subtask,
  type SubtaskResult,
  type TaskQuestion,
  type TaskState,
} from './taskstate.js';
import type {
  Candidate,
  Category,
  Classification,
  Decision,
  Difficulty,
  RoutingTable,
} from './types.js';

export const DEFAULT_MAX_ROUNDS = 4;
/** Two at a time: parallel enough to be quick, gentle enough on a subscription. */
const CONCURRENCY = 2;
const MAX_SUBTASKS = 6;

export interface PipelineOptions {
  /** One subtask instead of a split, review gate still on. */
  simple?: boolean;
  maxRounds?: number;
  cwd?: string;
  timeoutMs?: number;
  adapters?: Adapter[];
  table?: RoutingTable;
  available?: Set<string>;
  classification?: Classification;
  stateBudget?: number;
  briefChars?: number;
  /** Reuse an id the caller already showed the user, instead of minting a new one. */
  id?: string;
  /**
   * Put the open questions to the person and wait. Returns the answer per question
   * id. Left out (the CLI) the run carries on and the questions are reported at the end.
   */
  decide?: (questions: TaskQuestion[]) => Promise<Record<string, string>>;
}

export type PipelineEvent =
  | { type: 'progress'; message: string }
  | {
      type: 'done';
      ok: boolean;
      answer: string;
      state: TaskState;
      outcome: ReviewOutcome | null;
      rounds: number;
    };

const CATEGORY_SET: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];
const DIFFICULTY_SET: Difficulty[] = ['trivial', 'easy', 'medium', 'hard'];

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    }),
  );
  return out;
}

/** Groups subtasks so everything in a group can run at the same time. */
function waves(subtasks: Subtask[]): Subtask[][] {
  const known = new Set(subtasks.map((s) => s.id));
  const finished = new Set<string>();
  let left = [...subtasks];
  const out: Subtask[][] = [];
  while (left.length) {
    const ready = left.filter((s) =>
      s.dependsOn.every((d) => finished.has(d) || !known.has(d)),
    );
    // A dependency loop must not hang the run, so a stuck remainder goes together.
    const wave = ready.length ? ready : left;
    for (const s of wave) finished.add(s.id);
    left = left.filter((s) => !wave.includes(s));
    out.push(wave);
  }
  return out;
}

// --- stage prompts -----------------------------------------------------------

/** No JSON contract here: the reply is shown to the person exactly as it comes back. */
function lightPrompt(task: string, skills: Skill[]): string {
  return `${skillPreamble(skills)}Answer the question below properly, in the language it was asked in.

Nobody checks this after you, so say plainly where you are unsure or could not verify something, rather than putting a guess in the same voice as a fact.

Give the answer itself, with no preamble about what you are about to do. Lay it out to be read: short paragraphs, a short list where a list genuinely helps, bold on the thing that matters most, and headings only if there are really several sections. Where a link, an address or a phone number belongs in the answer, put it there.

The question:
${task}`;
}

function conversationalPrompt(task: string): string {
  return `Someone is talking to you in a chat app. Reply in one or two short sentences, warmly and plainly, in the same language they used. No lists, no headings, no code, no preamble about what you are about to do.

They said:
${task}`;
}

function intentPrompt(task: string, memory = ''): string {
  const known = memory
    ? `\nWhat is already known about this person and their work, from earlier tasks. Respect it, and never ask about anything it already answers:\n${memory}\n`
    : '';
  return `You are the lead on the job below. Work out what a great result looks like before anyone starts.

Settle every ambiguity yourself, taking the most reasonable reading, and write down each thing you decided. Only put something in "needsUser" when it truly cannot be settled without the person who asked: a personal preference, a fact only they hold, or a step that cannot be undone.

The request:
${task}
${known}
Every question you do ask comes with two to four answers to pick from. Each answer has a short label and one sentence saying what picking it means in ordinary words. Mark the one you would go with as the recommended one.

Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"intent":"one or two sentences saying what the finished work must do","acceptance":["a short criterion anyone can check"],"assumptions":["what you decided, and why"],"needsUser":[{"question":"one short question in plain words","choices":[{"label":"under four words","means":"one sentence on what this means","recommended":true}]}]}
Give two to five acceptance criteria. Leave a list empty when you have nothing for it.`;
}

function decomposePrompt(state: TaskState): string {
  return `Split the job below into the fewest steps that still cover all of it. Use one step when the job is small. Never go past ${MAX_SUBTASKS} steps.

Each step must stand on its own: someone reading only that step, plus the goal, has to be able to do it. Say which earlier steps a step needs, by their number, and leave that empty when a step can start straight away.

Goal: ${state.intent}

It is done when:
${state.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}

The original request:
${state.task}

Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"subtasks":[{"title":"under eight words","task":"the full instruction for this step","category":"coding|agentic-coding|reasoning|writing|chat|long-context","difficulty":"trivial|easy|medium|hard","dependsOn":[1]}]}`;
}

function rewritePrompt(subtask: Subtask, decision: Decision): string {
  return `Rewrite the instruction below so it works as well as possible for ${decision.provider} ${decision.model}, which is the model that will carry it out.

Keep every requirement and every constraint. Add the structure and level of detail that model responds to best. Do not do the work yourself and do not answer the instruction.

The instruction:
${subtask.task}

Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"prompt":"the rewritten instruction"}`;
}

function assemblePrompt(state: TaskState): string {
  const pieces = state.results
    .map((r) => `--- ${r.title} ---\n${r.text || r.summary}`)
    .join('\n\n');
  return `Turn the finished pieces below into the one deliverable the person asked for.

Use only what the pieces contain. Resolve any contradiction between them, cut repetition, and make sure every criterion is met. Write the deliverable itself, with no preamble about what you did. The answer is shown as markdown: when it is code or contains code, wrap that code in a fenced code block tagged with its language.

Goal: ${state.intent}

It is done when:
${state.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}

${pieces}

Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"answer":"the finished deliverable"}`;
}

function revisionPrompt(state: TaskState, work: string, gaps: string[]): string {
  return `Reviewers found the problems listed below in this work. Fix exactly those and change nothing else.

Goal: ${state.intent}

It is done when:
${state.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}

Problems to fix:
${gaps.map((g) => `  - ${g}`).join('\n')}

The current work:
${work}

Fix the problems without adding new caveats, sections, or disclaimers. If a problem says something
is too complex or too long, cut rather than explain. The corrected work must be no longer than the
current work unless a problem explicitly asks for more.

Return the complete corrected work and nothing else. No notes about what you changed.`;
}

// --- pipeline ----------------------------------------------------------------

interface Prepared {
  subtask: Subtask;
  decision: Decision;
  skills: Skill[];
  prompt: string;
}

function progress(message: string): PipelineEvent {
  return { type: 'progress', message };
}

function classificationOf(subtask: Subtask): Classification {
  return {
    category: subtask.category,
    difficulty: subtask.difficulty,
    rationale: 'Set when the job was split up.',
    via: 'model',
    // A step of a full job is part of a work product, whatever its own size.
    weight: 'full',
  };
}

function singleSubtask(state: TaskState, classification: Classification): Subtask {
  return {
    id: 's1',
    title: 'The whole job',
    task: state.task,
    category: classification.category,
    difficulty: classification.difficulty,
    dependsOn: [],
  };
}

function parseSubtasks(obj: Record<string, unknown> | null, fallback: Subtask): Subtask[] {
  const list = Array.isArray(obj?.subtasks) ? (obj.subtasks as unknown[]) : [];
  const out: Subtask[] = [];
  for (const entry of list.slice(0, MAX_SUBTASKS)) {
    const row = entry as Record<string, unknown>;
    const task = asString(row.task);
    if (!task) continue;
    const category = row.category as Category;
    const difficulty = row.difficulty as Difficulty;
    const index = out.length + 1;
    out.push({
      id: `s${index}`,
      title: asString(row.title, `Step ${index}`),
      task,
      category: CATEGORY_SET.includes(category) ? category : fallback.category,
      difficulty: DIFFICULTY_SET.includes(difficulty) ? difficulty : fallback.difficulty,
      dependsOn: (Array.isArray(row.dependsOn) ? row.dependsOn : [])
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 1 && d < index)
        .map((d) => `s${d}`),
    });
  }
  return out.length ? out : [fallback];
}

function parseChoices(value: unknown): Choice[] {
  if (!Array.isArray(value)) return [];
  const out: Choice[] = [];
  for (const entry of value.slice(0, 4)) {
    const row = entry as Record<string, unknown>;
    const label = typeof entry === 'string' ? entry : asString(row?.label);
    if (!label) continue;
    out.push({
      label,
      means: typeof entry === 'string' ? '' : asString(row?.means),
      ...(row?.recommended === true ? { recommended: true } : {}),
    });
  }
  return out;
}

/** A service name the way a person says it, not the id the code carries. */
function named(provider: string): string {
  if (provider === 'codex') return 'ChatGPT';
  return provider ? provider[0].toUpperCase() + provider.slice(1) : provider;
}

/** Tolerates the older shape where a question was just a string. */
export function parseQuestions(value: unknown, limit = 4): TaskQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: TaskQuestion[] = [];
  for (const entry of value.slice(0, limit)) {
    const row = entry as Record<string, unknown>;
    const question = typeof entry === 'string' ? entry : asString(row?.question);
    if (!question) continue;
    out.push({ id: `q${out.length + 1}`, question, choices: parseChoices(row?.choices) });
  }
  return out;
}

export async function* runPipeline(
  task: string,
  opts: PipelineOptions = {},
): AsyncGenerator<PipelineEvent> {
  const table = opts.table ?? loadRoutingTable();
  const available = opts.available ?? (await availability(opts.adapters)).available;
  const maxRounds = Math.min(Math.max(Math.trunc(opts.maxRounds ?? DEFAULT_MAX_ROUNDS), 1), 10);
  const budget = opts.stateBudget ?? DEFAULT_STATE_BUDGET;
  const briefChars = opts.briefChars ?? DEFAULT_BRIEF_CHARS;

  const state = newTaskState(task, opts.id);
  saveTaskState(state);

  const classification =
    opts.classification ?? (await classify(task, available, table, opts.adapters));
  const lead: Candidate | undefined = bestCandidate(available, table, classification.category);
  const leadEffort = routingOverride()?.effort ?? EFFORT_BY_DIFFICULTY[classification.difficulty];

  // Small talk has no deliverable, so planning it, splitting it and putting five
  // judges on it is pure ceremony. One model, one pass, straight back.
  if (classification.weight === 'conversational') {
    state.intent = task;
    state.acceptanceCriteria = ['A short, friendly reply.'];
    let reply = '';
    if (lead) {
      const { ok, text } = await ask(lead, conversationalPrompt(task), {
        effort: 'low',
        timeoutMs: opts.timeoutMs,
        adapters: opts.adapters,
        cwd: opts.cwd,
        role: 'planning',
      });
      if (ok) reply = text.trim();
    }
    if (!reply) {
      // Nothing was free to answer, so the pipeline is the wrong tool to fail in.
      reply = 'I am here. Tell me what you would like done.';
    }
    state.status = 'done';
    state.results.push({
      id: 'reply',
      title: 'Reply',
      provider: lead?.provider ?? '',
      model: lead?.model ?? '',
      ok: true,
      summary: oneLine(reply),
      text: reply,
    });
    saveTaskState(state);
    yield { type: 'done', ok: true, answer: reply, state, outcome: null, rounds: 0 };
    return;
  }

  // One good answer settles this. Splitting it, briefing a model on its own
  // rewritten instruction and then convening five judges to argue about a
  // recommendation is where the twenty minutes went, and none of it made the
  // answer better. So the quality is bought where it shows: the strongest model
  // this category has, the skills that fit, and one pass.
  if (classification.weight === 'light') {
    const skills = matchSkills(task, classification.category);
    state.intent = task;
    state.acceptanceCriteria = ['One answer that settles the question.'];
    for (const skill of skills) yield progress(`Using skill: ${skill.name}.`);

    let answer = '';
    let provider = '';
    let model = '';
    let ok = false;
    for await (const ev of runWithFailover(lightPrompt(task, skills), {
      adapters: opts.adapters,
      table,
      available,
      classification,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    })) {
      if (ev.type === 'decision') {
        provider = ev.decision.provider;
        model = ev.decision.model;
        if (ev.attempt === 1) yield progress(`${named(provider)} is answering this one.`);
      } else if (ev.type === 'failover') {
        yield progress(ev.message);
      } else if (ev.type === 'text') answer += ev.chunk;
      else if (ev.type === 'result') {
        ok = ev.ok;
        if (ev.text) answer = ev.text;
      }
    }
    answer = answer.trim();

    if (!ok || !answer) {
      state.status = 'needs-work';
      saveTaskState(state);
      yield { type: 'done', ok: false, answer: '', state, outcome: null, rounds: 0 };
      return;
    }
    state.status = 'done';
    state.results.push({
      id: 'answer',
      title: 'The answer',
      provider,
      model,
      ok: true,
      summary: oneLine(answer),
      text: answer,
    });
    saveTaskState(state);
    await distillEpisode(state, { available, table, adapters: opts.adapters });
    yield { type: 'done', ok: true, answer, state, outcome: null, rounds: 0 };
    return;
  }

  const askLead = async (prompt: string): Promise<Record<string, unknown> | null> => {
    if (!lead) return null;
    const { ok, text } = await ask(lead, prompt, {
      effort: leadEffort,
      timeoutMs: opts.timeoutMs,
      adapters: opts.adapters,
      cwd: opts.cwd,
      role: 'planning',
    });
    return ok ? parseJsonObject(text) : null;
  };

  // 1. Intent. The strongest model in the category settles what "done" means.
  // Durable memory rides in here, within its own fixed byte budget.
  yield progress('Working out what you actually want.');
  const intent = await askLead(intentPrompt(task, memoryBrief(classification)));
  state.intent = asString(intent?.intent, task);
  state.acceptanceCriteria = asStringList(intent?.acceptance, 6);
  if (state.acceptanceCriteria.length === 0) {
    state.acceptanceCriteria = ['The answer does what was asked, and nothing is missing.'];
  }
  state.decisions = asStringList(intent?.assumptions, 8);
  state.needsYourCall = parseQuestions(intent?.needsUser);
  saveTaskState(state);
  yield progress(`Here is the aim: ${oneLine(state.intent, 160)}`);

  // 1b. Anything only the person can settle goes to them before any work starts.
  if (opts.decide && state.needsYourCall.length) {
    yield progress(
      state.needsYourCall.length === 1
        ? 'One thing needs your call before I start.'
        : `${state.needsYourCall.length} things need your call before I start.`,
    );
    const answers = await opts.decide(state.needsYourCall);
    for (const q of state.needsYourCall) {
      const answer = asString(answers[q.id]);
      if (!answer) continue;
      q.answer = answer;
      state.decisions.push(`${q.question} You said: ${answer}`);
    }
    saveTaskState(state);
    yield progress('Got it, carrying on.');
  }

  // 2. Decompose.
  const whole = singleSubtask(state, classification);
  if (opts.simple) {
    state.subtasks = [whole];
    yield progress('Small enough to do in one go.');
  } else {
    state.subtasks = parseSubtasks(await askLead(decomposePrompt(state)), whole);
    yield progress(
      state.subtasks.length === 1
        ? 'Small enough to do in one go.'
        : `Breaking this into ${state.subtasks.length} smaller jobs.`,
    );
  }
  saveTaskState(state);

  // 3. Route, rewrite and run. Independent jobs go two at a time.
  const prepare = async (subtask: Subtask): Promise<Prepared> => {
    const { decision } = await routeTask(subtask.task, available, {
      adapters: opts.adapters,
      table,
      classification: classificationOf(subtask),
    });
    const skills = matchSkills(subtask.task, subtask.category);
    const rewritten = await askLead(rewritePrompt(subtask, decision));
    const body = asString(rewritten?.prompt, subtask.task);
    const brief = handoffBrief(state, briefChars, subtask);
    return {
      subtask,
      decision,
      skills,
      prompt: `${skillPreamble(skills)}${brief}\n\n---\n\n${body}`,
    };
  };

  const execute = async (p: Prepared): Promise<{ result: SubtaskResult; notes: string[] }> => {
    let provider = p.decision.provider;
    let model = p.decision.model;
    let text = '';
    let ok = false;
    const notes: string[] = [];
    for await (const ev of runWithFailover(p.prompt, {
      adapters: opts.adapters,
      table,
      available,
      classification: classificationOf(p.subtask),
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    })) {
      if (ev.type === 'decision') {
        provider = ev.decision.provider;
        model = ev.decision.model;
      } else if (ev.type === 'failover') {
        notes.push(ev.message);
      } else if (ev.type === 'text') text += ev.chunk;
      else if (ev.type === 'result') {
        ok = ev.ok;
        if (ev.text) text = ev.text;
      }
    }
    return {
      result: {
        id: p.subtask.id,
        title: p.subtask.title,
        provider,
        model,
        ok,
        summary: oneLine(text),
        text: text.trim(),
      },
      notes,
    };
  };

  for (const wave of waves(state.subtasks)) {
    const prepared = await mapLimit(wave, CONCURRENCY, prepare);
    for (const p of prepared) {
      yield progress(`${named(p.decision.provider)} is taking on: ${p.subtask.title}.`);
      for (const skill of p.skills) yield progress(`Using skill: ${skill.name}.`);
    }
    const done = await mapLimit(prepared, CONCURRENCY, execute);
    for (const { result: r, notes } of done) {
      for (const note of notes) yield progress(note);
      state.results.push(r);
      yield progress(r.ok ? `Done: ${r.title}.` : `${r.title} did not work out.`);
    }
    saveTaskState(state);

    const compacted = await compactState(state, {
      budget,
      available,
      table,
      adapters: opts.adapters,
    });
    if (compacted !== 'none') {
      yield progress('Tidying my notes so nothing important gets lost.');
      saveTaskState(state);
    }
  }

  if (!state.results.some((r) => r.ok)) {
    state.status = 'failed';
    saveTaskState(state);
    yield progress('This one did not get done.');
    yield {
      type: 'done',
      ok: false,
      answer: state.results.map((r) => r.text).join('\n\n').trim(),
      state,
      outcome: null,
      rounds: 0,
    };
    return;
  }

  // 4. Assemble against the acceptance criteria.
  yield progress('Putting it all together.');
  let answer = state.results
    .filter((r) => r.ok)
    .map((r) => r.text)
    .join('\n\n')
    .trim();
  if (lead) {
    const { ok, text } = await ask(lead, assemblePrompt(state), {
      effort: leadEffort,
      timeoutMs: opts.timeoutMs,
      adapters: opts.adapters,
      cwd: opts.cwd,
      role: 'planning',
    });
    if (ok) {
      const merged = asString(parseJsonObject(text)?.answer) || text.trim();
      if (merged) answer = merged;
    }
  }

  // 5. Review, and send only the gaps back round.
  let outcome: ReviewOutcome | null = null;
  let best: { answer: string; outcome: ReviewOutcome | null } = { answer, outcome: null };
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    yield progress('Five review agents are going over the work.');
    outcome = await reviewPanel({
      intent: state.intent,
      acceptanceCriteria: state.acceptanceCriteria,
      work: answer,
      category: classification.category,
      difficulty: classification.difficulty,
      available,
      table,
      adapters: opts.adapters,
    });
    state.reviewRounds.push({
      round,
      average: outcome.average,
      scores: outcome.scores,
      gaps: outcome.gaps,
    });
    saveTaskState(state);

    if (!outcome.reviewed) {
      yield progress('No review agent was free just now, so nothing has checked this.');
      best = { answer, outcome };
      break;
    }
    const bestSoFar = best.outcome?.average ?? -1;
    if (!best.outcome || outcome.average > best.outcome.average) best = { answer, outcome };
    if (outcome.passed) {
      yield progress(`The review agents are happy with it, ${outcome.average} out of 10.`);
      break;
    }
    if (round === maxRounds) {
      yield progress(
        `After ${maxRounds} ${maxRounds === 1 ? 'try' : 'tries'} this is the best it got, and I will tell you straight what is still off.`,
      );
      break;
    }
    // A pass that scored no better than the best so far means the panel has
    // stopped converging, and on work whose facts nobody can check it will
    // swing up and down forever. Each further round costs minutes and money to
    // end up somewhere already seen, so this is where it stops.
    if (outcome.average <= bestSoFar) {
      yield progress(
        `Round ${round} came back no better than the best pass, so another round would only cost time.`,
      );
      break;
    }

    const gaps = [
      ...(outcome.gaps.length
        ? outcome.gaps
        : outcome.scores.filter((s) => s.score < 10).map((s) => s.note)),
    ];
    // The harshest judge decides whether the round passes, so their complaint
    // always travels with the fix, even when the panel's gap list skipped it.
    const lowest = [...outcome.scores].sort((a, b) => a.score - b.score)[0];
    if (lowest && lowest.score <= MIN_JUDGE && lowest.note && !gaps.includes(lowest.note)) {
      gaps.push(`The ${lowest.lens} judge scored this lowest (${lowest.score}): ${lowest.note}`);
    }
    yield progress(
      `The review agents want ${gaps.length} ${gaps.length === 1 ? 'thing' : 'things'} fixed, so it goes back for another pass.`,
    );

    const fix = revisionPrompt(state, answer, gaps);
    let fixed = '';
    let fixedOk = false;
    for await (const ev of runWithFailover(fix, {
      adapters: opts.adapters,
      table,
      available,
      classification,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    })) {
      if (ev.type === 'decision' && ev.attempt === 1) {
        yield progress(`${named(ev.decision.provider)} is fixing what the review agents flagged.`);
      } else if (ev.type === 'failover') {
        yield progress(ev.message);
      } else if (ev.type === 'text') fixed += ev.chunk;
      else if (ev.type === 'result') {
        fixedOk = ev.ok;
        if (ev.text) fixed = ev.text;
      }
    }
    if (!fixedOk || !fixed.trim()) {
      yield progress('That fixing pass did not work out, so this is where it stands.');
      break;
    }
    answer = fixed.trim();
    state.results.push({
      id: `fix-${round}`,
      title: `Fixes after round ${round}`,
      provider: '',
      model: '',
      ok: true,
      summary: oneLine(answer),
      text: answer,
    });
    await compactState(state, { budget, available, table, adapters: opts.adapters });
    saveTaskState(state);
  }

  // `best` already holds the highest-scoring round, so a later, worse pass never wins.
  const final = best.outcome ? best : { answer, outcome };
  state.status = final.outcome?.passed ? 'done' : 'needs-work';
  saveTaskState(state);

  // The task is complete: a cheap-model pass notes anything durable. It skips
  // silently when no model is free and can never fail the task.
  await distillEpisode(state, { available, table, adapters: opts.adapters });

  yield {
    type: 'done',
    ok: true,
    answer: final.answer,
    state,
    outcome: final.outcome,
    rounds,
  };
}
