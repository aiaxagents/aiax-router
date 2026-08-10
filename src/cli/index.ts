#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adapters } from '../adapters/index.js';
import { runPipeline, DEFAULT_MAX_ROUNDS } from '../core/pipeline.js';
import { availability, routeTask, runWithFailover } from '../core/router.js';
import { update } from '../core/update.js';
import { deadEntry, headroomInfo, readUsage, runsThisWeek } from '../core/usage.js';
import { DEFAULT_PORT, serve } from '../gateway/serve.js';
import { DEFAULT_WEB_PORT, serveWeb } from '../web/serve.js';

const [, , command] = process.argv;

const HELP = `aiax-router - get the best out of the AI subscriptions you already pay for

Usage:
  aiax-router run <task...>     Work through the task and check the result
                                --simple      keep it as one job, still reviewed
                                --fast        one model, one pass, no review
                                --max-rounds N  how many review passes at most (default ${DEFAULT_MAX_ROUNDS})
                                --dry-run     show the pick, run nothing
  aiax-router board [--port N]  Open the app on 127.0.0.1:${DEFAULT_WEB_PORT}
                                --no-open     start it, open nothing
  aiax-router status            Headroom, health and recent runs per tool
  aiax-router serve [--port N]  OpenAI-compatible gateway on 127.0.0.1:${DEFAULT_PORT}
  aiax-router doctor            Check which AI tools are installed and signed in
  aiax-router update            Get this week's routing table
                                --from <url|file>  take it from somewhere else
  aiax-router help              Show this help`;

export function parsePort(argv: string[], fallback: number): number | null {
  const at = argv.indexOf('--port');
  if (at < 0) return fallback;
  const port = Number(argv[at + 1]);
  // 0 is legal and means "pick a free one", which the desktop app relies on.
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : null;
}

/** Opens the user's own browser. A failure here is never worth stopping for. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
      .on('error', () => undefined)
      .unref();
  } catch {
    // the URL is printed either way
  }
}

async function doctor(): Promise<number> {
  console.log('Checking your AI tools...\n');
  let anyReady = false;
  for (const a of adapters) {
    const det = await a.detect();
    if (!det.installed) {
      console.log(`  ${a.displayName.padEnd(12)} not installed  (${a.subscriptionName})`);
      continue;
    }
    const auth = await a.authStatus();
    const state = auth.loggedIn ? 'ready' : `signed out - run: ${auth.loginHint}`;
    if (auth.loggedIn) anyReady = true;
    console.log(
      `  ${a.displayName.padEnd(12)} ${(det.version ?? '').padEnd(10)} ${state}` +
        (auth.detail ? `  (${auth.detail})` : ''),
    );
  }
  console.log(
    anyReady
      ? '\nYou are good to go.'
      : '\nNo tool is signed in yet. Install one of the tools above and sign in, then run doctor again.',
  );
  return 0;
}

function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

function ago(ts: string): string {
  const ms = Date.now() - Date.parse(ts);
  if (!Number.isFinite(ms)) return 'unknown';
  return ms < 60_000 ? 'just now' : `${duration(ms)} ago`;
}

async function status(): Promise<number> {
  console.log('Your AI tools right now\n');

  for (const a of adapters) {
    const det = await a.detect();
    if (!det.installed) {
      console.log(`  ${a.displayName.padEnd(13)} not installed  (${a.subscriptionName})`);
      continue;
    }
    const auth = await a.authStatus();
    if (!auth.loggedIn) {
      console.log(`  ${a.displayName.padEnd(13)} signed out    run: ${auth.loginHint}`);
      continue;
    }
    const { value, measured } = headroomInfo(a.id);
    const head = `headroom ${String(Math.round(value * 100)).padStart(3)}% ${
      measured ? '(measured)' : '(estimated)'
    }`;
    const dead = deadEntry(a.id);
    const note = dead
      ? `cannot take work: ${dead.reason}, tries again in ${duration(dead.until - Date.now())}`
      : '';
    console.log(`  ${a.displayName.padEnd(13)} signed in     ${head.padEnd(28)}${note}`.trimEnd());
  }

  const runs = readUsage();
  const week = runsThisWeek();
  console.log(`\nThis week: ${week} ${week === 1 ? 'run' : 'runs'}.`);
  if (runs.length === 0) {
    console.log('No runs yet. Try: aiax-router run "explain this repo in one paragraph"');
    return 0;
  }
  console.log('Last 3 runs:');
  for (const r of runs.slice(-3).reverse()) {
    console.log(
      `  ${`${r.provider}/${r.model}`.padEnd(24)} ${(r.ok ? 'ok' : 'failed').padEnd(8)} ${ago(r.ts)}`,
    );
  }
  return 0;
}

export interface RunArgs {
  task: string;
  dryRun: boolean;
  fast: boolean;
  simple: boolean;
  maxRounds?: number;
  badRounds?: string;
}

export function parseRunArgs(argv: string[]): RunArgs {
  const at = argv.indexOf('--max-rounds');
  const raw = at >= 0 ? argv[at + 1] : undefined;
  const rounds = Number(raw);
  const valid = Number.isInteger(rounds) && rounds >= 1 && rounds <= 10;
  return {
    task: argv
      .filter((a, i) => !a.startsWith('--') && !(at >= 0 && i === at + 1))
      .join(' ')
      .trim(),
    dryRun: argv.includes('--dry-run'),
    fast: argv.includes('--fast'),
    simple: argv.includes('--simple'),
    maxRounds: at >= 0 && valid ? rounds : undefined,
    badRounds: at >= 0 && !valid ? String(raw) : undefined,
  };
}

/** One model, one pass, nobody checking it. */
async function runFast(task: string): Promise<number> {
  let streamed = false;
  let code = 0;
  for await (const ev of runWithFailover(task)) {
    if (ev.type === 'decision') {
      console.log(
        `-> ${ev.decision.provider}/${ev.decision.model} effort=${ev.decision.effort}  ${ev.decision.rationale}`,
      );
    } else if (ev.type === 'failover') {
      console.log(ev.message);
    } else if (ev.type === 'text' && ev.chunk) {
      process.stdout.write(ev.chunk.endsWith('\n') ? ev.chunk : `${ev.chunk}\n`);
      streamed = true;
    } else if (ev.type === 'error') {
      console.error(ev.message);
      code = 1;
    } else if (ev.type === 'result') {
      if (!streamed && ev.text) console.log(ev.text);
      code = ev.ok ? 0 : 1;
    }
  }
  return code;
}

