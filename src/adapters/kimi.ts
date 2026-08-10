import type { Adapter, AdapterEvent, RunOptions } from './types.js';
import { run, streamLines } from './spawn.js';

/**
 * Kimi CLI adapter (Moonshot subscription). `kimi -p` implies auto-approval,
 * so runs are confined to the task cwd; no effort control documented.
 */

const MODEL_ALIAS: Record<string, string> = { 'kimi-k3': 'kimi-code/k3' };

/** The answer text on a stream-json line, or null for meta/noise lines. */
function assistantText(line: string): string | null {
  try {
    const obj = JSON.parse(line);
    if (obj.role && obj.role !== 'assistant') return null;
    const text = obj.text ?? obj.content ?? obj.message?.content;
    return typeof text === 'string' && text ? text : null;
  } catch {
    return null;
  }
}
export const kimiAdapter: Adapter = {
  id: 'kimi',
  displayName: 'Kimi CLI',
  binary: 'kimi',
  subscriptionName: 'Kimi / Moonshot',

  async detect() {
    const res = await run('kimi', ['--version']);
    if (res.code !== 0) return { installed: false };
    return { installed: true, version: res.stdout.trim() };
  },

  async authStatus() {
    const loginHint = 'kimi login';
    const res = await run('kimi', ['doctor']);
    if (res.code === null) return { loggedIn: false, detail: 'could not run kimi', loginHint };
    const out = res.stdout + res.stderr;
    return { loggedIn: res.code === 0 && !/not logged in|login required/i.test(out), loginHint };
  },

  run(task: string, opts: RunOptions) {
    const args = ['-p', task, '--output-format', 'stream-json'];
    // The CLI wants its own config.toml alias, not the public model name.
    if (opts.model) args.push('--model', MODEL_ALIAS[opts.model] ?? opts.model);

    return streamLines(
      'kimi',
      args,
      { cwd: opts.cwd, timeoutMs: opts.timeoutMs },
      (line): AdapterEvent[] => {
        const text = assistantText(line);
        if (text) return [{ type: 'text', chunk: text }];
        return [];
      },
      (lines, code) => {
        // Last assistant message wins; meta lines (resume hints) are not answers.
        let text = '';
        for (const line of lines) {
          const t = assistantText(line);
          if (t) text = t;
        }
        return {
          type: 'result',
          ok: code === 0 && text.length > 0,
          text,
          // The CLI reports no token counts; chars/4 keeps the tally roughly honest.
          usage: text
            ? { inputTokens: Math.round(task.length / 4), outputTokens: Math.round(text.length / 4) }
            : undefined,
        };
      },
    );
  },
};
