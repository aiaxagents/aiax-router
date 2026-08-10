import { useState } from 'react';
import type { AgentTemplate, ScheduledItem, Status, TaskRecord } from '../api';
import { Composer } from '../composer';
import { Icon } from '../marks';
import { boardOrder } from '../util';

const DAY = 864e5;
/** Past about fifteen cards a column drops to one line each. */
const COMPACT_AT = 15;

function Card({
  task,
  onOpen,
  onRetry,
}: {
  task: TaskRecord;
  onOpen: (id: string) => void;
  onRetry: (task: TaskRecord) => void;
}) {
  const asking = Boolean(task.question);
  const live = task.status === 'running';
  const pct = task.parts.total
    ? Math.round((task.parts.done / task.parts.total) * 100)
    : 0;

  return (
    <article
      className={`card${asking ? ' is-ask' : live ? ' is-running' : ''}`}
      onClick={() => onOpen(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(task.id);
        }
      }}
    >
      {asking ? (
        <p className="ask-line">
          <span className="dot-sq accent" aria-hidden="true" /> Waiting for you
        </p>
      ) : null}
      <h3>{task.title}</h3>
      <p className="sentence">{asking ? task.question?.question : task.sentence}</p>

      {live && !asking && task.parts.total ? (
        <>
          <div
            className="prog"
            role="img"
            aria-label={`${task.parts.done} of ${task.parts.total} parts done`}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="prog-note">
            {task.parts.done} of {task.parts.total} parts done
          </p>
        </>
      ) : null}

      {asking ? (
        <button className="btn-ask" onClick={() => onOpen(task.id)}>
          Answer
        </button>
      ) : null}

      {task.status === 'done' ? (
        <div className="card-foot">
          <span className="tick">
            <Icon name="check" size={11} /> Done
          </span>
          {typeof task.score === 'number' ? (
            <span className="numeral">{task.score}</span>
          ) : null}
        </div>
      ) : null}

      {task.status === 'failed' ? (
        <button
          className="btn"
          onClick={(e) => {
            e.stopPropagation();
            onRetry(task);
          }}
        >
          Try again
        </button>
      ) : null}
    </article>
  );
}

function Column({
  name,
  tasks,
  running,
  empty,
  onOpen,
  onRetry,
  foldLabel,
}: {
  name: string;
  tasks: TaskRecord[];
  running?: boolean;
  empty: string;
  onOpen: (id: string) => void;
  onRetry: (task: TaskRecord) => void;
  foldLabel?: string;
}) {
  const [unfolded, setUnfolded] = useState(false);
  const compact = tasks.length > COMPACT_AT;
  const shown = compact && !unfolded ? tasks.slice(0, COMPACT_AT) : tasks;
  const hidden = tasks.length - shown.length;

  return (
    <div className="bcol">
      <div className={`col-head${running ? ' is-running' : ''}`}>
        {running ? <span className="dot-sq accent" aria-hidden="true" /> : null}
        <span className="col-name">{name}</span>
        <span className="numeral">{tasks.length}</span>
      </div>

      {tasks.length === 0 ? (
        <div className="empty">
          <p>{empty}</p>
        </div>
      ) : compact ? (
        <div className="minis">
          {shown.map((task) => (
            <button className="mini" key={task.id} onClick={() => onOpen(task.id)}>
              {task.question ? <span className="dot-sq accent" aria-hidden="true" /> : null}
              <span className="t">{task.title}</span>
              {typeof task.score === 'number' ? <span className="n">{task.score}</span> : null}
            </button>
          ))}
        </div>
      ) : (
        shown.map((task) => (
          <Card key={task.id} task={task} onOpen={onOpen} onRetry={onRetry} />
        ))
      )}

      {hidden > 0 ? (
        <button className="fold" onClick={() => setUnfolded(true)}>
          {hidden} more {foldLabel ?? 'waiting'} <Icon name="chev" size={12} />
        </button>
      ) : null}
    </div>
  );
}

