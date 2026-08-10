import type { Provider, TaskRecord } from './api';

/**
 * What a person calls the service they pay for. The engine's own names carry
 * the tool ("Codex CLI"), which means nothing to someone who just has ChatGPT.
 */
const PLAIN: Record<string, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  openai: 'ChatGPT',
  grok: 'Grok',
  kimi: 'Kimi',
};

export function plainName(id: string, fallback = ''): string {
  return PLAIN[id] ?? (fallback.replace(/\s+(CLI|Code)$/, '') || id);
}

/** 1234 -> "1.2k", 2500000 -> "2.5M". Token counts are read, not audited. */
export function fmtTokens(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return String(count);
}

export function fmtCost(usd: number): string {
  if (usd < 0.005) return 'under 1 cent';
  return `$${usd.toFixed(2)}`;
}

export function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

export function clockOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function stampOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('en-GB', { hour12: false });
}

export function today(): string {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function running(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 1) return 'less than a minute';
  return `${min} ${min === 1 ? 'minute' : 'minutes'}`;
}

/** Headroom as a word, never a percentage, because the number is an estimate. */
export function leftWord(headroom: number): string {
  if (headroom > 0.6) return 'plenty left';
  if (headroom > 0.3) return 'about a third left';
  if (headroom > 0.1) return 'not much left';
  return 'almost none left';
}

export function isSameDay(iso: string, when = new Date()): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === when.getFullYear() &&
    d.getMonth() === when.getMonth() &&
    d.getDate() === when.getDate()
  );
}

export function byNewest(a: TaskRecord, b: TaskRecord): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** Anything waiting on the person floats to the top of its column. */
export function boardOrder(a: TaskRecord, b: TaskRecord): number {
  const wait = Number(Boolean(b.question)) - Number(Boolean(a.question));
  return wait || byNewest(a, b);
}

function readyCount(providers: Provider[]): number {
  return providers.filter((p) => p.ready).length;
}

/** The plain sentence the top bar carries on every page. */
export function headline(tasks: TaskRecord[], providers: Provider[]): string {
  const waiting = tasks.filter((t) => t.question).length;
  const live = tasks.filter((t) => t.status === 'running').length;
  if (waiting) {
    return waiting === 1
      ? 'One task is waiting for you.'
      : `${waiting} tasks are waiting for you.`;
  }
  if (live) return live === 1 ? 'One task running.' : `${live} tasks running.`;
  const ready = readyCount(providers);
  if (!ready) return 'No subscription is connected yet.';
  return ready === 1 ? 'One subscription ready.' : `${ready} subscriptions ready.`;
}
