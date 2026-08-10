import type { Effort } from '../core/types.js';

export interface DetectResult {
  installed: boolean;
  version?: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  detail?: string;
  /** Exact command the user runs themselves. The router never automates login. */
  loginHint: string;
}

/**
 * Every CLI runs with its own approvals bypassed ("yolo"): the agents need the
 * web, files and tools to actually do the work, and a sandboxed helper that
 * stops to ask for permission just fails the task. The person picked this
 * router as their gate; the CLIs are not asked to be a second one.
 */
export interface RunOptions {
  model: string;
  effort?: Effort;
  cwd: string;
  timeoutMs: number;
}

export type AdapterEvent =
  | { type: 'started'; command: string[] }
  | { type: 'text'; chunk: string }
  | {
      type: 'result';
      ok: boolean;
      text: string;
      /** costUsd is the CLI's own API-price figure when it reports one. */
      usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
    }
  | { type: 'error'; message: string; exitCode?: number };

export interface Adapter {
  id: string;
  displayName: string;
  binary: string;
  subscriptionName: string;
  detect(): Promise<DetectResult>;
  authStatus(): Promise<AuthStatus>;
  run(task: string, opts: RunOptions): AsyncIterable<AdapterEvent>;
}
