import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { adapterById } from '../adapters/index.js';
import { availability, dispatch, runWithFailover, type RunEvent } from '../core/router.js';
import { loadRoutingTable } from '../core/routing-table.js';
import type { Category, Decision } from '../core/types.js';

export const DEFAULT_PORT = 4300;

/** Bodies are user text, not uploads; anything larger is a mistake or an attack. */
const MAX_BODY = 2 * 1024 * 1024;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const CATEGORIES: Category[] = [
  'coding',
  'agentic-coding',
  'reasoning',
  'writing',
  'chat',
  'long-context',
];

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Last user turn; array content is the OpenAI parts shape, so text parts get joined. */
export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) {
      return m.content
        .map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
        .join('')
        .trim();
    }
  }
  return '';
}

/** "aiax/<provider>/<model>" pins the pair; anything else routes. */
export function forcedPair(model: unknown): { provider: string; model: string } | null {
  if (typeof model !== 'string') return null;
  const parts = model.split('/');
  if (parts.length < 3 || parts[0] !== 'aiax') return null;
  return { provider: parts[1], model: parts.slice(2).join('/') };
}

async function* forcedRun(task: string, decision: Decision): AsyncGenerator<RunEvent> {
  yield { type: 'decision', decision, attempt: 1 };
  yield* dispatch(task, decision);
}

function envelope(decision: Decision | null, attempts: number) {
  return {
    decision: decision
      ? {
          provider: decision.provider,
          model: decision.model,
          effort: decision.effort,
          rationale: decision.rationale,
        }
      : null,
    attempts,
  };
}

async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    json(res, 400, { error: { message: err instanceof Error ? err.message : 'invalid JSON body' } });
    return;
  }

  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  const task = lastUserText(messages);
  if (!task) {
    json(res, 400, { error: { message: 'no user message with text content' } });
    return;
  }

  const forced = forcedPair(body?.model);
  let source: AsyncIterable<RunEvent>;
  if (forced) {
    if (!adapterById(forced.provider)) {
      json(res, 400, { error: { message: `unknown provider "${forced.provider}"` } });
      return;
    }
    source = forcedRun(task, {
      provider: forced.provider,
      model: forced.model,
      effort: 'medium',
      rationale: 'Pinned by the request.',
      rankedAlternatives: [],
    });
  } else {
    source = runWithFailover(task);
  }

  if (body?.stream === true) await streamResponse(res, source);
  else await jsonResponse(res, source);
}

interface Collected {
  decision: Decision | null;
  attempts: number;
  text: string;
  ok: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
  error: string;
}

async function jsonResponse(res: ServerResponse, source: AsyncIterable<RunEvent>): Promise<void> {
  const got: Collected = { decision: null, attempts: 0, text: '', ok: false, error: '' };
  let streamed = '';
  try {
    for await (const ev of source) {
      if (ev.type === 'decision') {
        got.decision = ev.decision;
        got.attempts = ev.attempt;
      } else if (ev.type === 'text') streamed += ev.chunk;
      else if (ev.type === 'error') got.error += `${ev.message}\n`;
      else if (ev.type === 'result') {
        got.ok = ev.ok;
        got.text = ev.text;
        got.usage = ev.usage;
      }
    }
  } catch (err) {
    json(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
    return;
  }

  const content = got.text || streamed;
  if (!got.ok) {
    json(res, 502, {
      error: { message: got.error.trim() || content || 'the run failed' },
      aiax: envelope(got.decision, got.attempts),
    });
    return;
  }

  const input = got.usage?.inputTokens;
  const output = got.usage?.outputTokens;
  json(res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `${got.decision?.provider}/${got.decision?.model}`,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    ...(input !== undefined || output !== undefined
      ? {
          usage: {
            prompt_tokens: input ?? 0,
            completion_tokens: output ?? 0,
            total_tokens: (input ?? 0) + (output ?? 0),
          },
        }
      : {}),
    aiax: envelope(got.decision, got.attempts),
  });
}

async function streamResponse(res: ServerResponse, source: AsyncIterable<RunEvent>): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let decision: Decision | null = null;
  let attempts = 0;
  let streamed = false;

  const send = (delta: Record<string, unknown>, finish: string | null): void => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model: decision ? `${decision.provider}/${decision.model}` : 'aiax/auto',
        choices: [{ index: 0, delta, finish_reason: finish }],
        aiax: envelope(decision, attempts),
      })}\n\n`,
    );
  };

  try {
    for await (const ev of source) {
      if (ev.type === 'decision') {
        decision = ev.decision;
        attempts = ev.attempt;
      } else if (ev.type === 'text' && ev.chunk) {
        streamed = true;
        send({ content: ev.chunk }, null);
      } else if (ev.type === 'result') {
        // Most CLIs only produce their answer at the end, so nothing streamed yet.
        if (!streamed && ev.text) send({ content: ev.text }, null);
      }
    }
  } catch (err) {
    send({ content: `\n[router error] ${err instanceof Error ? err.message : String(err)}` }, null);
  }
  send({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

async function models(res: ServerResponse): Promise<void> {
  const { available } = await availability();
  const table = loadRoutingTable();
  const ids = new Set<string>(['aiax/auto']);
  const owner = new Map<string, string>([['aiax/auto', 'aiax-router']]);
  for (const category of CATEGORIES) {
    for (const c of table.categories[category] ?? []) {
      if (!available.has(c.provider)) continue;
      const id = `aiax/${c.provider}/${c.model}`;
      ids.add(id);
      owner.set(id, c.provider);
    }
  }
  const created = Math.floor(Date.now() / 1000);
  json(res, 200, {
    object: 'list',
    data: [...ids].map((id) => ({ id, object: 'model', created, owned_by: owner.get(id) })),
  });
}

// ponytail: no auth token. The listener is bound to 127.0.0.1 and every
// request is checked for a loopback peer; a token would add nothing against
// local processes, which can already run the vendor CLIs themselves.
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
    json(res, 403, { error: { message: 'aiax-router only serves localhost' } });
    return;
  }
  const path = (req.url ?? '').split('?')[0];
  if (req.method === 'POST' && path === '/v1/chat/completions') return chatCompletions(req, res);
  if (req.method === 'GET' && path === '/v1/models') return models(res);
  if (req.method === 'GET' && path === '/healthz') {
    json(res, 200, { ok: true });
    return;
  }
  json(res, 404, { error: { message: `no route for ${req.method} ${path}` } });
}

/** Resolves with the process exit code: on listen failure, or after SIGINT. */
export function serve(port = DEFAULT_PORT): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: { message: String(err) } });
        else res.end();
      });
    });
    server.on('error', (err) => {
      console.error(`Could not start the gateway: ${err.message}`);
      resolve(1);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Gateway listening on http://127.0.0.1:${port}`);
      console.log('Point any OpenAI-compatible client at it and ask for the model "aiax/auto".');
    });
    const stop = (): void => {
      // Same as the board: a kept-alive client would otherwise hold close() open.
      server.closeAllConnections();
      server.close(() => resolve(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
