import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { adapters } from '../adapters/index.js';
import { activeRuns, onActivity } from '../core/activity.js';
import { routingOverride, setRouting } from '../core/override.js';
import { refreshPrices } from '../core/prices.js';
import type { Effort } from '../core/types.js';
import { loadRoutingTable } from '../core/routing-table.js';
import {
  MAX_SERVED_PAGE_BYTES,
  confirmPage,
  forgetPage,
  memoryDir,
  memoryManifest,
} from '../core/memory.js';
import { appRoot } from '../core/paths.js';
import { configPath, readJson, writeJson } from '../core/store.js';
import { deadEntry, headroomInfo, readUsage, runsThisWeek } from '../core/usage.js';
import {
  answerTask,
  broadcast,
  getTask,
  listTasks,
  markRead,
  readState,
  recoverRunning,
  resultDir,
  safeName,
  startTask,
  subscribe,
  type BoardEvent,
} from './tasks.js';

export const DEFAULT_WEB_PORT = 4300;

/** Attachments go through this endpoint, so the ceiling is an upload ceiling. */
const MAX_BODY = 32 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
};

// --- small http helpers ------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve_, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('That is too big to send in one go.'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve_(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export interface Upload {
  fields: Record<string, string>;
  files: { name: string; data: Buffer }[];
}

/**
 * multipart/form-data, by hand, because the router carries no runtime
 * dependencies. Anything that is not a well formed part is skipped rather than
 * guessed at.
 */
export function parseMultipart(body: Buffer, boundary: string): Upload {
  const out: Upload = { fields: {}, files: [] };
  const sep_ = Buffer.from(`--${boundary}`);
  let at = body.indexOf(sep_);
  if (at < 0) return out;

  for (;;) {
    let start = at + sep_.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    if (body.slice(start, start + 2).toString() === '\r\n') start += 2;

    const next = body.indexOf(sep_, start);
    if (next < 0) break;
    const headEnd = body.indexOf('\r\n\r\n', start);
    if (headEnd < 0 || headEnd > next) {
      at = next;
      continue;
    }

    const head = body.slice(start, headEnd).toString('utf8');
    // the trailing CRLF belongs to the delimiter, not to the content
    const data = body.slice(headEnd + 4, next - 2);
    const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(head)?.[1];

    if (filename) {
      if (data.length) out.files.push({ name: safeName(filename), data });
    } else if (name) {
      out.fields[name] = data.toString('utf8');
    }
    at = next;
  }
  return out;
}

// --- static files ------------------------------------------------------------

