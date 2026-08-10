/**
 * Weekly check that every skill in skills-index.json still exists upstream.
 *
 * Run: node dist-scripts/build-skills-index.js
 *
 * Zero runtime dependencies: global fetch plus node: builtins only. stdout is the
 * markdown summary (the workflow uses it verbatim as the PR body), stderr is the log.
 *
 * Exit 0 even when skills are broken, because the pull request is the alert channel.
 * Exit 1 only when the script itself cannot run, so a bug here is never read as
 * "everything is fine".
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ponytail: Skill is mirrored from src/core/skills.ts by hand. tsconfig.scripts.json roots on
// scripts/, so a cross-rootDir import (even type-only) is a hard tsc error. The shape read here
// is three fields wide; move the types to a shared root if that ever grows.
export interface Skill {
  id: string;
  name: string;
  repo?: string;
  path?: string;
}

export type Status = 'ok' | 'moved' | 'gone' | 'unchecked';

export interface Check {
  id: string;
  name: string;
  repo: string;
  path: string;
  status: Status;
  detail: string;
}

export interface Summary {
  markdown: string;
  problems: number;
}

/** `https://github.com/owner/repo` -> `owner/repo`. Anything else is not checkable. */
export function repoSlug(repo: string | undefined): string | undefined {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(repo ?? '');
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : undefined;
}

export function skillUrl(slug: string, path: string): string {
  return `https://raw.githubusercontent.com/${slug}/HEAD/${path.replace(/^\/+|\/+$/g, '')}/SKILL.md`;
}

export function repoUrl(slug: string): string {
  return `https://raw.githubusercontent.com/${slug}/HEAD/README.md`;
}

export type Probe = (url: string) => Promise<number>;

/**
 * One retry, because GitHub answers 429 or 403 under load and a single attempt would
 * report a live skill as gone. A still-throttled probe returns 0, which reads as
 * "could not check" rather than a failure.
 */
export const httpProbe: Probe = async (url) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'aiax-router-skills-index-bot' },
      });
      // Drain the body so the socket is reused instead of hanging on to the response.
      await res.arrayBuffer();
      if (res.status !== 429 && res.status !== 403) return res.status;
    } catch (err) {
      console.error(`probe ${url}: ${message(err)}`);
    }
  }
  return 0;
};

export async function checkSkill(skill: Skill, probe: Probe): Promise<Check> {
  const slug = repoSlug(skill.repo);
  const base = {
    id: skill.id,
    name: skill.name,
    repo: skill.repo ?? '',
    path: skill.path ?? '',
  };
  if (!slug || !skill.path) {
    return { ...base, status: 'unchecked', detail: 'no GitHub repo and path recorded' };
  }

  const status = await probe(skillUrl(slug, skill.path));
  if (status === 200) return { ...base, status: 'ok', detail: 'SKILL.md found' };
  if (status === 0) return { ...base, status: 'unchecked', detail: 'GitHub did not answer' };
  if (status !== 404) {
    return { ...base, status: 'unchecked', detail: `GitHub answered ${status}` };
  }

  // 404 on the skill: separate a moved skill from a repo that is gone entirely.
  const repoStatus = await probe(repoUrl(slug));
  if (repoStatus === 200) {
    return { ...base, status: 'moved', detail: 'the repo is alive but this path has no SKILL.md' };
  }
  if (repoStatus === 0) {
    return { ...base, status: 'unchecked', detail: 'the path 404s and GitHub did not answer' };
  }
  return { ...base, status: 'gone', detail: `the repo answered ${repoStatus}` };
}

export function summarize(checks: Check[], checkedAt: string): Summary {
  const broken = checks.filter((c) => c.status === 'moved' || c.status === 'gone');
  const unchecked = checks.filter((c) => c.status === 'unchecked');
  // Every single skill unchecked means the check itself is broken, which is its own problem.
  const allBlind = checks.length > 0 && unchecked.length === checks.length;
  const problems = broken.length + (allBlind ? 1 : 0);

  const lines: string[] = [];
  lines.push('## Weekly skills index check', '');
  lines.push(`Checked at: \`${checkedAt}\``, '');
  lines.push(
    `${checks.length} ${checks.length === 1 ? 'skill' : 'skills'} in \`skills-index.json\`: ` +
      `${checks.filter((c) => c.status === 'ok').length} ok, ` +
      `${checks.filter((c) => c.status === 'moved').length} moved, ` +
      `${checks.filter((c) => c.status === 'gone').length} gone, ` +
      `${unchecked.length} unchecked.`,
    '',
  );

  lines.push('| skill | repo | path | status | detail |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of checks) {
    lines.push(
      `| \`${c.id}\` | ${c.repo || '-'} | \`${c.path || '-'}\` | ${c.status} | ${c.detail} |`,
    );
  }
  lines.push('');

  lines.push('### Needs a human', '');
  if (broken.length === 0 && !allBlind) {
    lines.push('Nothing: every skill still resolves upstream.');
  } else {
    if (allBlind) {
      lines.push('- [ ] No skill could be checked at all, so look at the job log before the index.');
    }
    for (const c of broken) {
      lines.push(
        `- [ ] \`${c.id}\` is ${c.status}: ${c.detail}. Find the new home or drop it from the index.`,
      );
    }
  }
  lines.push('');
  lines.push(
    'Note: v0 only checks the skills already in `skills-index.json`. It does not discover new skills, and it does not edit the index.',
  );
  lines.push('');
  return { markdown: lines.join('\n'), problems };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function loadSkills(file = join(ROOT, 'skills-index.json')): Skill[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { skills?: unknown };
  if (!Array.isArray(parsed.skills)) throw new Error(`${file} has no skills array`);
  return parsed.skills as Skill[];
}

export async function main(): Promise<number> {
  const skills = loadSkills();
  const checks: Check[] = [];
  for (const skill of skills) {
    const check = await checkSkill(skill, httpProbe);
    console.error(`${check.id}: ${check.status} (${check.detail})`);
    checks.push(check);
  }

  const { markdown, problems } = summarize(
    checks,
    process.env.CHECKED_AT ?? new Date().toISOString(),
  );
  console.log(markdown);
  // The workflow reads this to decide whether a pull request is worth opening.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `problems=${problems}\n`);
  }
  console.error(`${problems} problem(s)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(message(err));
      process.exitCode = 1;
    },
  );
}
