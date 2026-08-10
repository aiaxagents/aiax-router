import { SPRITE } from './sprite';

/**
 * One sprite for the whole app, mounted once. It is injected as raw markup on
 * purpose: it is a verbatim copy of the design spec's own defs block, so the
 * AiAx mark and every vendor logo stay exactly as their owners drew them.
 */
export function Sprite() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: 'absolute' }}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: SPRITE }}
    />
  );
}

export type IconName =
  | 'clip'
  | 'mic'
  | 'send'
  | 'check'
  | 'chev'
  | 'search'
  | 'clock'
  | 'repeat'
  | 'pause'
  | 'play'
  | 'chat'
  | 'inbox'
  | 'agents'
  | 'tasks'
  | 'plugins'
  | 'settings';

export function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden="true">
      <use href={`#ic-${name}`} />
    </svg>
  );
}

export function AiaxMark({ className = 'logo-tile' }: { className?: string }) {
  return (
    <span className={className}>
      <svg viewBox="8 10 92 96" role="img" aria-label="AiAx Router">
        <use href="#aiax-mark" />
      </svg>
    </span>
  );
}

/** The real logo per service. Favicons keep their own colour, glyphs tint. */
const FAVICON: Record<string, string> = {
  grok: 'favicon-grok.png',
  kimi: 'favicon-kimi.png',
  higgsfield: 'favicon-higgsfield.png',
  fal: 'favicon-fal.png',
  kie: 'favicon-kie.png',
};
const GLYPH: Record<string, string> = {
  claude: 'logo-claude',
  codex: 'logo-openai',
  openai: 'logo-openai',
};

export function Brand({ id, size = '' }: { id: string; size?: string }) {
  const cls = `bmk${size ? ` ${size}` : ''}`;
  if (id === 'aiax' || id === 'aiaxmail') {
    return (
      <span className={`${cls} tile`}>
        <svg viewBox="8 10 92 96" aria-hidden="true">
          <use href="#aiax-mark" />
        </svg>
      </span>
    );
  }
  const glyph = GLYPH[id];
  if (glyph) {
    return (
      <span className={cls}>
        <svg aria-hidden="true">
          <use href={`#${glyph}`} />
        </svg>
      </span>
    );
  }
  const favicon = FAVICON[id];
  if (!favicon) return null;
  return (
    <span className={cls}>
      <img src={`./assets/${favicon}`} alt="" />
    </span>
  );
}

export function Avatar({ file, className = 'avatar' }: { file?: string; className?: string }) {
  if (!file) {
    return (
      <span className={className}>
        <svg viewBox="8 10 92 96" aria-hidden="true" style={{ width: '68%', height: '68%' }}>
          <use href="#aiax-mark" />
        </svg>
      </span>
    );
  }
  return (
    <span className={className}>
      <img src={`./assets/${file}`} alt="" />
    </span>
  );
}
