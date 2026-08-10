import { useEffect } from 'react';
import type { TaskQuestion } from './api';
import { Icon } from './marks';

/**
 * The router needs the person's call. One short question, two to four large
 * targets, and one sentence each on what picking it means.
 */
export function DecisionBlock({
  question,
  onPick,
  small,
}: {
  question: TaskQuestion;
  onPick: (answer: string) => void;
  small?: boolean;
}) {
  const choices = question.choices;

  useEffect(() => {
    if (!choices.length) return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const at = Number(e.key) - 1;
      if (!Number.isInteger(at) || at < 0 || at >= choices.length) return;
      e.preventDefault();
      onPick(choices[at].label);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [choices, onPick]);

  return (
    <div className="decide">
      <p className="q" style={small ? { fontSize: '20px' } : undefined}>
        {question.question}
      </p>
      {choices.length ? (
        <>
          <div className="choices">
            {choices.map((choice, i) => (
              <button
                key={choice.label}
                className={`choice${choice.recommended ? ' is-rec' : ''}`}
                onClick={() => onPick(choice.label)}
                aria-label={[
                  `Key ${i + 1}`,
                  choice.label,
                  choice.means,
                  choice.recommended ? 'Recommended' : '',
                ]
                  .filter(Boolean)
                  .map((part) => part.replace(/\.$/, ''))
                  .join('. ')}
              >
                <span>
                  <kbd className="key" aria-hidden="true">
                    {i + 1}
                  </kbd>
                  <b>{choice.label}</b>
                  {choice.means ? <span className="means">{choice.means}</span> : null}
                </span>
                {choice.recommended ? (
                  <span className="rec">
                    <Icon name="check" size={12} /> Recommended
                  </span>
                ) : (
                  <span />
                )}
              </button>
            ))}
          </div>
          <p className="decide-foot">Press the number, or just say it out loud.</p>
        </>
      ) : (
        <p className="decide-foot">Tell me below in your own words and I carry on.</p>
      )}
    </div>
  );
}