function list(title: string, items: string[]): void {
  if (items.length === 0) return;
  console.log(`\n${title}`);
  for (const item of items) console.log(`  - ${item}`);
}

async function runTask(argv: string[]): Promise<number> {
  const args = parseRunArgs(argv);
  if (args.badRounds !== undefined) {
    console.error(`--max-rounds needs a whole number from 1 to 10, not ${args.badRounds}.`);
    return 1;
  }
  if (!args.task) {
    console.error('Nothing to do. Usage: aiax-router run <task...> [--simple] [--fast] [--dry-run]');
    return 1;
  }

  if (args.dryRun) {
    const { available } = await availability();
    const { decision } = await routeTask(args.task, available);
    console.log(
      `-> ${decision.provider}/${decision.model} effort=${decision.effort}  ${decision.rationale}`,
    );
    for (const alt of decision.rankedAlternatives) {
      console.log(`     also considered ${alt.provider}/${alt.model} - ${alt.reason}`);
    }
    return 0;
  }

  if (args.fast) return runFast(args.task);

  let code = 1;
  for await (const ev of runPipeline(args.task, {
    simple: args.simple,
    maxRounds: args.maxRounds,
  })) {
    if (ev.type === 'progress') {
      console.log(ev.message);
      continue;
    }

    console.log(`\n${ev.answer}\n`);
    if (!ev.ok) {
      console.log('Nothing usable came back, so there is no result to show.');
      return 1;
    }
    if (!ev.outcome || !ev.outcome.reviewed) {
      console.log('Nobody was free to check this, so treat it as unchecked.');
    } else {
      const pass = ev.outcome.passed ? 'good enough to ship' : 'not all the way there';
      console.log(
        `Reviewers gave it ${ev.outcome.average} out of 10 after ${ev.rounds} ${
          ev.rounds === 1 ? 'round' : 'rounds'
        }, which is ${pass}.`,
      );
      if (!ev.outcome.passed) list('Still not right:', ev.outcome.gaps);
    }
    list('Needs your call:', ev.state.needsYourCall.map((q) => q.question));
    list('I decided this for you:', ev.state.decisions);
    code = 0;
  }
  return code;
}

async function main(): Promise<number> {
  switch (command) {
    case 'run':
      return runTask(process.argv.slice(3));
    case 'status':
      return status();
    case 'serve': {
      const port = parsePort(process.argv.slice(3), DEFAULT_PORT);
      if (port === null) {
        console.error('Not a usable port.');
        return 1;
      }
      return serve(port);
    }
    case 'board': {
      const argv = process.argv.slice(3);
      const port = parsePort(argv, DEFAULT_WEB_PORT);
      if (port === null) {
        console.error('Not a usable port.');
        return 1;
      }
      // With --port 0 the real port is only known once it is listening, so
      // there is no URL to open ahead of time.
      if (port !== 0 && !argv.includes('--no-open')) {
        setTimeout(() => openBrowser(`http://127.0.0.1:${port}`), 300).unref();
      }
      return serveWeb(port);
    }
    case 'doctor':
      return doctor();
    case 'update':
      return update(process.argv.slice(3));
    case 'help':
    case undefined:
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

/** Only when started as the command, so tests can import the parsing above. */
function startedDirectly(): boolean {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
