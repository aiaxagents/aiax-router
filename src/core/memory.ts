import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { Adapter } from '../adapters/types.js';
import { ask, asString, cheapestCandidate, parseJsonObject } from './ask.js';
import { appRoot } from './paths.js';
import { configPath, readJson } from './store.js';
import type { TaskState } from './taskstate.js';
import type { Classification, RoutingTable } from './types.js';

/**
 * Durable memory: an OKF v0.2 knowledge bundle at `~/.aiax-router/memory/`.
 * Plain markdown with YAML frontmatter, readable in any editor and openable
 * as an Obsidian vault. This module owns bundle IO, page selection for the
 * intent brief, the distiller and every guard. The web layer only exposes it.
 *
 * Reading is permissive per the spec: unknown types, unknown keys, broken
 * links and unparseable frontmatter never reject a page. Writing follows the
 * strict producer contract.
 */

export const OKF_VERSION = '0.2';

/** Size cap per page the router writes. Hand-edited pages may be any size. */
export const MAX_PAGE_BYTES = 8 * 1024;
/** Cap per distillation round, so one episode can never flood the bundle. */
export const MAX_ROUND_PAGES = 5;
/** The fixed byte budget the intent brief spends on memory. */
export const DEFAULT_MEMORY_BUDGET = 8 * 1024;
/** A page served over the wire is refused past this, whatever wrote it. */
export const MAX_SERVED_PAGE_BYTES = 64 * 1024;

const STALE_DRAFT_DAYS = 90;
const STALE_CONFIRMED_DAYS = 365;
const DISTILL_TIMEOUT_MS = 90_000;
const DISTILL_STATE_CHARS = 6_000;

/** The type vocabulary the router emits. Anything else reads as a generic concept. */
const TYPE_DIRS: Record<string, string> = {
  Preference: 'preferences',
  Person: 'people',
  Project: 'projects',
  Correction: 'corrections',
  Playbook: 'playbooks',
  Service: 'services',
  Machine: 'machines',
};

const KIND_TO_TYPE: Record<string, string> = {
  preference: 'Preference',
  person: 'Person',
  project: 'Project',
  correction: 'Correction',
  playbook: 'Playbook',
  service: 'Service',
};

// --- paths and identity ------------------------------------------------------

export function memoryDir(): string {
  return configPath('memory');
}

export function inboxDir(machine: string): string {
  return configPath('memory-inbox', safeSegment(machine));
}

/** One path segment from outside input: never empty, never a traversal. */
function safeSegment(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return clean.slice(0, 80) || 'peer';
}

export function routerActor(): string {
  const pkg = readJson<{ version?: string }>(join(appRoot(), 'package.json'), {});
  return `aiax-router/${pkg.version ?? '0'}`;
}

export function machineName(): string {
  return safeSegment(hostname().split('.')[0].toLowerCase());
}

function isoNow(): string {
  return new Date().toISOString();
}

