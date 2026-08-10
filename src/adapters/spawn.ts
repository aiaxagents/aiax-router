import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { AdapterEvent } from './types.js';

/** stdin ignored, stdout and stderr piped. */
type Child = ChildProcessByStdio<null, Readable, Readable>;

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * A broken or non-executable binary on PATH makes `spawn` throw synchronously
 * (ENOEXEC), so every call site has to be told the process never started.
 */
function trySpawn(command: string, args: string[], opts: { cwd?: string }): Child | Error {
  try {
    return spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Run a command to completion, capturing output. For probes (detect, auth status). */
export function run(command: string, args: string[], timeoutMs = 15_000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = trySpawn(command, args, {});
    if (child instanceof Error) {
      resolve({ code: null, stdout: '', stderr: child.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Spawn a vendor CLI headless and stream its stdout line by line.
 * `parseLine` maps one stdout line to zero or more events; `finish` produces the
 * final result event from the collected lines once the process exits.
 */
export async function* streamLines(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
  parseLine: (line: string) => AdapterEvent[],
  finish: (lines: string[], code: number | null) => AdapterEvent,
): AsyncGenerator<AdapterEvent> {
  const child = trySpawn(command, args, { cwd: opts.cwd });
  if (child instanceof Error) {
    yield { type: 'error', message: `could not start ${command}: ${child.message}` };
    yield { type: 'result', ok: false, text: '' };
    return;
  }
  yield { type: 'started', command: [command, ...args] };

  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
  const lines: string[] = [];
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  // Without this listener a failed exec (ENOENT) becomes an uncaught exception.
  child.on('error', (err) => (stderr += `${err.message}\n`));

  const rl = createInterface({ input: child.stdout });
  for await (const line of rl) {
    lines.push(line);
    yield* parseLine(line);
  }

  const code: number | null = await new Promise((resolve) => {
    child.on('close', resolve);
    if (child.exitCode !== null) resolve(child.exitCode);
  });
  clearTimeout(timer);

  if (code !== 0 && code !== null) {
    yield { type: 'error', message: stderr.trim() || `exit ${code}`, exitCode: code };
  }
  yield finish(lines, code);
}