function Shelf({ items, note }: { items: ScheduledItem[]; note: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="shelf">
      <div className="shelf-head">
        <Icon name="clock" size={13} />
        Scheduled <span className="n">{items.length}</span>
        <button className="fold-x" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'} <Icon name="chev" size={11} />
        </button>
      </div>
      {open ? (
        items.length ? (
          items.map((item) => (
            <div className={`srow${item.paused ? ' is-paused' : ''}`} key={item.id}>
              <span className="sname">{item.name}</span>
              <span className="sfreq">{item.every}</span>
              <span className="snext">{item.paused ? 'Paused' : item.next}</span>
              {item.lastResult ? (
                <a className="link-quiet" href={item.lastResult}>
                  Last result
                </a>
              ) : (
                <span />
              )}
              <span />
            </div>
          ))
        ) : (
          <div className="srow srow-static">
            <span className="sfreq">{note}</span>
            <span />
            <span />
            <span />
            <span />
          </div>
        )
      ) : null}
    </div>
  );
}

export interface BoardProps {
  tasks: TaskRecord[];
  agents: AgentTemplate[];
  status: Status | null;
  onOpen: (id: string) => void;
  onInbox: () => void;
  onSend: (text: string, files: File[]) => void;
}

export function BoardPage({ tasks, agents, status, onOpen, onInbox, onSend }: BoardProps) {
  const [query, setQuery] = useState('');
  const [span, setSpan] = useState<'today' | 'week'>('week');
  const [who, setWho] = useState('');

  const cutoff = Date.now() - (span === 'today' ? DAY : 7 * DAY);
  const visible = tasks
    .filter((t) => Date.parse(t.createdAt) >= cutoff)
    .filter((t) => !who || t.agent === who)
    .filter((t) => !query.trim() || t.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort(boardOrder);

  const done = visible.filter((t) => t.status === 'done');
  // The board shows work, not history: opened results move on to the Inbox.
  const fresh = done.filter((t) => t.unread || Date.now() - Date.parse(t.updatedAt) < DAY);
  const settled = done.length - fresh.length;

  const retry = (task: TaskRecord): void => onSend(task.title, []);

  return (
    <>
      <div className="boardbar">
        <label className="search">
          <Icon name="search" size={15} />
          <input
            className="input"
            type="search"
            value={query}
            placeholder="Search tasks"
            aria-label="Search tasks"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="filters">
          <button
            className={`fpill${span === 'today' ? ' is-on' : ''}`}
            onClick={() => setSpan('today')}
          >
            Today
          </button>
          <button
            className={`fpill${span === 'week' ? ' is-on' : ''}`}
            onClick={() => setSpan('week')}
          >
            This week
          </button>
          <span className="fdiv" aria-hidden="true" />
          <span className={`fpill${who ? ' is-on' : ''}`}>
            <select value={who} aria-label="Filter by agent" onChange={(e) => setWho(e.target.value)}>
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </span>
        </div>
      </div>

      <Shelf
        items={status?.scheduled.items ?? []}
        note={status?.scheduled.note ?? 'Nothing repeats yet.'}
      />

      <div className="board">
        <Column
          name="Backlog"
          tasks={visible.filter((t) => t.status === 'backlog')}
          empty="Nothing queued up."
          onOpen={onOpen}
          onRetry={retry}
        />
        <Column
          name="Running"
          running={visible.some((t) => t.status === 'running')}
          tasks={visible.filter((t) => t.status === 'running')}
          empty="Nothing on the go. Send something from below."
          onOpen={onOpen}
          onRetry={retry}
        />
        <Column
          name="Done"
          tasks={fresh}
          empty="Finished work lands here first."
          onOpen={onOpen}
          onRetry={retry}
          foldLabel="finished"
        />
        <Column
          name="Failed"
          tasks={visible.filter((t) => t.status === 'failed')}
          empty="Nothing has gone wrong."
          onOpen={onOpen}
          onRetry={retry}
        />
      </div>

      {settled > 0 ? (
        <button className="fold" style={{ padding: '9px 16px' }} onClick={onInbox}>
          {settled} more finished this week, waiting in your Inbox <Icon name="chev" size={12} />
        </button>
      ) : null}

      <div className="dock">
        <Composer
          placeholder="Write what you want done."
          hint="Anything you send from here starts a new task."
          onSend={(text, files) => onSend(text, files)}
        />
      </div>
    </>
  );
}
