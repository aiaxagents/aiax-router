import { Fragment } from 'react';
import type { AgentTemplate, TaskRecord } from '../api';
import { Composer } from '../composer';
import { Avatar } from '../marks';
import { ago, byNewest, isSameDay } from '../util';

function dayLabel(iso: string): string {
  const when = new Date(iso);
  const yesterday = new Date(Date.now() - 864e5);
  if (isSameDay(iso)) return 'Today';
  if (isSameDay(iso, yesterday)) return 'Yesterday';
  if (Date.now() - when.getTime() < 7 * 864e5) return 'Earlier this week';
  return when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

export interface InboxProps {
  tasks: TaskRecord[];
  agents: AgentTemplate[];
  onOpen: (id: string) => void;
  onSend: (text: string, files: File[]) => void;
}

export function InboxPage({ tasks, agents, onOpen, onSend }: InboxProps) {
  const rows = tasks
    .filter((t) => t.status === 'done' || t.status === 'failed')
    .sort(byNewest);

  const groups: { day: string; rows: TaskRecord[] }[] = [];
  for (const row of rows) {
    const day = dayLabel(row.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }

  const unread = rows.filter((t) => t.unread).length;

  return (
    <>
      <div className="page-wrap">
        <div className="page-intro">
          <div>
            <h3>Your results</h3>
          </div>
          {unread ? (
            <div className="count hot">
              <span className="numeral">{unread}</span>
              <span>new</span>
            </div>
          ) : (
            <div className="count">
              <span className="numeral">{rows.length}</span>
              <span>{rows.length === 1 ? 'result' : 'results'}</span>
            </div>
          )}
        </div>

        {rows.length ? (
          <div className="list">
            {groups.map((group) => (
              <Fragment key={group.day}>
                <div className="day">{group.day}</div>
                {group.rows.map((task) => {
                  const agent = agents.find((a) => a.id === task.agent);
                  return (
                    <div
                      className={`row${task.unread ? ' is-unread' : ''}`}
                      key={task.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpen(task.id)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        onOpen(task.id);
                      }}
                    >
                      {task.unread ? <span className="unread" aria-hidden="true" /> : <span />}
                      <Avatar file={agent?.avatar} className="avatar sm" />
                      <p className="sentence">
                        {task.title}
                        {task.status === 'failed' || task.passed === false ? (
                          <span className="warn"> {task.sentence}</span>
                        ) : null}
                      </p>
                      {task.status === 'done' ? (
                        <a
                          className="path"
                          href={`results/${task.id}/`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          results/{task.id.slice(0, 8)}
                        </a>
                      ) : (
                        <span className="none">nothing to open</span>
                      )}
                      <span className="when">{ago(task.updatedAt)}</span>
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="empty" style={{ maxWidth: '760px', margin: '0 auto' }}>
            <p>Nothing here yet. Finished work lands in this list.</p>
          </div>
        )}
      </div>

      <div className="dock">
        <Composer
          placeholder="Write what you want done."
          hint="Anything you send from here starts a new task."
          onSend={onSend}
        />
      </div>
    </>
  );
}
