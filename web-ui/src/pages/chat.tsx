import { useEffect, useRef, useState } from 'react';
import type { ActiveRun, AgentTemplate, RoutingState, Status, TaskRecord, TaskState } from '../api';
import { fetchTask } from '../api';
import { Composer } from '../composer';
import { DecisionBlock } from '../decision';
import { AiaxMark, Avatar, Icon } from '../marks';
import { Markdown } from '../md';
import { ModelStrip, type ModelStripProps } from '../modelstrip';
import { clockOf, fmtCost, fmtTokens, greeting, isSameDay, plainName, today } from '../util';

const EXAMPLES = [
  'Turn my meeting notes into a two page report',
  'Find what changed in the EU AI rules this month',
  'Clean up the CSV export from our webshop',
  'Draft a reply to the Nordic supplier',
  'Book a table for six on Friday',
  'Write three subject lines for the newsletter',
];

const SEND_HINT = (
  <>
    <kbd>Enter</kbd> sends.
    <span className="sep" aria-hidden="true">
      /
    </span>
    <kbd>Shift</kbd>
    <kbd>Enter</kbd> makes a new line.
  </>
);

function Usage({ usage }: { usage: TaskRecord['usage'] }) {
  if (!usage) return null;
  return (
    <div className="det-row">
      <div className="det-label">What it used</div>
      <ul>
        {usage.lines.map((line) => (
          <li key={`${line.provider}${line.model}`}>
            {plainName(line.provider)} {line.model}: {fmtTokens(line.inputTokens)} in,{' '}
            {fmtTokens(line.outputTokens)} out
            {line.costUsd !== null ? `, about ${fmtCost(line.costUsd)}` : ''}.
          </li>
        ))}
      </ul>
      <p className="det-note">
        API list price for the same tokens. Your subscriptions covered the run.
      </p>
    </div>
  );
}

