import { describe, expect, it } from 'vitest';
import { parseMultipart, safeJoin } from '../src/web/serve.js';
import { safeName } from '../src/web/tasks.js';

/** Builds the exact bytes a browser sends, CRLF and all. */
function form(boundary: string, parts: string[]): Buffer {
  return Buffer.from(`${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--\r\n`);
}

describe('parseMultipart', () => {
  const B = 'x-boundary-1234';

  it('reads a text field and a file from one body', () => {
    const body = form(B, [
      'content-disposition: form-data; name="text"\r\n\r\nWrite the report.',
      'content-disposition: form-data; name="files"; filename="notes.md"\r\ncontent-type: text/markdown\r\n\r\n# Notes\nline two',
    ]);
    const got = parseMultipart(body, B);
    expect(got.fields.text).toBe('Write the report.');
    expect(got.files).toHaveLength(1);
    expect(got.files[0].name).toBe('notes.md');
    expect(got.files[0].data.toString()).toBe('# Notes\nline two');
  });

  it('keeps binary content byte for byte', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x42, 0x00]);
    const head = Buffer.from(
      `--${B}\r\ncontent-disposition: form-data; name="files"; filename="blob.bin"\r\n\r\n`,
    );
    const body = Buffer.concat([head, bytes, Buffer.from(`\r\n--${B}--\r\n`)]);
    const got = parseMultipart(body, B);
    expect(got.files[0].data.equals(bytes)).toBe(true);
  });

  it('strips any path a browser puts in the filename', () => {
    const body = form(B, [
      'content-disposition: form-data; name="files"; filename="../../../etc/passwd"\r\n\r\nroot:x:0:0',
    ]);
    expect(parseMultipart(body, B).files[0].name).toBe('passwd');
  });

  it('skips an empty file part and a part with no headers', () => {
    const body = form(B, [
      'content-disposition: form-data; name="files"; filename="empty.txt"\r\n\r\n',
      'nothing that looks like a header block',
    ]);
    const got = parseMultipart(body, B);
    expect(got.files).toHaveLength(0);
    expect(Object.keys(got.fields)).toHaveLength(0);
  });

  it('returns nothing when the boundary is not in the body', () => {
    const got = parseMultipart(Buffer.from('plain text'), B);
    expect(got.files).toHaveLength(0);
    expect(Object.keys(got.fields)).toHaveLength(0);
  });
});

describe('safeName', () => {
  it('falls back rather than producing an empty or hidden name', () => {
    expect(safeName('...')).toBe('attachment');
    expect(safeName('')).toBe('attachment');
    expect(safeName('.env')).toBe('env');
  });

  it('replaces anything outside the plain set', () => {
    expect(safeName('my report (final).md')).toBe('my_report__final_.md');
  });
});

describe('safeJoin', () => {
  it('resolves a normal path inside the directory', () => {
    expect(safeJoin('/tmp/results', 'answer.md')).toBe('/tmp/results/answer.md');
  });

  it('refuses to climb out, encoded or not', () => {
    expect(safeJoin('/tmp/results', '../../etc/passwd')).toBeNull();
    expect(safeJoin('/tmp/results', '..%2f..%2fetc/passwd')).toBeNull();
    expect(safeJoin('/tmp/results', 'sub/../../../etc/passwd')).toBeNull();
  });

  it('reads a leading slash as the top of the directory, not of the disk', () => {
    expect(safeJoin('/tmp/results', '/etc/passwd')).toBe('/tmp/results/etc/passwd');
  });

  it('refuses a broken percent escape instead of guessing', () => {
    expect(safeJoin('/tmp/results', '%E0%A4%A')).toBeNull();
  });
});
