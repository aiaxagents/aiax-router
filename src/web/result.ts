/**
 * The result page. A finished deliverable is a plain file on disk, so the page
 * that shows it is a plain file too: one self-contained document in the app's
 * own language that opens from any device with no build step and no script.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

/**
 * Enough markdown for a deliverable: headings, bullets, numbered lists, fenced
 * code and paragraphs. Anything else lands as a paragraph, which is honest.
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let fence: string[] | null = null;
  const closeList = (): void => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const openList = (kind: 'ul' | 'ol'): void => {
    if (list === kind) return;
    closeList();
    out.push(`<${kind}>`);
    list = kind;
  };

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim().startsWith('```')) {
      if (fence) {
        out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else {
        closeList();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(raw);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      openList('ul');
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      openList('ol');
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (fence) out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
  closeList();
  return out.join('\n');
}

export interface ResultMeta {
  id: string;
  title: string;
  /** One plain sentence about how it went. */
  sentence: string;
  finishedAt: string;
  score?: number;
  rounds?: number;
  files: string[];
}

function footLine(meta: ResultMeta): string {
  if (meta.score === undefined) return 'Nobody was free to check this, so treat it as unchecked.';
  const rounds = meta.rounds ?? 1;
  return `Reviewers gave it ${meta.score} out of 10 after ${rounds} ${rounds === 1 ? 'round' : 'rounds'}.`;
}

export function resultPage(meta: ResultMeta, markdown: string): string {
  const files = meta.files
    .filter((f) => f !== 'index.html')
    .map((f) => `<li><a href="${escapeHtml(encodeURIComponent(f))}">${escapeHtml(f)}</a></li>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>
:root{
  --canvas:oklch(0.976 0.004 258); --panel:oklch(0.994 0.003 258);
  --sunk:oklch(0.966 0.005 258); --line:oklch(0.897 0.006 258);
  --line-strong:oklch(0.790 0.010 258); --text:oklch(0.245 0.010 258);
  --muted:oklch(0.480 0.010 258); --faint:oklch(0.530 0.010 258);
  --accent-ink:oklch(0.472 0.170 32);
  --font:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    --canvas:oklch(0.205 0.006 258); --panel:oklch(0.232 0.007 258);
    --sunk:oklch(0.192 0.006 258); --line:oklch(0.318 0.009 258);
    --line-strong:oklch(0.398 0.010 258); --text:oklch(0.945 0.005 258);
    --muted:oklch(0.722 0.010 258); --faint:oklch(0.646 0.010 258);
    --accent-ink:oklch(0.790 0.140 34);
  }
}
*,*::before,*::after{ box-sizing:border-box; }
body{
  margin:0; background:var(--canvas); color:var(--text); font-family:var(--font);
  font-size:15px; line-height:1.48; letter-spacing:-0.003em; -webkit-font-smoothing:antialiased;
}
.wrap{ max-width:760px; margin:0 auto; padding:40px 24px 72px; }
.back{ font-size:13px; color:var(--muted); text-decoration:none; }
.back:hover{ color:var(--text); }
h1{ font-size:28px; font-weight:600; letter-spacing:-0.024em; line-height:1.12; margin:14px 0 0; }
.now{ font-size:15px; color:var(--muted); margin-top:7px; }
.when{ font-size:12.5px; color:var(--faint); font-variant-numeric:tabular-nums; margin-top:4px; }
.body{ margin-top:26px; padding-top:20px; border-top:1px solid var(--line); }
.body h2{ font-size:22px; font-weight:600; letter-spacing:-0.020em; margin:26px 0 8px; }
.body h3{ font-size:17px; font-weight:600; letter-spacing:-0.012em; margin:22px 0 6px; }
.body h4{ font-size:13px; font-weight:600; letter-spacing:0.02em; margin:18px 0 6px; }
.body p{ margin:0 0 11px; }
.body ul,.body ol{ margin:0 0 12px; padding-left:20px; }
.body li{ margin-bottom:4px; }
.body code{ font-family:var(--mono); font-size:13px; background:var(--sunk); padding:1px 4px; border-radius:4px; }
.body pre{
  background:var(--panel); border:1px solid var(--line); border-radius:6px;
  padding:12px 14px; overflow-x:auto; margin:0 0 12px;
}
.body pre code{ background:none; padding:0; font-size:12.5px; line-height:1.5; }
.foot{ margin-top:32px; padding-top:14px; border-top:1px solid var(--line); }
.label{
  font-size:12px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase;
  color:var(--faint); margin-bottom:5px;
}
.foot p{ margin:0 0 14px; font-size:14px; color:var(--text); }
.foot ul{ margin:0; padding:0; list-style:none; }
.foot li{ margin-bottom:3px; font-size:13px; }
.foot a{ color:var(--accent-ink); text-underline-offset:2px; }
</style>
</head>
<body>
<div class="wrap">
  <a class="back" href="../../#/tasks">Back to your tasks</a>
  <h1>${escapeHtml(meta.title)}</h1>
  <p class="now">${escapeHtml(meta.sentence)}</p>
  <p class="when">Finished ${escapeHtml(meta.finishedAt)}</p>

  <div class="body">
${renderMarkdown(markdown)}
  </div>

  <div class="foot">
    <div class="label">Review</div>
    <p>${escapeHtml(footLine(meta))}</p>
    <div class="label">Files</div>
    <ul>
${files || '<li>Only this page.</li>'}
    </ul>
  </div>
</div>
</body>
</html>
`;
}
