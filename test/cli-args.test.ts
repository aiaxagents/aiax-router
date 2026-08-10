import { describe, expect, it } from 'vitest';
import { parseRunArgs } from '../src/cli/index.js';

describe('parseRunArgs', () => {
  it('reads a plain task', () => {
    const args = parseRunArgs(['write', 'me', 'a', 'haiku']);
    expect(args).toMatchObject({
      task: 'write me a haiku',
      dryRun: false,
      fast: false,
      simple: false,
      maxRounds: undefined,
    });
  });

  it('keeps the flags out of the task', () => {
    const args = parseRunArgs(['--simple', 'write', 'a', 'haiku']);
    expect(args.simple).toBe(true);
    expect(args.task).toBe('write a haiku');
  });

  it('reads the one-model, no-review path', () => {
    const args = parseRunArgs(['rename', 'x', 'to', 'y', '--fast']);
    expect(args.fast).toBe(true);
    expect(args.task).toBe('rename x to y');
  });

  it('reads the round cap and drops its number from the task', () => {
    const args = parseRunArgs(['fix', 'the', 'parser', '--max-rounds', '2']);
    expect(args.maxRounds).toBe(2);
    expect(args.task).toBe('fix the parser');
  });

  it('flags a round cap that is not a usable number', () => {
    expect(parseRunArgs(['do', 'it', '--max-rounds', 'lots']).badRounds).toBe('lots');
    expect(parseRunArgs(['do', 'it', '--max-rounds', '0']).badRounds).toBe('0');
    expect(parseRunArgs(['do', 'it', '--max-rounds', '99']).badRounds).toBe('99');
    expect(parseRunArgs(['do', 'it', '--max-rounds', '3']).badRounds).toBeUndefined();
  });

  it('still understands the dry run', () => {
    const args = parseRunArgs(['--dry-run', 'rename', 'x']);
    expect(args.dryRun).toBe(true);
    expect(args.task).toBe('rename x');
  });

  it('notices an empty task', () => {
    expect(parseRunArgs(['--simple']).task).toBe('');
  });
});
