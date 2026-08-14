export type Category =
  | 'coding'
  | 'agentic-coding'
  | 'reasoning'
  | 'writing'
  | 'chat'
  | 'long-context';

export type Difficulty = 'trivial' | 'easy' | 'medium' | 'hard';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

export interface Classification {
  category: Category;
  difficulty: Difficulty;
  rationale: string;
  via: 'model' | 'heuristic';
  /**
   * Talking to the router rather than giving it work: a greeting, a thank you,
   * a question about itself. There is no deliverable to plan, split or review,
   * so the pipeline answers these in one pass. `chat` cannot stand in for this,
   * because it is also the fallback category for anything with no keyword hit.
   */
  conversational?: boolean;
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
