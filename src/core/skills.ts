import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot } from './paths.js';
import type { Category } from './types.js';

export interface Skill {
  id: string;
  name: string;
  repo?: string;
  path?: string;
  categories: string[];
  taskHints: string[];
  rating: number;
}

function isSkill(value: unknown): value is Skill {
  const s = value as Skill | null;
  return (
    !!s &&
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    Array.isArray(s.categories) &&
    Array.isArray(s.taskHints)
  );
}

/** Bundled index sits next to the files the router ships with. */
export function loadSkills(file = join(appRoot(), 'skills-index.json')): Skill[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const skills = (parsed as { skills?: unknown })?.skills;
    return Array.isArray(skills) ? skills.filter(isSkill) : [];
  } catch {
    return [];
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hits(task: string, hints: string[]): number {
  return hints.filter((h) => new RegExp(`\\b${escape(h)}\\b`, 'i').test(task)).length;
}

/**
 * A skill only counts when it belongs to the category AND the task actually
 * mentions what it is for. Finding nothing is the normal case, and injecting a
 * skill that does not fit costs quality.
 */
export function matchSkills(
  task: string,
  category: Category,
  skills: Skill[] = loadSkills(),
  limit = 2,
): Skill[] {
  return skills
    .map((skill) => ({
      skill,
      score: skill.categories.includes(category) ? hits(task, skill.taskHints) : 0,
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.skill.rating - a.skill.rating)
    .slice(0, limit)
    .map((m) => m.skill);
}

/** v0 injection: the instruction goes in front of the prompt, whichever CLI runs it. */
export function skillPreamble(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => {
    const where = s.repo ? ` (${s.repo}${s.path ? `, ${s.path}` : ''})` : '';
    return `Follow the practices of the "${s.name}" skill${where} while you do this.`;
  });
  return `${lines.join('\n')}\n\n`;
}
