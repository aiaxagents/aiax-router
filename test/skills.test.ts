import { describe, expect, it } from 'vitest';
import { loadSkills, matchSkills, skillPreamble, type Skill } from '../src/core/skills.js';

const SKILLS: Skill[] = [
  {
    id: 'pdf',
    name: 'PDF handling',
    repo: 'https://example.com/skills',
    path: 'document-skills/pdf',
    categories: ['writing', 'long-context'],
    taskHints: ['pdf'],
    rating: 9,
  },
  {
    id: 'tdd',
    name: 'Test-driven development',
    categories: ['coding', 'agentic-coding'],
    taskHints: ['test', 'tdd', 'bug', 'fix'],
    rating: 8,
  },
  {
    id: 'debug',
    name: 'Systematic debugging',
    categories: ['coding', 'agentic-coding'],
    taskHints: ['debug', 'crash', 'error', 'root cause'],
    rating: 7,
  },
];

describe('matchSkills', () => {
  it('picks the skill the task is actually about', () => {
    const found = matchSkills('fix the failing test in the date parser', 'coding', SKILLS);
    expect(found.map((s) => s.id)).toEqual(['tdd']);
  });

  it('ranks by how many hints the task hits, then by rating', () => {
    const found = matchSkills(
      'debug the crash, find the root cause and fix it with a test',
      'coding',
      SKILLS,
    );
    expect(found.map((s) => s.id)).toEqual(['debug', 'tdd']);
  });

  it('never returns more than the limit', () => {
    expect(matchSkills('debug this crash and fix the bug', 'coding', SKILLS, 1)).toHaveLength(1);
  });

  it('finds nothing when the task is about something else', () => {
    expect(matchSkills('what is the capital of France', 'chat', SKILLS)).toEqual([]);
  });

  it('does not use a skill from another category even when the word matches', () => {
    expect(matchSkills('write a test of my patience', 'writing', SKILLS)).toEqual([]);
  });

  it('matches whole words only', () => {
    expect(matchSkills('rewrite the pdfs page', 'writing', SKILLS)).toEqual([]);
    expect(matchSkills('rewrite the pdf page', 'writing', SKILLS).map((s) => s.id)).toEqual(['pdf']);
  });
});

describe('skillPreamble', () => {
  it('is empty when nothing matched', () => {
    expect(skillPreamble([])).toBe('');
  });

  it('puts the instruction in front of the prompt, with where it comes from', () => {
    const text = skillPreamble([SKILLS[0]]);
    expect(text).toContain('PDF handling');
    expect(text).toContain('document-skills/pdf');
    expect(text.endsWith('\n\n')).toBe(true);
  });
});

describe('loadSkills', () => {
  it('reads the bundled index', () => {
    const skills = loadSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.id && s.name && Array.isArray(s.taskHints))).toBe(true);
  });

  it('returns nothing rather than throwing when the file is missing', () => {
    expect(loadSkills('/nope/skills-index.json')).toEqual([]);
  });
});