function isoToday(): string {
  return isoNow().slice(0, 10);
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// --- secret guard ------------------------------------------------------------

/** The same patterns the OKF linter checks for. Enforced before any write. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [
    /(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{16,}/i,
    'credential assignment',
  ],
  [/\bsk-[A-Za-z0-9]{20,}/, 'provider key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}\./, 'JWT'],
];

/** The label of the first secret-looking pattern in the text, or null. */
export function findSecret(text: string): string | null {
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

// --- narrow YAML-subset frontmatter reader -----------------------------------

/**
 * The router parses only the subset it emits: top-level scalars, inline maps,
 * inline string lists, block lists of scalars or inline maps, and simple
 * nested scalar maps (for hand-authored pages). Anything else within a key
 * is kept as its raw text; a structurally broken block returns null and the
 * page degrades to a generic concept, never a rejection.
 */
export function parseFrontmatterBlock(block: string): Record<string, unknown> | null {
  const lines = block.split('\n');
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return null;
    const key = m[1];
    const rest = m[2].trim();
    if (rest) {
      out[key] = parseScalarish(rest);
      i++;
      continue;
    }
    // Empty value: gather the indented block under it.
    const raw: string[] = [];
    let j = i + 1;
    while (j < lines.length && (!lines[j].trim() || /^\s/.test(lines[j]))) {
      if (lines[j].trim()) raw.push(lines[j]);
      j++;
    }
    out[key] = parseIndentedBlock(raw);
    i = j;
  }
  return out;
}

function parseIndentedBlock(raw: string[]): unknown {
  if (!raw.length) return '';
  if (raw.every((l) => l.trim().startsWith('- '))) {
    const items = raw.map((l) => parseListItem(l.trim().slice(2).trim()));
    if (items.every((it) => it !== null)) return items;
    return raw.join('\n');
  }
  // A simple nested map of scalars, the shape a hand author writes.
  const map: Record<string, unknown> = {};
  for (const l of raw) {
    const m = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(l);
    if (!m || !m[2].trim()) return raw.join('\n');
    map[m[1]] = parseScalarish(m[2].trim());
  }
  return map;
}

function parseListItem(text: string): unknown | null {
  if (text.startsWith('{')) return parseInlineMap(text);
  return parseScalar(text);
}

function parseInlineMap(text: string): Record<string, string> | null {
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const inner = text.slice(1, -1);
  if (inner.includes('{') || inner.includes('}')) return null;
  const out: Record<string, string> = {};
  for (const part of inner.split(',')) {
    if (!part.trim()) continue;
    const at = part.indexOf(':');
    if (at < 0) return null;
    const key = part.slice(0, at).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return null;
    out[key] = parseScalar(part.slice(at + 1).trim());
  }
  return out;
}

function parseScalarish(text: string): unknown {
  if (text.startsWith('{')) return parseInlineMap(text) ?? text;
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((p) => parseScalar(p.trim()));
  }
  return parseScalar(text);
}

function parseScalar(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // fall through to the plain strip
    }
    return text.slice(1, -1);
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

// --- pages -------------------------------------------------------------------

export interface VerifiedEntry {
  by: string;
  at: string;
}

export interface MemoryPage {
  /** Bundle-relative path, e.g. `preferences/short-answers.md`. */
  path: string;
  type: string;
  title: string;
  description: string;
  tags: string[];
  status: 'draft' | 'stable' | 'deprecated';
  staleAfter?: string;
  generatedBy: string;
  generatedAt: string;
  verified: VerifiedEntry[];
  machine?: string;
  /** False when the YAML would not parse: consumed as a generic concept, never rewritten. */
  parsed: boolean;
  /** The frontmatter block text, kept verbatim so unknown keys survive edits. */
  fmBlock: string;
  body: string;
  raw: string;
}

function splitFrontmatter(raw: string): { block: string | null; body: string } {
  if (!raw.startsWith('---')) return { block: null, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { block: null, body: raw };
  return { block: raw.slice(raw.indexOf('\n') + 1, end), body: raw.slice(end + 4) };
}

function titleFromPath(rel: string): string {
  const base = rel.split('/').pop() ?? rel;
  return base.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim() || rel;
}

function asVerified(value: unknown): VerifiedEntry[] {
  // A bare mapping is a one-element list, per the spec.
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: VerifiedEntry[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const by = asString(row.by);
    if (by) out.push({ by, at: asString(row.at) });
  }
  return out;
}

export function pageFromRaw(rel: string, raw: string): MemoryPage {
  const { block, body } = splitFrontmatter(raw);
  const fm = block === null ? null : parseFrontmatterBlock(block);
  if (!fm) {
    return {
      path: rel,
      type: 'Concept',
      title: titleFromPath(rel),
      description: '',
      tags: [],
      status: 'stable',
      generatedBy: '',
      generatedAt: '',
      verified: [],
      parsed: false,
      fmBlock: block ?? '',
      body,
      raw,
    };
  }
  const generated =
    fm.generated && typeof fm.generated === 'object' && !Array.isArray(fm.generated)
      ? (fm.generated as Record<string, unknown>)
      : {};
  const status = asString(fm.status);
  const tags = Array.isArray(fm.tags)
    ? fm.tags.filter((t): t is string => typeof t === 'string')
    : [];
  return {
    path: rel,
    type: asString(fm.type, 'Concept'),
    title: asString(fm.title, titleFromPath(rel)),
    description: asString(fm.description),
    tags,
    status: status === 'draft' || status === 'deprecated' ? status : 'stable',
    staleAfter: asString(fm.stale_after) || undefined,
    generatedBy: asString(generated.by),
    // v0.1 legacy timestamp is the accepted fallback for generated.at.
    generatedAt: asString(generated.at) || asString(fm.timestamp),
    verified: asVerified(fm.verified),
    machine: asString(fm.machine) || undefined,
    parsed: true,
    fmBlock: block ?? '',
    body,
    raw,
  };
}

const RESERVED = new Set(['index.md', 'log.md']);

function walkPages(dir: string, prefix = ''): MemoryPage[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: MemoryPage[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkPages(join(dir, entry.name), rel));
      continue;
    }
    if (!entry.name.endsWith('.md') || RESERVED.has(entry.name)) continue;
    try {
      out.push(pageFromRaw(rel, readFileSync(join(dir, entry.name), 'utf8')));
    } catch {
      // a file that vanished mid-walk is simply not a page
    }
  }
  return out;
}

