import type { Adapter, AdapterEvent, RunOptions } from './types.js';
import { run, streamLines } from './spawn.js';

/**
 * Claude Code adapter. The user logs in with `claude` themselves; we only
 * spawn the CLI headless. Stream format: `--output-format stream-json`
 * emits one JSON object per line; the final object has type "result".
 */
export const claudeAdapter: Adapter = {
  id: 'claude',
  displayName: 'Claude Code',
  binary: 'claude',
  subscriptionName: 'Claude Pro / Max',

  async detect() {
    const res = await run('claude', ['--version']);
    if (res.code !== 0) return { installed: false };
    return { installed: true, version: res.stdout.trim().split(/\s+/)[0] };
  },

  async authStatus() {
    const loginHint = 'claude  (then follow the login prompt)';
    const res = await run('claude', ['auth', 'status']);
    if (res.code === 0) return { loggedIn: true, loginHint };
    if (res.code === null) return { loggedIn: false, detail: 'could not run claude', loginHint };
    return { loggedIn: false, detail: res.stderr.trim() || res.stdout.trim(), loginHint };
  },

  run(task: string, opts: RunOptions) {
    const args = ['-p', task, '--model', opts.model, '--output-format', 'stream-json', '--verbose'];
    if (opts.effort) args.push('--effort', opts.effort);
    args.push('--dangerously-skip-permissions');

    let resultSeen = false;
    return streamLines(
      'claude',
      args,
      { cwd: opts.cwd, timeoutMs: opts.timeoutMs },
      (line): AdapterEvent[] => {
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          return [];
        }
        if (obj.type === 'assistant') {
          const text = (obj.message?.content ?? [])
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('');
          return text ? [{ type: 'text', chunk: text }] : [];
        }
        if (obj.type === 'result') {
          resultSeen = true;
          return [
            {
              type: 'result',
              // A refusal (out of quota, for one) still arrives as subtype
              // "success" with is_error set, so both have to be checked.
              ok: obj.subtype === 'success' && obj.is_error !== true,
              text: obj.result ?? '',
              // Cache reads and writes are still tokens fed to the model, and
              // total_cost_usd is the CLI's exact API-price figure.
              usage: {
                inputTokens:
                  (obj.usage?.input_tokens ?? 0) +
                  (obj.usage?.cache_creation_input_tokens ?? 0) +
                  (obj.usage?.cache_read_input_tokens ?? 0),
                outputTokens: obj.usage?.output_tokens,
                costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
              },
            },
          ];
        }
        return [];
      },
      (lines, code) =>
        resultSeen
          ? { type: 'text', chunk: '' }
          : { type: 'result', ok: code === 0, text: lines.at(-1) ?? '' },
    );
  },
};
