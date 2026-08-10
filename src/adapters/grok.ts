import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AdapterEvent, RunOptions } from './types.js';
import { run, streamLines } from './spawn.js';

/**
 * Grok CLI adapter (SuperGrok subscription). Single-turn headless via
 * `grok -p`. No auth-status subcommand: presence check of ~/.grok/auth.json
 * only (never read).
 */
export const grokAdapter: Adapter = {
  id: 'grok',
  displayName: 'Grok CLI',
  binary: 'grok',
  subscriptionName: 'SuperGrok / X Premium',

  async detect() {
    const res = await run('grok', ['--version']);
    if (res.code !== 0) return { installed: false };
    return { installed: true, version: res.stdout.trim().split(/\s+/)[1] ?? res.stdout.trim() };
  },

  async authStatus() {
    const loginHint = 'grok  (then follow the login prompt)';
    const loggedIn = existsSync(join(homedir(), '.grok', 'auth.json'));
    return { loggedIn, loginHint };
  },

  run(task: string, opts: RunOptions) {
    const args = ['-p', task, '-m', opts.model, '--output-format', 'json'];
    if (opts.effort) args.push('--effort', opts.effort);

    return streamLines(
      'grok',
      args,
      { cwd: opts.cwd, timeoutMs: opts.timeoutMs },
      (): AdapterEvent[] => [],
      (lines, code) => {
        const raw = lines.join('\n').trim();
        let text = raw;
        let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
        try {
          const obj = JSON.parse(raw);
          text = obj.result ?? obj.response ?? obj.text ?? obj.content ?? raw;
          if (obj.usage) {
            usage = {
              inputTokens:
                (obj.usage.input_tokens ?? 0) +
                (obj.usage.cache_creation_input_tokens ?? 0) +
                (obj.usage.cache_read_input_tokens ?? 0),
              outputTokens: obj.usage.output_tokens,
              costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
            };
          }
        } catch {
          // plain text fallback
        }
        return { type: 'result', ok: code === 0 && text.length > 0, text, usage };
      },
    );
  },
};
