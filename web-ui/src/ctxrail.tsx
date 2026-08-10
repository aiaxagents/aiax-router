import type { Catalog, Status, TaskRecord } from './api';
import { Brand } from './marks';
import { missingLabel } from './needs';
import { byNewest, leftWord, isSameDay, plainName } from './util';

interface RailProps {
  variant: 'chat' | 'inbox' | 'agents' | 'plugins';
  tasks: TaskRecord[];
  status: Status | null;
  catalog: Catalog | null;
  onOpen: (id: string) => void;
  onStop?: (id: string) => void;
}

function Subscriptions({ status }: { status: Status | null }) {
  return (
    <div className="cx">
      <div className="cx-label">Your subscriptions</div>
      {(status?.providers ?? []).map((p) => (
        <div className="cx-next" key={p.id}>
          <Brand id={p.id} />
          <span>{plainName(p.id, p.displayName)}</span>
          <span className={`n${!p.ready && p.installed ? ' is-todo' : ''}`}>
            {p.ready
              ? 'Ready'
              : !p.installed
                ? 'Not installed'
                : !p.loggedIn
                  ? 'Sign in'
                  : 'Resting'}
          </span>
        </div>
      ))}
      {status ? null : <p className="cx-empty">Checking what you have.</p>}
    </div>
  );
}

function UsedToday({ status }: { status: Status | null }) {
  const providers = (status?.providers ?? []).filter((p) => p.installed);
  return (
    <div className="cx cx-foot">
      <div className="cx-label">Used today</div>
      {providers.length ? (
        providers.map((p) => {
          const runs = status?.usedToday[p.id] ?? 0;
          return (
            <div className="cx-q" key={p.id}>
              <Brand id={p.id} />
              <span className="n numeral">{runs}</span>
              <span className="l">{runs ? leftWord(p.headroom) : 'Nothing yet'}</span>
            </div>
          );
        })
      ) : (
        <p className="cx-empty">Nothing to count yet.</p>
      )}
    </div>
  );
}

function RunsNext({ status }: { status: Status | null }) {
  const items = status?.scheduled.items ?? [];
  return (
    <div className="cx">
      <div className="cx-label">Runs next</div>
      {items.length ? (
        items.map((s) => (
          <div className="cx-next" key={s.id}>
            <span>{s.name}</span>
            <span className="n">{s.next}</span>
          </div>
        ))
      ) : (
        <p className="cx-empty">Nothing repeats yet.</p>
      )}
    </div>
  );
}

