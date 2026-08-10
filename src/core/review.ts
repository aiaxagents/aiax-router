import type { Adapter } from '../adapters/types.js';
import { ask, asString, asStringList, parseJsonObject } from './ask.js';
import type { Candidate, Category, Difficulty, RoutingTable } from './types.js';

/** The bar a deliverable has to clear. It does not move with difficulty. */
export const PASS_MARK = 9.5;
/** No judge may sit at this or below for the work to pass. */
export const MIN_JUDGE = 9;

export interface Lens {
  id: string;
  name: string;
  brief: string;
}

export const LENSES: Lens[] = [
  {
    id: 'correctness',
    name: 'correctness',
    brief: 'Is every claim true, and does the work actually do what it says it does?',
  },
  {
    id: 'completeness',
    name: 'completeness',
    brief: 'Does it meet the goal and every single criterion, with nothing left out?',
  },
  {
    id: 'quality',
    name: 'quality and style',
    brief: 'Is it well made, clearly written and pitched right for whoever reads it?',
  },
  {
    id: 'robustness',
    name: 'robustness and safety',
    brief: 'What breaks, what is unsafe, and which edge case has been ignored?',
  },
  {
    id: 'simplicity',
    name: 'simplicity',
    brief: 'Is anything unnecessary, over-built, repeated or padded out?',
  },
];

export interface ReviewScore {
  lens: string;
  provider: string;
  model: string;
  score: number;
  note: string;
}

export interface ReviewOutcome {
  average: number;
  scores: ReviewScore[];
  gaps: string[];
  passed: boolean;
  /** False when not one reviewer could be reached, which is not the same as a bad score. */
  reviewed: boolean;
}

const REVIEW_TIMEOUT_MS = 120_000;
const WORK_CHARS = 12_000;
const MAX_GAPS = 6;

/**
 * Reviewers are spread over as many different providers as there are, so the
 * panel does not share one model's blind spots. Easy work gets the cheap seats,
 * hard work gets the strong ones.
 */
export function reviewerPool(
  available: Set<string>,
  table: RoutingTable,
  category: Category,
  difficulty: Difficulty,
): Candidate[] {
  const strong = difficulty === 'hard' || difficulty === 'medium';
  const sorted = (table.categories[category] ?? [])
    .filter((c) => available.has(c.provider))
    .sort((a, b) =>
      strong ? b.score - a.score : a.costWeight - b.costWeight || b.score - a.score,
    );

  const spread: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const c of sorted) {
    if (spread.some((s) => s.provider === c.provider)) rest.push(c);
    else spread.push(c);
  }
  return [...spread, ...rest];
}

function prompt(lens: Lens, intent: string, criteria: string[], work: string): string {
  const body = work.length > WORK_CHARS ? `${work.slice(0, WORK_CHARS)}\n[cut short here]` : work;
  return `You are one of five reviewers checking a finished piece of work. Your lens is ${lens.name}: ${lens.brief}
Judge through that lens only, and leave the other four lenses to the other reviewers.

What was asked for: ${intent}

It is done when:
${criteria.map((c) => `  - ${c}`).join('\n')}

The work:
${body}

Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"score":9.5,"note":"one sentence saying why","gaps":["one concrete fix"]}
Score from 1 to 10, one decimal at most. Give 10 only if you would ship it exactly as it is. Every point you take off needs a matching gap, written as one short instruction someone can act on. Use an empty list when there is nothing to fix.`;
}

function parseScore(raw: string): { score: number; note: string; gaps: string[] } | null {
  const obj = parseJsonObject(raw);
  const value = Number(obj?.score);
  if (!obj || !Number.isFinite(value)) return null;
  return {
    score: Math.min(10, Math.max(1, value)),
    note: asString(obj.note, 'No reason given.'),
    gaps: asStringList(obj.gaps, MAX_GAPS),
  };
}

export async function reviewPanel(input: {
  intent: string;
  acceptanceCriteria: string[];
  work: string;
  category: Category;
  difficulty: Difficulty;
  available: Set<string>;
  table: RoutingTable;
  adapters?: Adapter[];
}): Promise<ReviewOutcome> {
  const pool = reviewerPool(input.available, input.table, input.category, input.difficulty);
  const empty: ReviewOutcome = {
    average: 0,
    scores: [],
    gaps: [],
    passed: false,
    reviewed: false,
  };
  if (pool.length === 0) return empty;

  const effort = input.difficulty === 'hard' ? 'medium' : 'low';
  const answers = await Promise.all(
    LENSES.map(async (lens, i) => {
      const candidate = pool[i % pool.length];
      const { ok, text } = await ask(
        candidate,
        prompt(lens, input.intent, input.acceptanceCriteria, input.work),
        { effort, timeoutMs: REVIEW_TIMEOUT_MS, adapters: input.adapters, role: 'review' },
      );
      const parsed = ok ? parseScore(text) : null;
      if (!parsed) return null;
      return {
        lens: lens.name,
        provider: candidate.provider,
        model: candidate.model,
        ...parsed,
      };
    }),
  );

  const scores = answers.filter((a): a is ReviewScore & { gaps: string[] } => a !== null);
  if (scores.length === 0) return empty;

  const average = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const gaps: string[] = [];
  for (const s of scores) {
    if (s.score >= 10) continue;
    for (const gap of s.gaps) {
      if (!gaps.some((g) => g.toLowerCase() === gap.toLowerCase())) gaps.push(gap);
    }
  }

  return {
    average: Math.round(average * 100) / 100,
    scores: scores.map(({ lens, provider, model, score, note }) => ({
      lens,
      provider,
      model,
      score,
      note,
    })),
    gaps: gaps.slice(0, MAX_GAPS),
    // Passing needs the panel happy on average AND no single judge at 9 or
    // below: one unhappy judge means something concrete is still wrong.
    passed: average >= PASS_MARK && scores.every((s) => s.score > MIN_JUDGE),
    reviewed: true,
  };
}
