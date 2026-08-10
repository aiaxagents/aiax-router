import type { ReactNode } from 'react';

/**
 * Just enough markdown for a deliverable shown inside the thread: headings,
 * bullets, numbered lists and paragraphs. It builds elements rather than
 * markup, so nothing a model writes can ever become live HTML.
 */
export function Markdown({ text, limit }: { text: string; limit?: number }) {
  const source = limit && text.length > limit ? `${text.slice(0, limit).trimEnd()}...` : text;
  const out: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  let key = 0;

  const flush = (): void => {
    if (!list.length) return;
    out.push(
      <ul className="bul" key={`l${key++}`}>
        {list.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (code !== null) {
      if (line.startsWith('```')) {
        out.push(
          <pre className="codeblock" key={`c${key++}`}>
            <code>{code.join('\n')}</code>
          </pre>,
        );
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (line.startsWith('```')) {
      flush();
      code = [];
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const Tag = heading[1].length <= 2 ? 'h3' : 'h4';
      out.push(<Tag key={`h${key++}`}>{inline(heading[2])}</Tag>);
      continue;
    }
    const bullet = /^(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    out.push(<p key={`p${key++}`}>{inline(line)}</p>);
  }
  flush();
  if (code !== null && code.length) {
    out.push(
      <pre className="codeblock" key={`c${key++}`}>
        <code>{code.join('\n')}</code>
      </pre>,
    );
  }
  return <>{out}</>;
}

/** Bold and code only. Anything else stays the plain characters the model wrote. */
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code className="path" key={i}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
