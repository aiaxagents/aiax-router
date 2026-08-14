/**
 * The wire contract with the local server. Types are written out here rather
 * than imported from src/, because the two builds ship separately and this file
 * is the only place the browser is allowed to assume a shape.
 *
 * Every path is relative, so the same bundle works from localhost, from the
 * desktop app and from another computer on the tailnet.
 */

export interface NarrationLine {
  id: string;
  at: string;
  text: string;
}

export interface Choice {
  label: string;
  means: string;
  recommended?: boolean;
}

export interface TaskQuestion {
  id: string;
  question: string;
  choices: Choice[];
  answer?: string;
}

export interface UsageLine {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  lines: UsageLine[];
}

export interface TaskRecord {
  id: string;
  title: string;
  status: 'backlog' | 'running' | 'done' | 'failed';
  sentence: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  agent?: string;
  parts: { done: number; total: number };
  score?: number;
  rounds?: number;
  passed?: boolean;
  question?: TaskQuestion;
  unread: boolean;
  lines: NarrationLine[];
  attachments: string[];
  excerpt?: string;
  usage?: TaskUsage;
}

export interface SubtaskResult {
  id: string;
  title: string;
  provider: string;
  model: string;
  ok: boolean;
  summary: string;
  text: string;
}

export interface TaskState {
  id: string;
  createdAt: string;
  task: string;
  intent: string;
  acceptanceCriteria: string[];
  decisions: string[];
  needsYourCall: TaskQuestion[];
  subtasks: { id: string; title: string; task: string; category: string; difficulty: string }[];
  results: SubtaskResult[];
  reviewRounds: {
    round: number;
    average: number;
    scores: { lens: string; provider: string; model: string; score: number; note: string }[];
    gaps: string[];
  }[];
  status: 'running' | 'done' | 'needs-work' | 'failed';
}

export interface Provider {
  id: string;
  displayName: string;
  subscriptionName: string;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  loginHint: string;
  detail: string | null;
  dead: { reason: string; until: number } | null;
  headroom: number;
  headroomMeasured: boolean;
  runs: number;
  ready: boolean;
}

export interface Status {
  providers: Provider[];
  usedToday: Record<string, number>;
  runsThisWeek: number;
  fleet: { machines: { name: string; providers: string[] }[]; note: string };
  scheduled: { items: ScheduledItem[]; note: string };
}

export interface ScheduledItem {
  id: string;
  name: string;
  every: string;
  next: string;
  lastResult?: string;
  paused?: boolean;
}

export interface Requirement {
  any: { kind: string; id?: string; name: string }[];
}

export interface AgentTemplate {
  id: string;
  name: string;
  /** Where it sits in the roster. The order is editorial, not alphabetical. */
  order?: number;
  avatar?: string;
  tagline: string;
  placeholder?: string;
  requires?: Requirement[];
  hint?: string;
}

export interface PluginTemplate {
  id: string;
  name: string;
  label?: string;
  does?: string;
  note?: string;
  pricingUrl?: string;
  metered?: boolean;
  connected?: boolean;
  brand?: string;
  /** The name of the setting that holds the key. Never the key itself. */
  keyEnv?: string;
}

export interface Catalog {
  agents: AgentTemplate[];
  plugins: PluginTemplate[];
}

export interface MemoryPageInfo {
  path: string;
  type: string;
  title: string;
  description: string;
  status: 'draft' | 'stable' | 'deprecated';
  generatedAt: string;
  hash: string;
  tier: 'human' | 'machine' | 'unverified';
  stale: boolean;
}

export interface MemoryManifest {
  okf_version: string;
  pages: MemoryPageInfo[];
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

export interface ActiveRun {
  id: string;
  provider: string;
  model: string;
  effort: Effort;
  role: 'work' | 'planning' | 'review' | 'helper';
  startedAt: string;
}

export interface RoutingState {
  mode: 'auto' | 'manual';
  provider: string | null;
  model: string | null;
  effort: Effort | null;
  options: { provider: string; model: string }[];
  efforts: Effort[];
  active: ActiveRun[];
}

export type BoardEvent =
  | { type: 'task'; task: TaskRecord }
  | { type: 'narration'; taskId: string; line: NarrationLine }
  | { type: 'activity'; runs: ActiveRun[] }
  | {
      type: 'routing';
      routing: {
        mode: 'auto' | 'manual';
        provider: string | null;
        model: string | null;
        effort: Effort | null;
      };
    };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export function fetchTasks(): Promise<{ tasks: TaskRecord[] }> {
  return getJson('api/tasks');
}

export function fetchTask(id: string): Promise<{ task: TaskRecord; state: TaskState | null }> {
  return getJson(`api/tasks/${encodeURIComponent(id)}`);
}

export function fetchStatus(): Promise<Status> {
  return getJson('api/status');
}

/** Kept on the server: the desktop app's origin (its port) changes per launch. */
export interface Prefs {
  name?: string;
  onboarded?: boolean;
}

export function fetchPrefs(): Promise<Prefs> {
  return getJson('api/prefs');
}

export async function postPrefs(prefs: Prefs): Promise<Prefs> {
  const res = await fetch('api/prefs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(prefs),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? 'That did not go through.');
  return body as Prefs;
}

export function fetchCatalog(): Promise<Catalog> {
  return getJson('api/catalog');
}

export async function postTask(input: {
  text: string;
  agent?: string;
  files: File[];
}): Promise<TaskRecord> {
  let res: Response;
  if (input.files.length) {
    const form = new FormData();
    form.set('text', input.text);
    if (input.agent) form.set('agent', input.agent);
    for (const file of input.files) form.append('files', file, file.name);
    res = await fetch('api/tasks', { method: 'POST', body: form });
  } else {
    res = await fetch('api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: input.text, agent: input.agent }),
    });
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? 'That did not go through.');
  return body.task as TaskRecord;
}

export async function postAnswer(id: string, answer: string, questionId?: string): Promise<void> {
  const res = await fetch(`api/tasks/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer, questionId }),
  });
  if (!res.ok) throw new Error((await res.json())?.error ?? 'That answer did not land.');
}

export function postRead(id: string): void {
  void fetch(`api/tasks/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

export function fetchRouting(): Promise<RoutingState> {
  return getJson('api/routing');
}

export async function postRouting(
  next: { mode: 'auto' } | { mode: 'manual'; provider: string; model: string; effort: Effort },
): Promise<RoutingState> {
  const res = await fetch('api/routing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? 'That did not go through.');
  return body as RoutingState;
}

export function fetchMemory(): Promise<MemoryManifest> {
  return getJson('api/memory/manifest');
}

export async function postMemoryConfirm(path: string, name: string): Promise<void> {
  const res = await fetch('api/memory/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, name }),
  });
  if (!res.ok) throw new Error((await res.json())?.error ?? 'That did not go through.');
}

export async function postMemoryForget(path: string): Promise<void> {
  const res = await fetch('api/memory/forget', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error((await res.json())?.error ?? 'That did not go through.');
}