export function listPages(): MemoryPage[] {
  return walkPages(memoryDir());
}

export type TrustTier = 'human' | 'machine' | 'unverified';

export function trustTier(page: MemoryPage): TrustTier {
  if (!page.verified.length) return 'unverified';
  return page.verified.some((v) => v.by.startsWith('human:')) ? 'human' : 'machine';
}

export function isStale(page: MemoryPage, today = isoToday()): boolean {
  if (!page.staleAfter || !/^\d{4}-\d{2}-\d{2}$/.test(page.staleAfter)) return false;
  return today >= page.staleAfter;
}

// --- writing: the strict producer --------------------------------------------

function scalarOut(value: string): string {
  return /[:#[\]{}"',]|^\s|\s$|^$/.test(value) ? JSON.stringify(value) : value;
}

function renderVerified(entries: VerifiedEntry[]): string[] {
  const lines = ['verified:'];
  for (const v of entries) lines.push(`  - { by: ${v.by}, at: ${v.at} }`);
  return lines;
}

export interface PageContent {
  type: string;
  title: string;
  description: string;
  tags: string[];
  status: 'draft' | 'stable' | 'deprecated';
  staleAfter?: string;
  generatedBy: string;
  generatedAt: string;
  verified?: VerifiedEntry[];
  machine?: string;
  body: string;
}

export function renderPage(p: PageContent): string {
  const lines = ['---', `type: ${scalarOut(p.type)}`, `title: ${scalarOut(p.title)}`];
  if (p.description) lines.push(`description: ${scalarOut(p.description)}`);
  if (p.tags.length) lines.push(`tags: [${p.tags.map(scalarOut).join(', ')}]`);
  lines.push(`generated: { by: ${p.generatedBy}, at: ${p.generatedAt} }`);
  if (p.verified?.length) lines.push(...renderVerified(p.verified));
  lines.push(`status: ${p.status}`);
  if (p.staleAfter) lines.push(`stale_after: ${p.staleAfter}`);
  if (p.machine) lines.push(`machine: ${p.machine}`);
  lines.push('---', '', p.body.trim(), '');
  return lines.join('\n');
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Replaces one top-level key's whole span inside a frontmatter block, or
 * appends it, leaving every other line byte for byte as it was. This is how
 * unknown keys survive an update without a lossy re-serialization.
 */
export function replaceKey(block: string, key: string, rendered: string[] | null): string {
  const lines = block.length ? block.split('\n') : [];
  const isTop = (l: string): boolean => /^[A-Za-z0-9_-]+\s*:/.test(l);
  const start = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (start < 0) {
    if (rendered) lines.push(...rendered);
    return lines.join('\n');
  }
  let end = start + 1;
  while (end < lines.length && !isTop(lines[end])) end++;
  lines.splice(start, end - start, ...(rendered ?? []));
  return lines.join('\n');
}

// --- log ---------------------------------------------------------------------

const LOG_TITLE = '# Memory log';

/** One line under today's ISO heading, newest first, per OKF section 9. */
export function memoryLog(line: string): void {
  const path = join(memoryDir(), 'log.md');
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = `${LOG_TITLE}\n`;
  }
  const today = isoToday();
  const heading = `## ${today}`;
  const entry = `* ${line}`;
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at >= 0) {
    lines.splice(at + 1, 0, entry);
  } else {
    const firstDay = lines.findIndex((l) => l.startsWith('## '));
    const block = [heading, entry, ''];
    if (firstDay >= 0) lines.splice(firstDay, 0, ...block);
    else lines.push('', ...block);
  }
  writeAtomic(path, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

// --- bundle init and index ---------------------------------------------------

export function ensureBundle(): void {
  const dir = memoryDir();
  const index = join(dir, 'index.md');
  if (existsSync(index)) return;
  mkdirSync(dir, { recursive: true });
  regenerateIndex();
  memoryLog('**Initialization**: Started the memory bundle.');
}

const SECTION_ORDER = [
  'preferences',
  'people',
  'projects',
  'corrections',
  'playbooks',
  'services',
  'machines',
];

function sectionTitle(dir: string): string {
  return dir.charAt(0).toUpperCase() + dir.slice(1);
}

/** The bundle-root index.md: progressive disclosure, regenerated on every write. */
export function regenerateIndex(): void {
  const pages = listPages();
  const byDir = new Map<string, MemoryPage[]>();
  for (const page of pages) {
    const dir = page.path.includes('/') ? page.path.split('/')[0] : '.';
    const list = byDir.get(dir) ?? [];
    list.push(page);
    byDir.set(dir, list);
  }
  const lines = [
    '---',
    `okf_version: "${OKF_VERSION}"`,
    '---',
    '',
    '# What the router remembers',
    '',
    'One page per thing worth keeping. The router writes these files; every one is',
    'plain markdown you can read and edit. Types used here: Preference, Person,',
    'Project, Correction, Playbook, Service, Machine.',
    '',
  ];
  const dirs = [
    ...SECTION_ORDER.filter((d) => byDir.has(d)),
    ...[...byDir.keys()].filter((d) => !SECTION_ORDER.includes(d)).sort(),
  ];
  for (const dir of dirs) {
    lines.push(`# ${dir === '.' ? 'Pages' : sectionTitle(dir)}`, '');
    for (const page of byDir.get(dir) ?? []) {
      const desc = page.description || page.type;
      lines.push(`* [${page.title}](${page.path}) - ${desc}`);
    }
    lines.push('');
  }
  writeAtomic(join(memoryDir(), 'index.md'), lines.join('\n'));
}

// --- page IO with guards -----------------------------------------------------

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'page';
}

export function findPage(pages: MemoryPage[], type: string, title: string): MemoryPage | undefined {
  const wantType = type.toLowerCase();
  const wantTitle = title.trim().toLowerCase();
  return pages.find(
    (p) => p.type.toLowerCase() === wantType && p.title.trim().toLowerCase() === wantTitle,
  );
}

export type WriteOutcome =
  | { ok: true; path: string; created: boolean }
  | { ok: false; reason: string };

/**
 * Creates or updates one page, with every hard guard in one place: the secret
 * patterns, the per-page size cap, dedupe by type + title, and the rule that a
 * hand-written page the reader could not parse is never rewritten. Every write
 * appends one line to log.md.
 */
export function savePage(content: PageContent, note?: string): WriteOutcome {
  ensureBundle();
  const rendered = renderPage(content);
  const secret = findSecret(rendered);
  if (secret) {
    memoryLog(`**Drop**: Refused "${content.title}", it looked like it held a ${secret}.`);
    return { ok: false, reason: `looked like a ${secret}` };
  }
  if (Buffer.byteLength(rendered) > MAX_PAGE_BYTES) {
    memoryLog(`**Drop**: Refused "${content.title}", too big for one page.`);
    return { ok: false, reason: 'too big for one page' };
  }

  const pages = listPages();
  // A hand-written page whose YAML would not parse reads as a generic concept,
  // so it is matched by title alone. The user's own edits win: never rewritten,
  // never duplicated.
  const wantTitle = content.title.trim().toLowerCase();
  const handWritten = pages.find(
    (p) => !p.parsed && p.title.trim().toLowerCase() === wantTitle,
  );
  if (handWritten) return { ok: true, path: handWritten.path, created: false };
  const existing = findPage(pages, content.type, content.title);

  if (existing) {
    // Update in place: new generated, fresh body, verified history and every
    // unknown key kept verbatim.
    let block = existing.fmBlock;
    block = replaceKey(block, 'title', [`title: ${scalarOut(content.title)}`]);
    block = replaceKey(
      block,
      'description',
      content.description ? [`description: ${scalarOut(content.description)}`] : null,
    );
    block = replaceKey(
      block,
      'tags',
      content.tags.length ? [`tags: [${content.tags.map(scalarOut).join(', ')}]`] : null,
    );
    block = replaceKey(block, 'generated', [
      `generated: { by: ${content.generatedBy}, at: ${content.generatedAt} }`,
    ]);
    block = replaceKey(block, 'status', [`status: ${existing.status}`]);
    block = replaceKey(
      block,
      'stale_after',
      content.staleAfter ? [`stale_after: ${content.staleAfter}`] : null,
    );
    if (content.machine) {
      block = replaceKey(block, 'machine', [`machine: ${content.machine}`]);
    }
    const updated = `---\n${block}\n---\n\n${content.body.trim()}\n`;
    const secretNow = findSecret(updated);
    if (secretNow) {
      memoryLog(`**Drop**: Refused "${content.title}", it looked like it held a ${secretNow}.`);
      return { ok: false, reason: `looked like a ${secretNow}` };
    }
    writeAtomic(join(memoryDir(), existing.path), updated);
    memoryLog(`**Update**: Refreshed [${content.title}](/${existing.path}).${note ? ` ${note}` : ''}`);
    regenerateIndex();
    return { ok: true, path: existing.path, created: false };
  }

  const dir = TYPE_DIRS[content.type] ?? 'concepts';
  let rel = `${dir}/${slugify(content.title)}.md`;
  if (pages.some((p) => p.path === rel)) {
    rel = `${dir}/${slugify(content.title)}-${Date.now().toString(36)}.md`;
  }
  writeAtomic(join(memoryDir(), rel), rendered);
  memoryLog(`**Creation**: Added [${content.title}](/${rel}).${note ? ` ${note}` : ''}`);
  regenerateIndex();
  return { ok: true, path: rel, created: true };
}

// --- confirm and forget (the Settings actions) -------------------------------

/** `human:<name>` needs a name that stays one clean actor id. */
function humanActor(name: string): string {
  const clean = name.trim().replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, '-');
  return `human:${clean.slice(0, 60) || 'someone'}`;
}