/** Resolves inside `dir` or returns null, so a crafted path cannot climb out. */
export function safeJoin(dir: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const full = resolve(dir, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  const base = resolve(dir);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

function sendFile(res: ServerResponse, path: string): boolean {
  let info;
  try {
    info = statSync(path);
  } catch {
    return false;
  }
  if (info.isDirectory()) return false;
  res.writeHead(200, {
    'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(path).pipe(res);
  return true;
}

function notFound(res: ServerResponse, what: string): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${what}\n`);
}

const NO_UI = `The app has not been built yet.

Run this once, then start the board again:
  pnpm run ui:build
`;

function serveUi(res: ServerResponse, path: string): void {
  const uiDir = join(appRoot(), 'dist-web');
  const file = safeJoin(uiDir, path);
  if (file && file !== resolve(uiDir) && sendFile(res, file)) return;
  const index = join(uiDir, 'index.html');
  if (existsSync(index) && sendFile(res, index)) return;
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(NO_UI);
}

// --- api ---------------------------------------------------------------------

interface Manifest {
  id?: string;
  [k: string]: unknown;
}

function catalogFrom(dir: string): Manifest[] {
  const root = join(appRoot(), dir);
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const out: Manifest[] = [];
  for (const name of names) {
    const found = readJson<Manifest | null>(join(root, name, 'manifest.json'), null);
    if (found) out.push({ ...found, id: found.id ?? name });
  }
  return out;
}

/**
 * Whether a plugin has a key at all. The key itself never leaves the machine
 * and never enters a response: only this boolean does.
 */
function pluginsWithState(): Manifest[] {
  const config = readJson<Record<string, any>>(configPath('config.json'), {});
  return catalogFrom('plugins').map((p) => {
    const env = typeof p.keyEnv === 'string' ? process.env[p.keyEnv] : undefined;
    const stored = config?.plugins?.[String(p.id)]?.key;
    return { ...p, connected: Boolean(env || stored) };
  });
}

/**
 * Small user preferences (name, onboarded) live on disk, not in the page's
 * localStorage: the desktop app serves the board from a fresh random port on
 * every launch, and localStorage is tied to the origin, port included.
 */
interface Prefs {
  name?: string;
  onboarded?: boolean;
}

function readPrefs(): Prefs {
  const raw = readJson<Prefs>(configPath('prefs.json'), {});
  return {
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.onboarded === 'boolean' ? { onboarded: raw.onboarded } : {}),
  };
}

async function putPrefs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: Prefs;
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    return json(res, 400, { error: 'That request was not readable.' });
  }
  const next = { ...readPrefs() };
  if (typeof parsed.name === 'string') next.name = parsed.name.slice(0, 200);
  if (typeof parsed.onboarded === 'boolean') next.onboarded = parsed.onboarded;
  writeJson(configPath('prefs.json'), next);
  json(res, 200, next);
}

async function status(res: ServerResponse): Promise<void> {
  const providers = await Promise.all(
    adapters.map(async (a) => {
      const det = await a.detect();
      const auth = det.installed
        ? await a.authStatus()
        : { loggedIn: false, loginHint: `install ${a.binary} first` };
      const dead = deadEntry(a.id);
      const head = headroomInfo(a.id);
      return {
        id: a.id,
        displayName: a.displayName,
        subscriptionName: a.subscriptionName,
        installed: det.installed,
        version: det.version ?? null,
        loggedIn: auth.loggedIn,
        loginHint: auth.loginHint,
        detail: 'detail' in auth ? (auth.detail ?? null) : null,
        dead: dead ? { reason: dead.reason, until: dead.until } : null,
        headroom: head.value,
        headroomMeasured: head.measured,
        runs: runsThisWeek(a.id),
        ready: det.installed && auth.loggedIn && !dead,
      };
    }),
  );

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const today = readUsage().filter((r) => Date.parse(r.ts) >= since.getTime());
  const usedToday: Record<string, number> = {};
  for (const r of today) usedToday[r.provider] = (usedToday[r.provider] ?? 0) + 1;

  json(res, 200, {
    providers,
    usedToday,
    runsThisWeek: runsThisWeek(),
    // Honest empties: fleet sharing is designed but not built (docs/PRD.md 6.6).
    fleet: {
      machines: [],
      note: 'Sharing work with another computer is not built yet.',
    },
    scheduled: { items: [], note: 'Nothing repeats yet.' },
  });
}

// --- the routing switch ------------------------------------------------------

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh'];

/** Every model the table knows, so the app can offer a manual pick. */
function modelOptions(): { provider: string; model: string }[] {
  const table = loadRoutingTable();
  const seen = new Set<string>();
  const out: { provider: string; model: string }[] = [];
  for (const list of Object.values(table.categories)) {
    for (const c of list ?? []) {
      const key = `${c.provider}/${c.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider: c.provider, model: c.model });
    }
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function routingState(): Record<string, unknown> {
  const pinned = routingOverride();
  return {
    mode: pinned ? 'manual' : 'auto',
    provider: pinned?.provider ?? null,
    model: pinned?.model ?? null,
    effort: pinned?.effort ?? null,
    options: modelOptions(),
    efforts: EFFORTS,
    active: activeRuns(),
  };
}

async function putRouting(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let parsed: { mode?: unknown; provider?: unknown; model?: unknown; effort?: unknown };
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    json(res, 400, { error: 'That request was not readable.' });
    return;
  }
  if (parsed.mode === 'auto') {
    setRouting({ mode: 'auto' });
    broadcast({ type: 'routing', routing: { mode: 'auto', provider: null, model: null, effort: null } });
    return json(res, 200, routingState());
  }
  if (parsed.mode !== 'manual') {
    return json(res, 400, { error: 'The mode is auto or manual, nothing else.' });
  }
  const provider = typeof parsed.provider === 'string' ? parsed.provider : '';
  const model = typeof parsed.model === 'string' ? parsed.model : '';
  const effort = typeof parsed.effort === 'string' ? parsed.effort : '';
  const known = modelOptions().some((o) => o.provider === provider && o.model === model);
  if (!known || !EFFORTS.includes(effort as Effort)) {
    return json(res, 400, { error: 'Pick a model and effort from the list.' });
  }
  setRouting({ mode: 'manual', provider, model, effort: effort as Effort });
  broadcast({
    type: 'routing',
    routing: { mode: 'manual', provider, model, effort: effort as Effort },
  });
  json(res, 200, routingState());
}

function events(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  const send = (ev: BoardEvent): void => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  const off = subscribe(send);
  const offActivity = onActivity((runs) => send({ type: 'activity', runs }));
  // A fresh tab starts from what is running right now, not from silence.
  send({ type: 'activity', runs: activeRuns() });
  const beat = setInterval(() => res.write(': still here\n\n'), HEARTBEAT_MS);
  const stop = (): void => {
    clearInterval(beat);
    off();
    offActivity();
  };
  req.on('close', stop);
  res.on('close', stop);
}

async function newTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const type = req.headers['content-type'] ?? '';
  let text = '';
  let agent: string | undefined;
  let files: { name: string; data: Buffer }[] = [];

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    json(res, 413, { error: err instanceof Error ? err.message : 'That did not come through.' });
    return;
  }

  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(type);
  if (boundary) {
    const parsed = parseMultipart(body, (boundary[1] ?? boundary[2]).trim());
    text = parsed.fields.text ?? '';
    agent = parsed.fields.agent || undefined;
    files = parsed.files;
  } else {
    try {
      const parsed = JSON.parse(body.toString('utf8') || '{}');
      text = typeof parsed.text === 'string' ? parsed.text : '';
      agent = typeof parsed.agent === 'string' && parsed.agent ? parsed.agent : undefined;
    } catch {
      json(res, 400, { error: 'That request was not readable.' });
      return;
    }
  }

  if (!text.trim()) {
    json(res, 400, { error: 'Write what you want done first.' });
    return;
  }
  json(res, 201, { task: startTask({ text, agent, files }) });
}

