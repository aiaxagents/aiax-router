import { userInfo } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loginShellPath, parseShellPath } from '../src/core/userpath.js';

describe('parseShellPath', () => {
  it('reads a clean marked line', () => {
    expect(parseShellPath('__AIAX_PATH__/opt/homebrew/bin:/usr/bin\n')).toBe(
      '/opt/homebrew/bin:/usr/bin',
    );
  });

  it('ignores banners the shell prints first', () => {
    const out = 'Welcome back!\nsome rc noise\n__AIAX_PATH__/usr/local/bin:/usr/bin\n';
    expect(parseShellPath(out)).toBe('/usr/local/bin:/usr/bin');
  });

  it('skips a verbose shell echoing the command itself', () => {
    const out = 'echo "__AIAX_PATH__$PATH"\n__AIAX_PATH__/opt/homebrew/bin:/usr/bin\n';
    expect(parseShellPath(out)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('returns nothing when no marker survived', () => {
    expect(parseShellPath('command not found\n')).toBe('');
  });
});

describe('loginShellPath', () => {
  const had = process.env.SHELL;
  afterEach(() => {
    if (had === undefined) delete process.env.SHELL;
    else process.env.SHELL = had;
  });

  it.skipIf(process.platform === 'win32')('asks the passwd shell when SHELL is missing', () => {
    process.env.SHELL = userInfo().shell ?? '/bin/sh';
    const withShell = loginShellPath();
    delete process.env.SHELL;
    // Not just "non-empty": /bin/sh reads no rc files, so falling back to it
    // would quietly return a shorter PATH than the user's own shell gives.
    expect(loginShellPath()).toBe(withShell);
  });
});