export function confirmPage(rel: string, name: string): { ok: boolean; reason?: string } {
  const pages = listPages();
  const page = pages.find((p) => p.path === rel);
  if (!page) return { ok: false, reason: 'That one is not here any more.' };
  if (!page.parsed) {
    return { ok: false, reason: 'That note is one you wrote yourself, so it is yours to edit.' };
  }
  const verified = [...page.verified, { by: humanActor(name), at: isoNow() }];
  let block = replaceKey(page.fmBlock, 'verified', renderVerified(verified));
  block = replaceKey(block, 'status', [
    `status: ${page.status === 'deprecated' ? 'deprecated' : 'stable'}`,
  ]);
  block = replaceKey(block, 'stale_after', [`stale_after: ${plusDays(STALE_CONFIRMED_DAYS)}`]);
  writeAtomic(join(memoryDir(), rel), `---\n${block}\n---\n\n${page.body.trim()}\n`);
  memoryLog(`**Confirmation**: [${page.title}](/${rel}) confirmed by ${humanActor(name)}.`);
  regenerateIndex();
  return { ok: true };
}

export function forgetPage(rel: string): { ok: boolean; reason?: string } {
  const pages = listPages();
  const page = pages.find((p) => p.path === rel);
  if (!page) return { ok: false, reason: 'That one is not here any more.' };
  rmSync(join(memoryDir(), rel), { force: true });
  memoryLog(`**Deletion**: Forgot "${page.title}" (${rel}) on request.`);
  regenerateIndex();
  return { ok: true };
}

