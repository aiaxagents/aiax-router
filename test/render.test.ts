import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/web/result.js';
import { excerptOf } from '../src/web/tasks.js';

/** The 900-character cut, as the thread shows it. */
describe('excerptOf', () => {
  const long = (text: string): string => text.padEnd(1_200, ' x');

  it('leaves anything short enough exactly as it is', () => {
    expect(excerptOf('Short and done.')).toBe('Short and done.');
  });

  it('never ends mid-word', () => {
    const answer = long('Middag i Molde');
    const cut = excerptOf(answer);
    const body = cut.slice(0, -3);

    expect(cut.endsWith('...')).toBe(true);
    expect(answer.startsWith(body)).toBe(true);
    // What follows the cut in the original has to be a space, or a word got split.
    expect(answer.slice(body.length, body.length + 1)).toMatch(/\s/);
  });

  it('ends on a whole line rather than mid-sentence', () => {
    // The real shape: the cut fell just past a line break, and stopping at the
    // last space instead left the excerpt hanging on "(kilde:".
    const filler = 'Restaurant linje her.\n';
    const tail = 'Åpent i dag: 12:00 (kilde: Wolt).\n';
    const answer = `${filler.repeat(Math.floor((900 - tail.length) / filler.length))}${tail}**Egon Molde**, Storgata 8.`;
    expect(answer.length).toBeGreaterThan(900);
    const cut = excerptOf(answer);

    expect(cut).toContain('(kilde: Wolt)...');
    expect(cut).not.toContain('(kilde:...');
    expect(cut).not.toContain('....');
  });

  it('falls back to a word break when the line would cost the whole excerpt', () => {
    const answer = `# Overskrift\n${'ord '.repeat(400)}`;
    const cut = excerptOf(answer);

    expect(cut.length).toBeGreaterThan(800);
  });

  it('drops a bold marker the cut left hanging', () => {
    // The real one ended "**Ego..." and showed the asterisks in the thread.
    const answer = `${'word '.repeat(178)}**Egoistisk valg** for en fredag`;
    const cut = excerptOf(answer);
    expect(answer.length).toBeGreaterThan(900);
    expect(cut).not.toContain('**');
    expect(cut.endsWith('...')).toBe(true);
  });

  it('keeps bold that is closed inside the cut', () => {
    const answer = `**Hovedvalg:** Tandoori Guru. ${'more text '.repeat(120)}`;
    expect(excerptOf(answer)).toContain('**Hovedvalg:**');
  });
});

describe('renderMarkdown links', () => {
  it('turns a markdown link into a real one', () => {
    const html = renderMarkdown('Bestill: [Wolt](https://wolt.com/nb/nor/molde).');
    expect(html).toContain('<a href="https://wolt.com/nb/nor/molde"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('>Wolt</a>');
  });

  it('leaves a scheme nobody should click as plain characters', () => {
    const html = renderMarkdown('[tap here](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).toContain('[tap here]');
  });

  it('cannot be talked into breaking out of the href', () => {
    const html = renderMarkdown('[x](https://a.no/"onmouseover="alert(1))');
    expect(html).not.toContain('onmouseover="alert');
    expect(html).toContain('&quot;');
  });
});
