export type Category =
  | 'coding'
  | 'agentic-coding'
  | 'reasoning'
  | 'writing'
  | 'chat'
  | 'long-context';

export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * How much machinery the input has earned. `category` says what kind of work it
 * is and `difficulty` says how hard, but neither says how much ceremony the
 * person wants, and the two are not the same question: a greeting and a two
 * page report can both read as easy writing.
 *
 * - `conversational`: talking to the router. Nothing to produce at all.
 * - `light`: one good answer settles it. The person wants the answer, not a
 *   work product, so it goes to the strongest model with the right skills in
 *   one pass. No splitting, no review panel, no revision loop.
 * - `full`: something that will be used or read as a work product, and worth
 *   planning, splitting and reviewing.
 */
export type Weight = 'conversational' | 'light' | 'full';

export interface Classification {
  category: Category;
  difficulty: Difficulty;
  rationale: string;
  via: 'model' | 'heuristic';
  weight: Weight;
}

export interface Candidate {
  provider: string;
  model: string;
  /** Normalized quality 0-100 for the category. */
  score: number;
  /** 1-5: how much subscription headroom a run spends. 0-1 = free tier. */
  costWeight: number;
  /** Relative tokens to complete a typical task in the category (1 = baseline). */
  tokensPerTask: number;
  maxEffort?: Effort;
}

export interface RoutingTable {
  schemaVersion: number;
  generatedAt: string;
  sources: { name: string; [k: string]: unknown }[];
  categories: Record<Category, Candidate[]>;
  difficultyFloor: Record<Difficulty, number>;
}

export interface Decision {
  provider: string;
  model: string;
  effort: Effort;
  /** One short plain-language sentence, shown to the user. */
  rationale: string;
  rankedAlternatives: { provider: string; model: string; reason: string }[];
}