async function answer(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  let parsed: { answer?: unknown; questionId?: unknown };
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    json(res, 400, { error: 'That request was not readable.' });
    return;
  }
  const value = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (!value) {
    json(res, 400, { error: 'Pick one of the answers first.' });
    return;
  }
  const took = answerTask(
    id,
    value,
    typeof parsed.questionId === 'string' ? parsed.questionId : undefined,
  );
  if (!took) {
    json(res, 409, { error: 'This one is not waiting on you any more.' });
    return;
  }
  json(res, 200, { task: getTask(id) });
}

// --- memory ------------------------------------------------------------------

/**
 * Where `GET /api/memory/page/<path>` may read from: inside the bundle or
 * nowhere. Exported so the traversal guard is tested exactly as served.
 */
export function memoryFilePath(rel: string): string | null {
  const file = safeJoin(memoryDir(), rel);
  if (!file || !file.endsWith('.md')) return null;
  return file;
}

function memoryPage(res: ServerResponse, rel: string): void {
  const file = memoryFilePath(rel);
  if (!file) return notFound(res, 'No page there.');
  let info;
  try {
    info = statSync(file);
  } catch {
    return notFound(res, 'No page there.');
  }
  if (info.isDirectory()) return notFound(res, 'No page there.');
  // One page at a time, byte-capped: this endpoint hands out pages, never bulk.
  if (info.size > MAX_SERVED_PAGE_BYTES) {
    return json(res, 413, { error: 'That page is too big to send in one go.' });
  }
  sendFile(res, file);
}

async function memoryAction(
  req: IncomingMessage,
  res: ServerResponse,
  action: 'confirm' | 'forget',
): Promise<void> {
  let parsed: { path?: unknown; name?: unknown };
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    json(res, 400, { error: 'That request was not readable.' });
    return;
  }
  const rel = typeof parsed.path === 'string' ? parsed.path : '';
  if (!rel || !memoryFilePath(rel)) {
    json(res, 404, { error: 'No page there.' });
    return;
  }
  const got =
    action === 'confirm'
      ? confirmPage(rel, typeof parsed.name === 'string' ? parsed.name : '')
      : forgetPage(rel);
  if (!got.ok) {
    json(res, 409, { error: got.reason ?? 'That did not work.' });
    return;
  }
  json(res, 200, { ok: true });
}

function results(res: ServerResponse, path: string): void {
  const [id, ...rest] = path.split('/').filter(Boolean);
  if (!id) {
    notFound(res, 'No result there.');
    return;
  }
  const dir = resultDir(id);
  const file = safeJoin(dir, rest.join('/') || 'index.html');
  if (!file) {
    notFound(res, 'No result there.');
    return;
  }
  if (sendFile(res, file)) return;
  if (sendFile(res, join(file, 'index.html'))) return;
  notFound(res, 'That result is not on this computer.');
}

