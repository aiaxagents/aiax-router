import { describe, expect, it } from 'vitest';
import {
  checkSkill,
  loadSkills,
  repoSlug,
  repoUrl,
  skillUrl,
  summarize,
  type Check,
  type Probe,
  type Skill,
} from '../scripts/build-skills-index.js';

const SKILL: Skill = {
  id: 'docx',
  name: 'Word documents',
  repo: 'https://github.com/anthropics/skills',
  path: 'skills/docx',
};

/** Fixture probe: a map of url -> status, everything else answers 404. */
function probe(statuses: Record<string, number>): Probe {
  return async (url) => statuses[url] ?? 404;
}

const SKILL_MD = 'https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/docx/SKILL.md';
const README = 'https://raw.githubusercontent.com/anthropics/skills/HEAD/README.md';

describe('repoSlug', () => {
  it('reads owner and repo out of a github url', () => {
    expect(repoSlug('https://github.com/anthropics/skills')).toBe('anthropics/skills');
    expect(repoSlug('https://github.com/obra/superpowers.git')).toBe('obra/superpowers');
  });

  it('gives up on anything that is not github', () => {
    expect(repoSlug('https://gitlab.com/x/y')).toBeUndefined();
    expect(repoSlug(undefined)).toBeUndefined();
  });
});

describe('urls', () => {
  it('points at SKILL.md on the default branch', () => {
    expect(skillUrl('anthropics/skills', 'skills/docx')).toBe(SKILL_MD);
    expect(skillUrl('anthropics/skills', '/skills/docx/')).toBe(SKILL_MD);
    expect(repoUrl('anthropics/skills')).toBe(README);
  });
});

describe('checkSkill', () => {
  it('is ok when SKILL.md is there', async () => {
    const check = await checkSkill(SKILL, probe({ [SKILL_MD]: 200 }));
    expect(check.status).toBe('ok');
  });

  it('is moved when the repo lives but the path does not', async () => {
    const check = await checkSkill(SKILL, probe({ [SKILL_MD]: 404, [README]: 200 }));
    expect(check.status).toBe('moved');
  });

  it('is gone when the repo itself is a 404', async () => {
    const check = await checkSkill(SKILL, probe({}));
    expect(check.status).toBe('gone');
  });

  it('is unchecked, not failed, when github will not answer', async () => {
    const check = await checkSkill(SKILL, probe({ [SKILL_MD]: 0 }));
    expect(check.status).toBe('unchecked');
    expect(check.detail).toMatch(/did not answer/);
  });

  it('is unchecked when the path 404s and the repo probe is throttled', async () => {
    const check = await checkSkill(SKILL, probe({ [SKILL_MD]: 404, [README]: 0 }));
    expect(check.status).toBe('unchecked');
  });

  it('is unchecked when nothing upstream is recorded', async () => {
    const check = await checkSkill({ id: 'x', name: 'X' }, probe({}));
    expect(check.status).toBe('unchecked');
    expect(check.detail).toMatch(/no GitHub repo and path recorded/);
  });

  it('does not call it gone on a server error', async () => {
    const check = await checkSkill(SKILL, probe({ [SKILL_MD]: 500 }));
    expect(check.status).toBe('unchecked');
    expect(check.detail).toMatch(/500/);
  });
});

function check(status: Check['status'], id = status): Check {
  return { id, name: id, repo: 'https://github.com/a/b', path: 'p', status, detail: 'detail' };
}

describe('summarize', () => {
  it('counts no problems when everything resolves', () => {
    const { markdown, problems } = summarize([check('ok'), check('ok', 'ok2')], 'now');
    expect(problems).toBe(0);
    expect(markdown).toContain('Nothing: every skill still resolves upstream.');
    expect(markdown).toContain('| `ok` | https://github.com/a/b | `p` | ok | detail |');
  });

  it('counts moved and gone as problems, with a checklist', () => {
    const { markdown, problems } = summarize([check('ok'), check('moved'), check('gone')], 'now');
    expect(problems).toBe(2);
    expect(markdown).toContain('- [ ] `moved` is moved:');
    expect(markdown).toContain('- [ ] `gone` is gone:');
  });

  it('does not open a pull request over one unchecked skill', () => {
    expect(summarize([check('ok'), check('unchecked')], 'now').problems).toBe(0);
  });

  it('treats a fully blind run as a problem of its own', () => {
    const { markdown, problems } = summarize([check('unchecked'), check('unchecked', 'u2')], 'now');
    expect(problems).toBe(1);
    expect(markdown).toContain('No skill could be checked at all');
  });

  it('says plainly that v0 discovers nothing', () => {
    expect(summarize([check('ok')], 'now').markdown).toContain('It does not discover new skills');
  });
});

describe('loadSkills', () => {
  it('reads the checked-in index', () => {
    const skills = loadSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => typeof s.id === 'string')).toBe(true);
  });
});