// --- manifest ----------------------------------------------------------------

export interface ManifestPage {
  path: string;
  type: string;
  title: string;
  description: string;
  status: string;
  generatedAt: string;
  hash: string;
  tier: TrustTier;
  stale: boolean;
}

export function memoryManifest(): { okf_version: string; pages: ManifestPage[] } {
  return {
    okf_version: OKF_VERSION,
    pages: listPages().map((p) => ({
      path: p.path,
      type: p.type,
      title: p.title,
      description: p.description,
      status: p.status,
      generatedAt: p.generatedAt,
      hash: `sha256:${createHash('sha256').update(p.raw).digest('hex')}`,
      tier: trustTier(p),
      stale: isStale(p),
    })),
  };
}

// --- selection: what enters a prompt -----------------------------------------

/**
 * The pages the intent stage receives, in this order and never past the budget:
 * the root index (progressive disclosure), every stable human-verified
 * Preference, then type/tag matches for the classification ranked by trust
 * tier and then recency. Deprecated and stale pages never enter a prompt.
 */
export function selectPages(
  classification: Pick<Classification, 'category'> | null,
  pages = listPages(),
): MemoryPage[] {
  const live = pages.filter((p) => p.status !== 'deprecated' && !isStale(p));
  const tierRank: Record<TrustTier, number> = { human: 2, machine: 1, unverified: 0 };
  const always = live.filter(
    (p) => p.type === 'Preference' && p.status === 'stable' && trustTier(p) === 'human',
  );
  const category = classification?.category ?? '';
  const matches = live
    .filter((p) => !always.includes(p))
    .filter((p) => p.tags.includes(category) || p.type.toLowerCase() === category)
    .sort(
      (a, b) =>
        tierRank[trustTier(b)] - tierRank[trustTier(a)] ||
        (b.generatedAt || '').localeCompare(a.generatedAt || ''),
    );
  return [...always, ...matches];
}