// ponytail: loopback only, exactly like the gateway. The tailnet binding
// (docs/PRD.md 6.5) is designed but not built; nothing here listens on 0.0.0.0.
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
    json(res, 403, { error: 'The board only serves this computer.' });
    return;
  }
  const url = req.url ?? '/';
  const path = url.split('?')[0];
  const method = req.method ?? 'GET';

  if (path === '/healthz') return json(res, 200, { ok: true });

  if (path.startsWith('/results/')) {
    if (method !== 'GET') return notFound(res, 'No result there.');
    return results(res, path.slice('/results/'.length));
  }

  if (path.startsWith('/api/')) {
    const parts = path.split('/').filter(Boolean).slice(1);

    if (method === 'GET' && parts[0] === 'events' && parts.length === 1) return events(req, res);
    if (method === 'GET' && parts[0] === 'status' && parts.length === 1) return status(res);
    if (parts[0] === 'prefs' && parts.length === 1) {
      if (method === 'GET') return json(res, 200, readPrefs());
      if (method === 'POST') return putPrefs(req, res);
    }
    if (parts[0] === 'routing' && parts.length === 1) {
      if (method === 'GET') return json(res, 200, routingState());
      if (method === 'POST') return putRouting(req, res);
    }
    if (method === 'GET' && parts[0] === 'catalog' && parts.length === 1) {
      return json(res, 200, { agents: catalogFrom('agents'), plugins: pluginsWithState() });
    }
    if (parts[0] === 'memory') {
      if (method === 'GET' && parts[1] === 'manifest' && parts.length === 2) {
        return json(res, 200, memoryManifest());
      }
      if (method === 'GET' && parts[1] === 'page' && parts.length >= 3) {
        return memoryPage(res, parts.slice(2).join('/'));
      }
      if (method === 'POST' && parts[1] === 'confirm' && parts.length === 2) {
        return memoryAction(req, res, 'confirm');
      }
      if (method === 'POST' && parts[1] === 'forget' && parts.length === 2) {
        return memoryAction(req, res, 'forget');
      }
    }
    if (parts[0] === 'tasks') {
      if (method === 'GET' && parts.length === 1) return json(res, 200, { tasks: listTasks() });
      if (method === 'POST' && parts.length === 1) return newTask(req, res);
      const id = parts[1] ?? '';
      if (method === 'GET' && parts.length === 2) {
        const task = getTask(id);
        if (!task) return json(res, 404, { error: 'No task with that name.' });
        return json(res, 200, { task, state: readState(id) });
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'answer') {
        return answer(req, res, id);
      }
      if (method === 'POST' && parts.length === 3 && parts[2] === 'read') {
        const task = markRead(id);
        if (!task) return json(res, 404, { error: 'No task with that name.' });
        return json(res, 200, { task });
      }
    }
    return json(res, 404, { error: `Nothing answers ${method} ${path}.` });
  }

  if (method !== 'GET') return notFound(res, 'Nothing there.');
  serveUi(res, path);
}

/** Resolves with the process exit code: on listen failure, or after SIGINT. */
export function serveWeb(port = DEFAULT_WEB_PORT): Promise<number> {
  recoverRunning();
  // List prices are decoration on finished tasks; fetch quietly, retry daily.
  void refreshPrices();
  setInterval(() => void refreshPrices(), 24 * 60 * 60 * 1000).unref();
  return new Promise((resolve_) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: String(err) });
        else res.end();
      });
    });
    server.on('error', (err) => {
      console.error(`Could not start the board: ${err.message}`);
      resolve_(1);
    });
    server.listen(port, '127.0.0.1', () => {
      // Port 0 means "any free port", which is how the desktop app starts the
      // board so it can run alongside `aiax-router board`. Report what we got,
      // never what we asked for.
      const got = server.address();
      const actual = typeof got === 'object' && got ? got.port : port;
      console.log(`The board is at http://127.0.0.1:${actual}`);
    });
    const stop = (): void => {
      // An open event stream never ends on its own, so close() alone would
      // hang for as long as one browser tab is on the board.
      server.closeAllConnections();
      server.close(() => resolve_(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    // The desktop app sets this, and nothing else does. It holds our stdin, so
    // the pipe closing means the app is gone, however it went: quit, crash or a
    // kill it never got to handle. Without it the board would be left running
    // with no window in front of it. A terminal keeps stdin open, which is why
    // this is opt in rather than always on.
    if (process.env.AIAX_ROUTER_WATCH_STDIN) {
      process.stdin.on('end', stop);
      process.stdin.on('close', stop);
      process.stdin.on('error', stop);
      process.stdin.resume();
    }
  });
}
