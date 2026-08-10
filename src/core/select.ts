import { routingOverride } from './override.js';
import type {
  Candidate,
  Category,
  Classification,
  Decision,
  Difficulty,
  Effort,
  RoutingTable,
} from './types.js';

const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh'];

export const EFFORT_BY_DIFFICULTY: Record<Difficulty, Effort> = {
  trivial: 'low',
  easy: 'low',
  medium: 'medium',
  hard: 'high',
};

/** Below this, a provider is close enough to its subscription cap to skip. */
const HEADROOM_FLOOR = 0.05;

const JOB: Record<Category, string> = {
  coding: 'coding job',
  'agentic-coding': 'multi-step coding job',
  reasoning: 'thinking job',
  writing: 'writing job',
  chat: 'question',
  'long-context': 'long-document job',
};

const SIZE: Record<Difficulty, string> = {
  trivial: 'Tiny',
  easy: 'Easy',
  medium: 'Ordinary',
  hard: 'Hard',
};

function clampEffort(want: Effort, max: Effort | undefined): Effort {
  if (!max) return want;
  return EFFORT_ORDER.indexOf(want) > EFFORT_ORDER.indexOf(max) ? max : want;
}

/** Quality per unit of subscription burned, nudged by how much quota is left. */
function roi(c: Candidate, headroom: number): number {
  const spend = c.tokensPerTask * Math.max(c.costWeight, 0.25);
  return (c.score / spend) * (0.5 + 0.5 * headroom);
}

function altReason(alt: Candidate, best: Candidate): string {
  if (alt.score > best.score) return 'stronger, but costs more';
  if (alt.costWeight < best.costWeight) return 'cheaper, but weaker';
  return 'similar quality, worse value';
}

export function select(input: {
  classification: Classification;
  table: RoutingTable;
  available: Set<string>;
  headroom: (provider: string) => number;
}): Decision | null {
  const { classification, table, available, headroom } = input;
  const { category, difficulty } = classification;

  // A pinned choice beats every calculation, as long as that tool can take work.
  const pinned = routingOverride();
  if (pinned && available.has(pinned.provider)) {
    return {
      provider: pinned.provider,
      model: pinned.model,
      effort: pinned.effort,
      rationale: `You set ${pinned.provider}/${pinned.model} on ${pinned.effort} effort yourself.`,
      rankedAlternatives: [],
    };
  }

  const pool = (table.categories[category] ?? []).filter((c) => available.has(c.provider));
  if (pool.length === 0) return null;

  const adequate = pool.filter((c) => c.score >= table.difficultyFloor[difficulty]);
  const belowBar = adequate.length === 0;

  const withQuota = (belowBar ? pool : adequate).filter((c) => headroom(c.provider) >= HEADROOM_FLOOR);
  const outOfQuota = withQuota.length === 0;
  const ranked = outOfQuota ? (belowBar ? pool : adequate) : withQuota;

  // Below the bar we are already compromising, so take the strongest model
  // rather than the best deal.
  const sorted = [...ranked].sort((a, b) =>
    belowBar ? b.score - a.score : roi(b, headroom(b.provider)) - roi(a, headroom(a.provider)),
  );

  const best = sorted[0];
  const effort = clampEffort(EFFORT_BY_DIFFICULTY[difficulty], best.maxEffort);

  let rationale = `${SIZE[difficulty]} ${JOB[category]}, so this goes to ${best.provider}/${best.model} on ${effort} effort`;
  if (belowBar) rationale += ', the best available, below the ideal bar';
  if (outOfQuota) rationale += ', and every provider is low on quota';

  return {
    provider: best.provider,
    model: best.model,
    effort,
    rationale: `${rationale}.`,
    rankedAlternatives: sorted.slice(1, 3).map((c) => ({
      provider: c.provider,
      model: c.model,
      reason: altReason(c, best),
    })),
  };
}
