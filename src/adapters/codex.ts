import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AdapterEvent, RunOptions } from './types.js';
import { run, streamLines } from './spawn.js';

/**
 * OpenAI Codex CLI adapter (ChatGPT subscription). `codex exec` streams JSONL
 * with `--json`; the reliable final answer is written via
 * `--output-last-message` so we do not depend on the JSONL event shape.
 */
export const codexAdapter: Adapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  binary: 'codex',
  subscriptionName: 'ChatGPT Plus / Pro',

  async detect() {
    const res = await run('codex', ['--version']);
    if (res.code !== 0) return { installed: false };
    return { installed: true, version: res.stdout.trim().replace(/^codex-cli\s*/, '') };
  },

  async authStatus() {
    const loginHint = 'codex login';
    const res = await run('codex', ['login', 'status']);
    if (res.code === 0) {
      return { loggedIn: true, detail: (res.stdout + res.stderr).trim().split('\n')[0], loginHint };
    }
    if (res.code === null) return { loggedIn: false, detail: 'could not run codex', loginHint };
    return { loggedIn: false, loginHint };
  },

  async *run(task: string, opts: RunOptions): AsyncGenerator<AdapterEvent> {
    const dir = mkdtempSync(join(tmpdir(), 'aiax-codex-'));
    const lastMessage = join(dir, 'last.txt');
    const args = [
      'exec',
      task,
      '-m',
      opts.model,
      '--json',
      '--output-last-message',
      lastMessage,
      '-C',
      opts.cwd,
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    ];
    if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);

    try {
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      for await (const ev of streamLines(
        'codex',
        args,
        { cwd: opts.cwd, timeoutMs: opts.timeoutMs },
        (line): AdapterEvent[] => {
          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch {
            return [];
          }
          const item = obj.item ?? obj.msg ?? obj;
          if (typeof item?.text === 'string' && (item.type ?? '').includes('message')) {
            return [{ type: 'text', chunk: item.text }];
          }
          // Current CLI: {"type":"turn.completed","usage":{input_tokens,...}}.
          // Older builds tucked it under info.total_token_usage.
          const u = obj.usage ?? (obj.info ?? item?.info)?.total_token_usage;
          if (u && (u.input_tokens != null || u.output_tokens != null)) {
            usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
          }
          return [];
        },
        (_lines, code) => {
          let text = '';
          try {
            text = readFileSync(lastMessage, 'utf8').trim();
          } catch {
            // no final message written
          }
          return { type: 'result', ok: code === 0 && text.length > 0, text, usage };
        },
      )) {
        yield ev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
