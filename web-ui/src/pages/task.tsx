import { useEffect, useState } from 'react';
import type { Status, TaskRecord, TaskState } from '../api';
import { fetchTask } from '../api';
import { Composer } from '../composer';
import { DecisionBlock } from '../decision';
import { Brand } from '../marks';
import { clockOf, leftWord, plainName, running, stampOf } from '../util';

const LENS_ORDER = ['correctness', 'completeness', 'quality', 'robustness', 'simplicity'];

function sentenceCase(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function roundsWord(n: number): string {
  if (!n) return 'No review yet';
  return n === 1 ? 'One review round so far' : `${n} review rounds so far`;
}

function Parts({ state, status }: { state: TaskState; status: Status | null }) {
  const nameOf = (id: string): string =>
    plainName(id, status?.providers.find((p) => p.id === id)?.displayName ?? '');

  return (
    <div className="dsec">
      <div className="dsec-label">Who did what</div>
      {state.subtasks.map((sub) => {
        const result = state.results.find((r) => r.id === sub.id);
        const label = result ? (result.ok ? 'Done' : 'Failed') : 'Waiting';
        return (
          <div className="part" key={sub.id}>
            <div>
              <b>{sub.title}</b>
              <div className="who">
                {result ? (
                  <>
                    <Brand id={result.provider} />
                    <span className="name">{nameOf(result.provider)}</span>
                    <span className="meta">
                      {result.model}
                      {result.summary ? `, ${result.summary}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="meta">Not started yet.</span>
                )}
              </div>
            </div>
            <span className={`state${!result && state.status === 'running' ? ' now' : ''}`}>
              {label}
            </span>
          </div>
        );
      })}
      {state.subtasks.length ? null : <p>Still working out the parts.</p>}
    </div>
  );
}

function Rounds({ state }: { state: TaskState }) {
  if (!state.reviewRounds.length) return null;
  return (
    <div className="dsec">
      <div className="dsec-label">Review rounds</div>
      <div className="rounds">
        {state.reviewRounds.map((round) => {
          const lowest = Math.min(...round.scores.map((s) => s.score));
          const ordered = [...round.scores].sort(
            (a, b) =>
              LENS_ORDER.indexOf(a.lens.toLowerCase()) - LENS_ORDER.indexOf(b.lens.toLowerCase()),
          );
          return (
            <div className="round" key={round.round}>
              <div className="round-head">
                <b>Round {round.round}</b>
                <span className="avg">
                  <span>average</span>
                  <span className="numeral">{round.average.toFixed(1)}</span>
                </span>
              </div>
              {ordered.map((score) => (
                <div
                  className={`rrow${score.score === lowest ? ' is-low' : ''}`}
                  key={`${score.lens}${score.provider}`}
                >
                  <span className="lens">{sentenceCase(score.lens)}</span>
                  <span className="sc">{score.score.toFixed(1)}</span>
                  <span className="why">{score.note}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Quota({ state, status }: { state: TaskState; status: Status | null }) {
  const counts = new Map<string, number>();
  for (const r of state.results) counts.set(r.provider, (counts.get(r.provider) ?? 0) + 1);
  for (const round of state.reviewRounds) {
    for (const s of round.scores) counts.set(s.provider, (counts.get(s.provider) ?? 0) + 1);
  }
  if (!counts.size) return null;

  return (
    <div className="dsec">
      <div className="dsec-label">What this task used</div>
      <div className="quota">
        {[...counts].map(([id, runs]) => {
          const provider = status?.providers.find((p) => p.id === id);
          return (
            <div className="qrow" key={id}>
              <span className="svc">
                <Brand id={id} />
                {plainName(id, provider?.displayName ?? '')}
              </span>
              <span className="num">
                {runs} {runs === 1 ? 'run' : 'runs'}
              </span>
              <span className="left">
                {provider
                  ? `${sentenceCase(leftWord(provider.headroom))}${provider.headroomMeasured ? '.' : ', estimated.'}`
                  : ''}
              </span>
            </div>
          );
        })}
      </div>
      <p style={{ marginTop: '8px', fontSize: '12.5px', color: 'var(--faint)' }}>
        Runs, not tokens. Your subscriptions do not tell us the token count.
      </p>
    </div>
  );
}

export interface TaskPageProps {
  task: TaskRecord;
  status: Status | null;
  onAnswer: (id: string, answer: string, questionId?: string) => void;
  onSend: (text: string, files: File[]) => void;
}

export function TaskPage({ task, status, onAnswer, onSend }: TaskPageProps) {
  const [state, setState] = useState<TaskState | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = (): void => {
      void fetchTask(task.id)
        .then((got) => alive && setState(got.state))
        .catch(() => undefined);
    };
    pull();
    return () => {
      alive = false;
    };
    // The record's own fields change on every server event, which is exactly
    // when the state file on disk has moved too.
  }, [task.id, task.updatedAt]);

  const pct = task.parts.total ? Math.round((task.parts.done / task.parts.total) * 100) : 0;
  const started = task.startedAt ?? task.createdAt;
  const elapsed = Math.round(
    (Date.parse(task.finishedAt ?? new Date().toISOString()) - Date.parse(started)) / 1000,
  );
  const waiting = Boolean(task.question);

  return (
    <>
      <div className="detail">
        <div className="dcol">
          <div className="dhead">
            <div>
              <h3>{task.title}</h3>
              <p className="now">{task.sentence}</p>
            </div>
            {task.parts.total ? (
              <div className="dcount">
                <div className="numeral">
                  {task.parts.done}/{task.parts.total}
                </div>
                <span>parts done</span>
              </div>
            ) : (
              <div />
            )}
            {task.parts.total ? (
              <div
                className="prog"
                role="img"
                aria-label={`${task.parts.done} of ${task.parts.total} parts done`}
              >
                <span style={{ width: `${pct}%` }} />
              </div>
            ) : null}
            <div className="dmeta">
              <span>
                {task.status === 'running' ? 'Running for' : 'Took'} {running(elapsed)}
              </span>
              <span>Started {clockOf(started)}</span>
              <span>{roundsWord(state?.reviewRounds.length ?? 0)}</span>
            </div>
          </div>

          <div className="dsec">
            <div className="dsec-label">What you asked for</div>
            <p>{state?.intent || task.title}</p>
            {state?.acceptanceCriteria.length ? (
              <ul className="crit" style={{ marginTop: '8px' }}>
                {state.acceptanceCriteria.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {task.question ? (
            <div className="dsec">
              <div className="dsec-label">Waiting on you</div>
              <DecisionBlock
                question={task.question}
                small
                onPick={(answer) => onAnswer(task.id, answer, task.question?.id)}
              />
            </div>
          ) : null}

          {state?.decisions.length ? (
            <div className="dsec">
              <div className="dsec-label">Settled along the way</div>
              <ul className="crit" style={{ marginTop: '4px' }}>
                {state.decisions.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {state ? <Parts state={state} status={status} /> : null}
          {state ? <Rounds state={state} /> : null}
          {state ? <Quota state={state} status={status} /> : null}

          {task.lines.length ? (
            <div className="dsec">
              <div className="dsec-label">Timeline</div>
              <div className="tl">
                {task.lines.map((line) => (
                  <div className="trow" key={line.id}>
                    <span className="t">{stampOf(line.at)}</span>
                    <span className="ev">{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : task.status === 'running' ? (
            <div className="dsec">
              <div className="dsec-label">Timeline</div>
              <p className="quiet">Nothing here yet. The first step shows up the moment it happens.</p>
            </div>
          ) : null}

          {task.status === 'done' ? (
            <div className="dsec">
              <div className="dsec-label">Result</div>
              <p>
                <a className="link path" href={`results/${task.id}/`}>
                  results/{task.id}
                </a>
              </p>
            </div>
          ) : null}

          {task.attachments.length ? (
            <div className="dsec">
              <div className="dsec-label">What you sent with it</div>
              <ul className="crit" style={{ marginTop: '4px' }}>
                {task.attachments.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="dock">
        <Composer
          context={{
            icon: 'tasks',
            label: task.title,
            verb: waiting ? 'Answering' : 'About',
          }}
          placeholder={waiting ? 'Answer in your own words.' : 'Write what you want done next.'}
          hint={
            waiting
              ? 'This answer goes straight to the task above.'
              : 'This starts a new task. The one above keeps its own result.'
          }
          onSend={(text, files) =>
            waiting ? onAnswer(task.id, text, task.question?.id) : onSend(text, files)
          }
        />
      </div>
    </>
  );
}

export function TaskCrumb({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <>
      <button className="back" onClick={onBack}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 6l-6 6 6 6" />
        </svg>
        Tasks
      </button>
      <span className="sep" aria-hidden="true">
        /
      </span>
      <h2>{title}</h2>
    </>
  );
}
