import { adapters as realAdapters } from '../adapters/index.js';
import type { Adapter } from '../adapters/types.js';
import { CATEGORIES, ask, cheapestCandidate, firstJsonObject } from './ask.js';
import type { Category, Classification, Difficulty, RoutingTable } from './types.js';

/** One signal per category. Most hits wins; ties go to the earlier entry. */
const SIGNALS: { category: Category; re: RegExp }[] = [
  {
    category: 'coding',
    re: /\b(fix|bug|crash|refactor|implement|function|method|class|variable|rename|test|tests|compile|build error|lint|type ?error|stack ?trace|api|endpoint|regex|sql|query|typescript|javascript|python|rust|golang|java|swift|css|html|async|import|dependency|patch|diff)\b/gi,
  },
  {
    category: 'reasoning',
    re: /\b(why|prove|proof|compare|explain|analy[sz]e|architecture|design|trade-?offs?|complexity|evaluate|derive|root cause|decide|pros and cons)\b|O\(/gi,
  },
  {
    category: 'writing',
    re: /\b(write|draft|blog|email|article|haiku|poem|summary|summari[sz]e|newsletter|headline|copy|caption|rewrite|proofread|translate)\b/gi,
  },
  {
    category: 'long-context',
    re: /\b(this document|the attached|attached file|transcript|whole file|entire (file|repo|codebase|document)|these logs|this paper)\b/gi,
  },
];

/** Turns a plain coding ask into a repo-wide, multi-step one. */
const AGENTIC = /\b(build|create (an? )?(app|site|service|project)|project|repo|repository|migrate|set up|scaffold|deploy|wire up|across the codebase)\b|\bin this repo\b|\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|c|cpp|cs|swift|kt|sh|sql|json|ya?ml|md)\b/i;

const HARD =
  /\b(architecture|prove|security audit|threat model|end[- ]to[- ]end|multi[- ]?file|from scratch|refactor the (whole|entire)|migration plan|scal(e|ing) to)\b/i;
const TRIVIAL = /^\s*(what is|what's|who is|when is|rename|typo|fix the typo|spell)\b/i;

const LONG_PASTE = 8_000;

function countHits(task: string, re: RegExp): number {
  return task.match(re)?.length ?? 0;
}

function pickCategory(task: string): Category {
  if (task.length > LONG_PASTE) return 'long-context';

  let best: Category = 'chat';
  let bestHits = 0;
  for (const { category, re } of SIGNALS) {
    const hits = countHits(task, re);
    if (hits > bestHits) {
      best = category;
      bestHits = hits;
    }
  }
  if (best === 'coding' && AGENTIC.test(task)) return 'agentic-coding';
  return best;
}

function pickDifficulty(task: string, category: Category): Difficulty {
  if (HARD.test(task) || task.length > 600) return 'hard';
  if (TRIVIAL.test(task) && task.length < 120) return 'trivial';
  if ((category === 'chat' || category === 'writing') && task.length < 200) return 'easy';
  return 'medium';
}

const JOB: Record<Category, string> = {
  coding: 'a coding task',
  'agentic-coding': 'a multi-step coding task',
  reasoning: 'a thinking task',
  writing: 'a writing task',
  chat: 'a plain question',
  'long-context': 'a long-document task',
};

const SIZE: Record<Difficulty, string> = {
  trivial: 'tiny',
  easy: 'small',
  medium: 'normal-sized',
  hard: 'hard',
};

/**
 * Keyword heuristic. Cheap and offline: it runs before any model is picked,
 * so it must never itself need a model, and it is the fallback whenever the
 * model-based classifier cannot answer.
 */
export function classifyHeuristic(task: string): Classification {
  const category = pickCategory(task);
  const difficulty = pickDifficulty(task, category);
  return {
    category,
    difficulty,
    rationale: `Reads like ${JOB[category]}, and a ${SIZE[difficulty]} one.`,
    via: 'heuristic',
  };
}

const DIFFICULTIES: Difficulty[] = ['trivial', 'easy', 'medium', 'hard'];

/** Above this the classifier only sees the head of the task; length still reaches the heuristic. */
const PROMPT_CHARS = 4_000;
const CLASSIFY_TIMEOUT_MS = 30_000;

function prompt(task: string): string {
  const body =
    task.length > PROMPT_CHARS
      ? `${task.slice(0, PROMPT_CHARS)}\n[truncated, ${task.length} characters total]`
      : task;
  return `Classify the task below for a model router.
Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"category":"coding|agentic-coding|reasoning|writing|chat|long-context","difficulty":"trivial|easy|medium|hard","rationale":"under 12 words"}

Task:
${body}`;
}

export function parseClassification(raw: string): Classification | null {
  const block = firstJsonObject(raw ?? '');
  if (!block) return null;
  let obj: any;
  try {
    obj = JSON.parse(block);
  } catch {
    return null;
  }
  if (!CATEGORIES.includes(obj?.category) || !DIFFICULTIES.includes(obj?.difficulty)) return null;
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : '';
  return {
    category: obj.category,
    difficulty: obj.difficulty,
    rationale: rationale || 'Classified by a cheap model.',
    via: 'model',
  };
}

/**
 * Ask the cheapest available model what kind of task this is. Any stumble
 * (nothing cheap available, timeout, unusable answer, provider out of quota)
 * falls back to the keyword heuristic, so routing never depends on this working.
 */
export async function classify(
  task: string,
  available: Set<string>,
  table: RoutingTable,
  list: Adapter[] = realAdapters,
): Promise<Classification> {
  const candidate = cheapestCandidate(available, table);
  if (!candidate) return classifyHeuristic(task);

  const { ok, text } = await ask(candidate, prompt(task), {
    effort: 'low',
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    adapters: list,
  });
  if (!ok) return classifyHeuristic(task);
  return parseClassification(text) ?? classifyHeuristic(task);
}
