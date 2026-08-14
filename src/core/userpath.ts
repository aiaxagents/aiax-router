import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * A GUI launch (Finder, the Dock, a desktop icon) hands the process launchd's
 * minimal PATH, so `claude`, `codex` and friends look uninstalled even though
 * a terminal finds them fine. Ask the user's login shell for its PATH once and
 * adopt it, then top up with the usual install spots as a fallback.
 */
export function ensureUserPath(): void {
  if (process.platform === 'win32') return;
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const seen = new Set(dirs);
  const home = homedir();
  const candidates = [
    ...loginShellPath().split(delimiter),
    // ponytail: static fallback for when the login shell probe fails
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'bin'),
  ];
  for (const dir of candidates) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }
  process.env.PATH = dirs.join(delimiter);
}

const MARK = '__AIAX_PATH__';

/** The login shell from the passwd database. Windows has none. */
function userShell(): string {
  try {
    return userInfo().shell ?? '';
  } catch {
    return '';
  }
}

/** The user's login-shell PATH, or '' if the shell would not say. */
export function loginShellPath(): string {
  // Some launch contexts hand over no SHELL at all, and /bin/sh reads none of
  // the rc files where a PATH like ~/.kimi-code/bin is set. The passwd entry is
  // the same answer the OS itself would give.
  const shell = process.env.SHELL || userShell() || '/bin/sh';
  // -l loads the profile where PATH is usually set; -i additionally loads rc
  // files (nvm and friends live there), but can misbehave, so it goes first
  // and -l alone is the fallback.
  for (const flag of ['-ilc', '-lc']) {
    try {
      const out = execFileSync(shell, [flag, `echo "${MARK}$PATH"`], {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const found = parseShellPath(out);
      if (found) return found;
    } catch {
      // try the next flag
    }
  }
  return '';
}

/** Pick the marked PATH out of whatever banners or echoes the shell printed. */
export function parseShellPath(out: string): string {
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].lastIndexOf(MARK);
    if (at < 0) continue;
    const value = lines[i].slice(at + MARK.length).trim();
    // A verbose shell echoes the command itself, marker included but with a
    // literal $PATH; only a real expansion counts.
    if (value && !value.includes('$PATH')) return value;
  }
  return '';
}
