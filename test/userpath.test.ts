import { describe, expect, it } from 'vitest';
import { parseShellPath } from '../src/core/userpath.js';

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
