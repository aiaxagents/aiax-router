import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './marks';

/** The browser's own dictation. Absent outside Chrome and Safari, and that is fine. */
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

function recognizer(): Recognition | null {
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => Recognition)
    | undefined;
  if (!Ctor) return null;
  const it = new Ctor();
  it.continuous = true;
  it.interimResults = false;
  it.lang = navigator.language || 'en-GB';
  return it;
}

const VOICE_READY = Boolean(
  (window as unknown as Record<string, unknown>).SpeechRecognition ??
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition,
);

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function isPicture(file: File): boolean {
  return file.type.startsWith('image/');
}

export interface ComposerProps {
  placeholder: string;
  hint: ReactNode;
  /** What the composer is pointed at right now, shown above the field. */
  context?: { icon: IconName; label: string; verb: string };
  onSend: (text: string, files: File[]) => void | Promise<void>;
  autoFocus?: boolean;
  className?: string;
}

export function Composer({
  placeholder,
  hint,
  context,
  onSend,
  autoFocus,
  className,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [dropping, setDropping] = useState(false);
  const [listening, setListening] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const speech = useRef<Recognition | null>(null);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  useEffect(() => {
    if (!listening) return;
    setSeconds(0);
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(tick);
  }, [listening]);

  useEffect(() => () => speech.current?.stop(), []);

  const add = (incoming: FileList | File[] | null): void => {
    if (!incoming) return;
    const list = Array.from(incoming);
    if (list.length) setFiles((old) => [...old, ...list].slice(0, 10));
  };

  const send = (): void => {
    const value = text.trim();
    if (!value) return;
    void onSend(value, files);
    setText('');
    setFiles([]);
    speech.current?.stop();
  };

  const toggleVoice = (): void => {
    if (listening) {
      speech.current?.stop();
      return;
    }
    const it = recognizer();
    if (!it) return;
    speech.current = it;
    it.onresult = (e) => {
      let heard = '';
      for (let i = e.resultIndex; i < e.results.length; i++) heard += e.results[i][0].transcript;
      if (heard.trim()) setText((old) => (old ? `${old} ${heard.trim()}` : heard.trim()));
    };
    it.onerror = () => setListening(false);
    it.onend = () => setListening(false);
    it.start();
    setListening(true);
  };

  return (
    <div className={`composer${className ? ` ${className}` : ''}`}>
      {context ? (
        <p className="ctx">
          <span className="verb">{context.verb}</span>
          <span className="tagline">
            <Icon name={context.icon} size={12} />
            <span className="t">{context.label}</span>
          </span>
        </p>
      ) : null}

      <div
        className={`field${dropping ? ' is-drop' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          add(e.dataTransfer.files);
        }}
      >
        {files.length ? (
          <div className="atts">
            {files.map((file, i) => (
              <span key={`${file.name}${i}`} className={isPicture(file) ? 'att-thumb' : 'att'}>
                {isPicture(file) ? (
                  <img src={URL.createObjectURL(file)} alt={file.name} title={file.name} />
                ) : (
                  <>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" />
                      <path d="M14 3v4.5h4.5" />
                    </svg>
                    {file.name}
                    <button
                      type="button"
                      className="att-x"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => setFiles(files.filter((_, at) => at !== i))}
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </>
                )}
              </span>
            ))}
          </div>
        ) : null}

        <div className="field-line">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="ctrl"
            aria-label="Add a picture or file"
            onClick={() => picker.current?.click()}
          >
            <Icon name="clip" size={18} />
          </button>

          {listening ? (
            <div className="rec">
              <span className="levels" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="rec-text">Listening.</span>
              <span className="rec-time">{clock(seconds)}</span>
            </div>
          ) : (
            <textarea
              ref={area}
              className="input"
              rows={1}
              value={text}
              placeholder={placeholder}
              autoFocus={autoFocus}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => add(e.clipboardData.files)}
              onKeyDown={(e) => {
                // Enter also confirms a candidate while an input method is open,
                // and that press must not send a half finished sentence.
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                send();
              }}
            />
          )}

          {VOICE_READY ? (
            <button
              type="button"
              className={`ctrl${listening ? ' is-live' : ''}`}
              aria-label={listening ? 'Stop listening' : 'Speak instead of typing'}
              onClick={toggleVoice}
            >
              <Icon name="mic" size={18} />
            </button>
          ) : null}

          <button
            type="button"
            className="send"
            aria-label="Send"
            disabled={!text.trim()}
            onClick={send}
          >
            <Icon name="send" size={16} />
          </button>
        </div>
      </div>

      <div className="hint">
        {listening ? (
          'Tap the mic again when you are done.'
        ) : (
          <>
            {hint}
            {VOICE_READY ? null : <span> Talking to it needs Chrome or Safari.</span>}
          </>
        )}
      </div>
    </div>
  );
}