function Details({ id, usage }: { id: string; usage: TaskRecord['usage'] }) {
  const [state, setState] = useState<TaskState | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchTask(id)
      .then((got) => alive && setState(got.state))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  if (!state) return <div className="details">Fetching the rest.</div>;
  const last = state.reviewRounds[state.reviewRounds.length - 1];
  const lowest = last ? [...last.scores].sort((a, b) => a.score - b.score)[0] : null;

  return (
    <div className="details">
      <div className="det-row">
        <div className="det-label">What I aimed for</div>
        <p>{state.intent}</p>
      </div>
      {state.results.filter((r) => !r.id.startsWith('fix-')).length ? (
        <div className="det-row">
          <div className="det-label">The parts</div>
          <ul>
            {state.results
              .filter((r) => !r.id.startsWith('fix-'))
              .map((r) => (
                <li key={r.id}>
                  {r.provider ? `${plainName(r.provider)} ` : ''}
                  {r.ok ? 'did' : 'could not do'}: {r.title}.
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {lowest ? (
        <div className="det-row">
          <div className="det-label">Review</div>
          <p>
            Five review agents scored it. The lowest was {lowest.score} for{' '}
            {lowest.lens.toLowerCase()}.
          </p>
        </div>
      ) : null}
      <Usage usage={usage} />
      <div className="det-row">
        <div className="det-label">Result</div>
        <p>
          <a className="link path" href={`results/${id}/`}>
            results/{id}
          </a>
        </p>
      </div>
    </div>
  );
}

function Turn({
  task,
  onAnswer,
}: {
  task: TaskRecord;
  onAnswer: (id: string, answer: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const live = task.status === 'running';

  return (
    <>
      <div className="turn turn-user">
        <p className="bubble">{task.title}</p>
      </div>
      <div className="turn answer">
        <div className="speaker">
          <AiaxMark className="logo-tile sm" />
          <b>Router</b>
          <span className="when">{clockOf(task.createdAt)}</span>
        </div>

        {live && task.lines.length ? (
          <ul className="steps">
            {task.lines.slice(-6).map((line, i, all) => (
              <li key={line.id} className={i === all.length - 1 && !task.question ? 'is-running' : ''}>
                {line.text}
              </li>
            ))}
          </ul>
        ) : null}

        {task.question ? (
          <DecisionBlock
            question={task.question}
            onPick={(answer) => onAnswer(task.id, answer)}
          />
        ) : null}

        {task.status === 'failed' ? <p>{task.sentence}</p> : null}

        {task.excerpt ? <Markdown text={task.excerpt} /> : null}

        {task.status === 'done' ? (
          <>
            <div className="ans-foot">
              {typeof task.score === 'number' ? (
                <span className="verdict">
                  <span className="numeral">{task.score}</span>
                  <small>
                    out of 10 from five review agents, after {task.rounds ?? 1}{' '}
                    {task.rounds === 1 ? 'round' : 'rounds'}.
                  </small>
                </span>
              ) : (
                <span className="verdict">
                  <small>Nobody was free to check this, so treat it as unchecked.</small>
                </span>
              )}
              {task.usage ? (
                <span className="spent" title="API list price for the same tokens. Your subscriptions covered the run.">
                  {fmtTokens(task.usage.inputTokens + task.usage.outputTokens)} tokens
                  {task.usage.costUsd !== null ? ` · ${fmtCost(task.usage.costUsd)} saved` : ''}
                </span>
              ) : null}
              <button
                className={`toggle${open ? ' is-open' : ''}`}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
              >
                {open ? 'Hide details' : 'Show details'}
                <Icon name="chev" size={12} />
              </button>
            </div>
            {open ? <Details id={task.id} usage={task.usage} /> : null}
          </>
        ) : null}
      </div>
    </>
  );
}

export interface ChatProps {
  tasks: TaskRecord[];
  agents: AgentTemplate[];
  agent?: AgentTemplate;
  routing: RoutingState | null;
  runs: ActiveRun[];
  status: Status | null;
  onRouting: ModelStripProps['onChange'];
  onSend: (text: string, files: File[], agent?: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onPickAgent: (id: string) => void;
  name: string;
}

export function ChatPage({
  tasks,
  agents,
  agent,
  routing,
  runs,
  status,
  onRouting,
  onSend,
  onAnswer,
  onPickAgent,
  name,
}: ChatProps) {
  const thread = tasks
    .filter((t) => isSameDay(t.createdAt))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const bottom = useRef<HTMLDivElement>(null);
  const seen = useRef(0);

  // Follow the live tail, but never yank someone who scrolled up to read.
  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    const newTurn = thread.length !== seen.current;
    seen.current = thread.length;
    if (newTurn || el.getBoundingClientRect().top - window.innerHeight < 240) {
      el.scrollIntoView({ block: 'end' });
    }
  }, [thread.length, tasks.map((t) => t.lines.length).join(',')]);

  const composer = (home: boolean) => (
    <>
      <Composer
        className={home ? 'home' : undefined}
        placeholder={agent?.placeholder ?? 'Write what you want done.'}
        hint={SEND_HINT}
        context={agent ? { icon: 'agents', label: agent.name, verb: 'Talking to' } : undefined}
        onSend={(text, files) => onSend(text, files, agent?.id)}
        autoFocus
      />
      <ModelStrip routing={routing} runs={runs} status={status} onChange={onRouting} />
    </>
  );

  if (!thread.length) {
    return (
      <>
        <div className="thread center">
          <div className="col">
            <p className="daynote">{today()}</p>
            <p className="invite">
              {greeting()}
              {name ? `, ${name}` : ''}.
            </p>
            <p className="invite-sub">Say it plainly. I pick who does the work.</p>

            {composer(true)}

            <div className="chips">
              {EXAMPLES.map((example) => (
                <button className="chip" key={example} onClick={() => onSend(example, [])}>
                  {example}
                </button>
              ))}
            </div>

            <div className="launch">
              {agents.map((a) => (
                <button className="tile" key={a.id} aria-label={a.name} onClick={() => onPickAgent(a.id)}>
                  <Avatar file={a.avatar} />
                  <span>{a.name}</span>
                </button>
              ))}
            </div>
            <p className="launch-hint">Pick one to talk to just that agent.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="thread">
        <div className="col">
          {thread.map((task) => (
            <Turn key={task.id} task={task} onAnswer={onAnswer} />
          ))}
          <div ref={bottom} />
        </div>
      </div>
      <div className="dock seam">{composer(false)}</div>
    </>
  );
}