export function ContextRail({ variant, tasks, status, catalog, onOpen, onStop }: RailProps) {
  const live = tasks.filter((t) => t.status === 'running').sort(byNewest);
  const finished = tasks
    .filter((t) => t.status === 'done')
    .sort(byNewest)
    .slice(0, 4);
  const current = live[0];

  const runningBlock = (label: string) => (
    <div className="cx">
      <div className="cx-label">{label}</div>
      {current ? (
        <>
          <p className="cx-task">{current.title}</p>
          {current.parts.total ? (
            <>
              <div
                className="prog"
                role="img"
                aria-label={`${current.parts.done} of ${current.parts.total} parts done`}
              >
                <span
                  style={{
                    width: `${Math.round((current.parts.done / current.parts.total) * 100)}%`,
                  }}
                />
              </div>
              <div className="cx-line">
                <span className="numeral cx-num">
                  {current.parts.done}/{current.parts.total}
                </span>
                <span>parts done</span>
              </div>
            </>
          ) : null}
          <div className="cx-who">
            {current.sentence}
            {onStop ? (
              <button className="link-quiet cx-stop" onClick={() => onStop(current.id)}>
                Open it
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="cx-empty">Nothing yet. Whatever you start shows up here.</p>
      )}
    </div>
  );

  if (variant === 'agents') {
    const plugins = catalog?.plugins ?? [];
    const notReady = (catalog?.agents ?? [])
      .map((a) => ({ agent: a, missing: missingLabel(a, status, plugins) }))
      .filter((row) => row.missing);
    return (
      <aside className="ctxrail" aria-label="What your agents can use">
        <Subscriptions status={status} />
        {notReady.length ? (
          <div className="cx">
            <div className="cx-label">Not ready yet</div>
            {notReady.map(({ agent, missing }) => (
              <div className="cx-next" key={agent.id}>
                <span>{agent.name}</span>
                <span className="n is-todo">{missing}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="cx">
          <div className="cx-label">How the router picks</div>
          <div className="cx-next">
            <span>It reads what you asked for.</span>
          </div>
          <div className="cx-next">
            <span>It picks who fits and what is left.</span>
          </div>
          <div className="cx-next">
            <span>Name one yourself and it uses that one.</span>
          </div>
        </div>
        <UsedToday status={status} />
      </aside>
    );
  }

  if (variant === 'plugins') {
    const plugins = catalog?.plugins ?? [];
    return (
      <aside className="ctxrail" aria-label="What plugins cost">
        <div className="cx">
          <div className="cx-label">Connected</div>
          {plugins.map((p) => (
            <div className="cx-next" key={p.id}>
              <span>{p.name}</span>
              {/* an unconnected plugin is a fact, not a job for you, so it stays quiet */}
              <span className={`n${p.connected ? ' is-total' : ''}`}>
                {p.connected ? 'Ready' : 'Not connected'}
              </span>
            </div>
          ))}
          {plugins.length ? null : <p className="cx-empty">Nothing to add yet.</p>}
        </div>
        <div className="cx">
          <div className="cx-label">How they get paid</div>
          <div className="cx-next">
            <span>The ones you add bill per use.</span>
          </div>
          <div className="cx-next">
            <span>That is separate from your subscriptions.</span>
          </div>
        </div>
        <UsedToday status={status} />
      </aside>
    );
  }

  if (variant === 'inbox') {
    const week = tasks.filter((t) => Date.now() - Date.parse(t.createdAt) < 7 * 864e5);
    const scored = week.filter((t) => typeof t.score === 'number');
    const average = scored.length
      ? (scored.reduce((sum, t) => sum + (t.score ?? 0), 0) / scored.length).toFixed(1)
      : null;
    return (
      <aside className="ctxrail" aria-label="What is still coming">
        {runningBlock('Still coming')}
        <div className="cx">
          <div className="cx-label">This week</div>
          <div className="cx-next">
            <span>Results</span>
            <span className="n numeral">{week.filter((t) => t.status === 'done').length}</span>
          </div>
          <div className="cx-next">
            <span>Still unread</span>
            <span className="n numeral">{week.filter((t) => t.unread).length}</span>
          </div>
          <div className="cx-next">
            <span>Did not work out</span>
            <span className="n numeral">{week.filter((t) => t.status === 'failed').length}</span>
          </div>
          {average ? (
            <div className="cx-next">
              <span>Average score</span>
              <span className="n numeral">{average}</span>
            </div>
          ) : null}
        </div>
        <UsedToday status={status} />
      </aside>
    );
  }

  const anythingToday = tasks.some((t) => isSameDay(t.createdAt));
  return (
    <aside className="ctxrail" aria-label="What is ready">
      {runningBlock('Running now')}
      <RunsNext status={status} />
      {finished.length ? (
        <div className="cx">
          <div className="cx-label">Just finished</div>
          {finished.map((t) => (
            <a
              className="cx-res"
              key={t.id}
              href={`#/tasks/${t.id}`}
              onClick={() => onOpen(t.id)}
            >
              <span className="t">{t.title}</span>
              <span className="path">results/{t.id.slice(0, 8)}</span>
            </a>
          ))}
        </div>
      ) : anythingToday ? null : (
        <Subscriptions status={status} />
      )}
      <UsedToday status={status} />
    </aside>
  );
}
