import { ask, asString, cheapestCandidate, parseJsonObject } from '../core/ask.js';
import { loadRoutingTable } from '../core/routing-table.js';
import type { RoutingTable } from '../core/types.js';

/** Short, because a narration line that arrives after the stage it describes is noise. */
const TIMEOUT_MS = 20_000;

export function narratePrompt(message: string): string {
  return `Put the line below into plain everyday words, the way you would tell a friend what is happening right now.

Rules: one sentence, twelve words at most, present tense, no jargon, no numbers unless the line has them, no em dashes. Keep any product or tool name that is already there. Everyone doing the work here is an AI agent, so say "agents", never "people", "person" or "reviewers" as if they were human. If the line is already plain, send it back as it is.

The line:
${message}

Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"line":"the plain sentence"}`;
}

/**
 * The translated thinking narration. The cheapest signed-in model puts each
 * pipeline event into everyday words; when no model is free the deterministic
 * line the pipeline already produced is what the user sees. Raw chain of
 * thought never reaches this function, only the router's own stage messages.
 */
export async function narrate(
  message: string,
  available: Set<string>,
  table: RoutingTable = loadRoutingTable(),
): Promise<string | null> {
  const candidate = cheapestCandidate(available, table);
  if (!candidate) return null;
  const { ok, text } = await ask(candidate, narratePrompt(message), {
    effort: 'low',
    timeoutMs: TIMEOUT_MS,
  });
  if (!ok) return null;
  const line = asString(parseJsonObject(text)?.line);
  if (!line || line.length > 160 || line === message) return null;
  return line;
}