export function memoryBrief(
  classification: Pick<Classification, 'category'> | null,
  budget = DEFAULT_MEMORY_BUDGET,
): string {
  let index = '';
  try {
    index = readFileSync(join(memoryDir(), 'index.md'), 'utf8');
  } catch {
    return '';
  }
  const selected = selectPages(classification);
  if (!selected.length && !listPages().length) return '';

  const parts: string[] = [];
  let used = 0;
  const push = (text: string): boolean => {
    const size = Buffer.byteLength(text) + 2;
    if (used + size > budget) return false;
    parts.push(text);
    used += size;
    return true;
  };
  push(index.trim());
  for (const page of selected) {
    // Pages travel verbatim; one that does not fit is skipped, not truncated.
    push(`--- ${page.path} ---\n${page.raw.trim()}`);
  }
  return parts.join('\n\n');
}

// --- the distiller -----------------------------------------------------------

function distillPrompt(state: TaskState): string {
  const record = JSON.stringify({
    task: state.task,
    intent: state.intent,
    decisions: state.decisions,
    answered: state.needsYourCall.filter((q) => q.answer).map((q) => ({
      question: q.question,
      answer: q.answer,
    })),
    results: state.results.map((r) => ({ title: r.title, summary: r.summary })),
  }).slice(0, DISTILL_STATE_CHARS);

  return `You keep a small notebook of durable facts for a personal task router. From the finished task record below, pull out ONLY things worth remembering for future, unrelated tasks:

- "preference": how this person wants things done, stated or clearly shown
- "correction": something the router or a model got wrong, and the fix
- "person": a person the user named, and who they are
- "project": ongoing work of theirs and its constraints
- "playbook": a multi-step procedure that worked and would work again
- "service": an external service the user described using

Skip one-off details, task-specific content and anything you are unsure about. Most tasks contain nothing durable, and an empty list is the normal answer. Never include passwords, keys, tokens or anything that looks like one.

The task record:
${record}

Reply with ONLY this JSON object, nothing before or after it, and no markdown fences:
{"pages":[{"kind":"preference","title":"under eight words","description":"one sentence","body":"a few lines of markdown","tags":["lowercase","short"]}]}`;
}

/**
 * The cheap-model pass that runs after a task completes. Extracts durable
 * candidates from the episode's state, dedupes by type + title, and writes
 * through every guard. No model available means no distillation, silently:
 * memory must never fail a task.
 */
export async function distillEpisode(
  state: TaskState,
  opts: {
    available?: Set<string>;
    table?: RoutingTable;
    adapters?: Adapter[];
    machine?: string;
  } = {},
): Promise<void> {
  try {
    const candidate =
      opts.available && opts.table ? cheapestCandidate(opts.available, opts.table) : undefined;
    if (!candidate) return;
    const { ok, text } = await ask(candidate, distillPrompt(state), {
      effort: 'low',
      timeoutMs: DISTILL_TIMEOUT_MS,
      adapters: opts.adapters,
    });
    if (!ok) return;
    const parsed = parseJsonObject(text);
    const list = Array.isArray(parsed?.pages) ? (parsed.pages as unknown[]) : [];
    if (!list.length) return;

    const actor = routerActor();
    const machine = opts.machine ?? machineName();
    for (const entry of list.slice(0, MAX_ROUND_PAGES)) {
      const row = entry as Record<string, unknown>;
      const type = KIND_TO_TYPE[asString(row.kind).toLowerCase()];
      const title = asString(row.title);
      const body = asString(row.body);
      if (!type || !title || !body) continue;
      savePage(
        {
          type,
          title,
          description: asString(row.description),
          tags: (Array.isArray(row.tags) ? row.tags : [])
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.toLowerCase().slice(0, 24))
            .slice(0, 6),
          status: 'draft',
          staleAfter: plusDays(STALE_DRAFT_DAYS),
          generatedBy: actor,
          generatedAt: isoNow(),
          machine,
          body,
        },
        `Distilled from task ${state.id}.`,
      );
    }
  } catch {
    // memory is a side effect; the task result already exists and stands
  }
}

// --- proposals from fleet peers ----------------------------------------------

export interface ProposalOutcome {
  accepted: number;
  corrections: number;
  dropped: number;
}

/**
 * Candidate pages that rode home with a peer's result. They land in
 * `memory-inbox/<machine>/` first, then merge through the same dedupe and
 * secret guards as local distillation, keeping the peer's `generated` and
 * `machine` provenance. A proposal that contradicts a human-verified stable
 * page never overwrites it: it becomes a draft Correction linking to what it
 * contradicts. Built for fleet sharing (docs/PRD.md 6.7); nothing calls it in
 * this build yet, so today it is exercised by its tests only.
 */
export function acceptProposals(machine: string, rawPages: string[]): ProposalOutcome {
  ensureBundle();
  const inbox = inboxDir(machine);
  mkdirSync(inbox, { recursive: true });
  const out: ProposalOutcome = { accepted: 0, corrections: 0, dropped: 0 };

  for (const raw of rawPages) {
    const page = pageFromRaw('proposal.md', raw);
    const file = join(inbox, `${slugify(page.title)}-${Date.now().toString(36)}.md`);

    const secret = findSecret(raw);
    if (secret) {
      out.dropped++;
      memoryLog(
        `**Drop**: Refused a proposal from ${safeSegment(machine)}, it looked like it held a ${secret}.`,
      );
      continue;
    }
    writeFileSync(file, raw);

    const peerActor = page.generatedBy || `${safeSegment(machine)}/peer`;
    const peerAt = page.generatedAt || isoNow();
    const peerMachine = page.machine ?? safeSegment(machine);
    const pages = listPages();
    const existing = findPage(pages, page.type, page.title);

    const conflictsWithHuman =
      existing &&
      existing.status === 'stable' &&
      trustTier(existing) === 'human' &&
      existing.body.trim() !== page.body.trim();

    if (conflictsWithHuman && existing) {
      const saved = savePage(
        {
          type: 'Correction',
          title: `Correction: ${page.title}`,
          description: `A peer disagrees with [${existing.title}](/${existing.path}).`,
          tags: page.tags,
          status: 'draft',
          staleAfter: plusDays(STALE_DRAFT_DAYS),
          generatedBy: peerActor,
          generatedAt: peerAt,
          machine: peerMachine,
          body: `${safeSegment(machine)} came home with a different take on [${existing.title}](/${existing.path}), which you confirmed yourself. The confirmed page stands until you say otherwise.\n\nWhat the peer claims:\n\n${page.body.trim()}`,
        },
        `Proposal from ${safeSegment(machine)}.`,
      );
      if (saved.ok) out.corrections++;
      else out.dropped++;
    } else {
      // Trust is earned at this machine: a proposal always lands as a draft
      // and never imports verification events.
      const saved = savePage(
        {
          type: page.type,
          title: page.title,
          description: page.description,
          tags: page.tags,
          status: 'draft',
          staleAfter: plusDays(STALE_DRAFT_DAYS),
          generatedBy: peerActor,
          generatedAt: peerAt,
          machine: peerMachine,
          body: page.body,
        },
        `Proposal from ${safeSegment(machine)}.`,
      );
      if (saved.ok) out.accepted++;
      else out.dropped++;
    }
    rmSync(file, { force: true });
  }
  return out;
}
