import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ActiveRun, BoardEvent, Catalog, Effort, RoutingState, Status, TaskRecord } from './api';
import {
  fetchCatalog,
  fetchRouting,
  fetchStatus,
  fetchTasks,
  postAnswer,
  postRead,
  postRouting,
  postTask,
} from './api';
import { ContextRail } from './ctxrail';
import { AiaxMark, Icon, type IconName } from './marks';
import { AgentsPage } from './pages/agents';
import { BoardPage } from './pages/board';
import { ChatPage } from './pages/chat';
import { InboxPage } from './pages/inbox';
import { Onboarding } from './pages/onboarding';
import { PluginsPage } from './pages/plugins';
import { SettingsPage } from './pages/settings';
import { TaskCrumb, TaskPage } from './pages/task';
import { headline } from './util';

const NAME_KEY = 'aiax-name';
const DONE_KEY = 'aiax-onboarded';

type Page = 'chat' | 'inbox' | 'agents' | 'tasks' | 'task' | 'plugins' | 'settings';

interface Route {
  page: Page;
  id?: string;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [head, tail] = raw.split('/');
  if (head === 'tasks') return tail ? { page: 'task', id: tail } : { page: 'tasks' };
  if (head === 'chat') return { page: 'chat', id: tail };
  if (head === 'inbox' || head === 'agents' || head === 'plugins' || head === 'settings') {
    return { page: head };
  }
  return { page: 'chat' };
}

const RAIL: { page: Page; href: string; icon: IconName; label: string }[] = [
  { page: 'chat', href: '#/', icon: 'chat', label: 'Chat' },
  { page: 'inbox', href: '#/inbox', icon: 'inbox', label: 'Inbox' },
  { page: 'agents', href: '#/agents', icon: 'agents', label: 'Agents' },
  { page: 'tasks', href: '#/tasks', icon: 'tasks', label: 'Tasks' },
  { page: 'plugins', href: '#/plugins', icon: 'plugins', label: 'Plugins' },
];

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [live, setLive] = useState(true);
  const [runs, setRuns] = useState<ActiveRun[]>([]);
  const [routing, setRouting] = useState<RoutingState | null>(null);
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem(DONE_KEY) === 'yes');
  const [trouble, setTrouble] = useState<string | null>(null);

  const go = useCallback((href: string) => {
    window.location.hash = href;
  }, []);

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const pullStatus = useCallback(() => {
    void fetchStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetchTasks()
      .then((got) => setTasks(got.tasks))
      .catch(() => undefined);
    void fetchCatalog()
      .then(setCatalog)
      .catch(() => undefined);
    void fetchRouting()
      .then((got) => {
        setRouting(got);
        setRuns(got.active);
      })
      .catch(() => undefined);
    pullStatus();
  }, [pullStatus]);

  useEffect(() => {
    const source = new EventSource('api/events');
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (message) => {
      setLive(true);
      let event: BoardEvent;
      try {
        event = JSON.parse(message.data) as BoardEvent;
      } catch {
        return;
      }
      if (event.type === 'activity') {
        setRuns(event.runs);
        return;
      }
      if (event.type === 'routing') {
        // Another surface flipped the switch; this one follows along.
        setRouting((old) => (old ? { ...old, ...event.routing } : old));
        return;
      }
      if (event.type === 'task') {
        const incoming = event.task;
        setTasks((old) => {
          const at = old.findIndex((t) => t.id === incoming.id);
          if (at < 0) return [incoming, ...old];
          const copy = [...old];
          // The record on the wire has no lines while it is only a status change.
          copy[at] = { ...incoming, lines: incoming.lines?.length ? incoming.lines : copy[at].lines };
          return copy;
        });
        if (incoming.status === 'done' || incoming.status === 'failed') pullStatus();
        return;
      }
      setTasks((old) =>
        old.map((task) => {
          if (task.id !== event.taskId) return task;
          const at = task.lines.findIndex((l) => l.id === event.line.id);
          if (at < 0) return { ...task, lines: [...task.lines, event.line] };
          const lines = [...task.lines];
          lines[at] = event.line;
          return { ...task, lines };
        }),
      );
    };
    return () => source.close();
  }, [pullStatus]);

  const agents = useMemo(
    () =>
      [...(catalog?.agents ?? [])].sort(
        (a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name),
      ),
    [catalog],
  );
  const plugins = catalog?.plugins ?? [];
  const current = route.page === 'task' ? tasks.find((t) => t.id === route.id) : undefined;

  const openTask = useCallback(
    (id: string) => {
      setTasks((old) => old.map((t) => (t.id === id ? { ...t, unread: false } : t)));
      postRead(id);
      go(`#/tasks/${id}`);
    },
    [go],
  );

  const send = useCallback(
    (text: string, files: File[], agent?: string) => {
      setTrouble(null);
      void postTask({ text, files, agent })
        .then((task) => {
          setTasks((old) => (old.some((t) => t.id === task.id) ? old : [task, ...old]));
          // Chat and the board both show the new task where you already are.
          if (route.page !== 'chat' && route.page !== 'tasks') go(`#/tasks/${task.id}`);
        })
        .catch((err: Error) => setTrouble(err.message));
    },
    [go, route.page],
  );

  const changeRouting = useCallback(
    (next: { mode: 'auto' } | { mode: 'manual'; provider: string; model: string; effort: Effort }) => {
      setTrouble(null);
      void postRouting(next)
        .then(setRouting)
        .catch((err: Error) => setTrouble(err.message));
    },
    [],
  );

  const answer = useCallback((id: string, text: string, questionId?: string) => {
    setTasks((old) =>
      old.map((t) => (t.id === id ? { ...t, question: undefined, sentence: 'Got it, carrying on.' } : t)),
    );
    void postAnswer(id, text, questionId).catch((err: Error) => setTrouble(err.message));
  }, []);

  const unread = tasks.filter((t) => t.unread).length;
  const say = useMemo(() => headline(tasks, status?.providers ?? []), [tasks, status]);
  const waiting = tasks.some((t) => t.question);

  if (!onboarded) {
    return (
      <Onboarding
        status={status}
        plugins={plugins}
        name={name}
        onRefresh={pullStatus}
        onDone={(chosen) => {
          setName(chosen);
          localStorage.setItem(NAME_KEY, chosen);
          localStorage.setItem(DONE_KEY, 'yes');
          setOnboarded(true);
        }}
      />
    );
  }

  const hasRail =
    route.page === 'chat' ||
    route.page === 'inbox' ||
    route.page === 'agents' ||
    route.page === 'plugins';

  const title = (): ReactNode => {
    if (route.page === 'task') {
      return <TaskCrumb title={current?.title ?? 'Task'} onBack={() => go('#/tasks')} />;
    }
    if (route.page === 'tasks') return <h2>Tasks</h2>;
    if (route.page === 'inbox') return <h2>Inbox</h2>;
    if (route.page === 'agents') return <h2>Agents</h2>;
    if (route.page === 'plugins') return <h2>Plugins</h2>;
    if (route.page === 'settings') return <h2>Settings and usage</h2>;
    return <h2>Chat</h2>;
  };

  const chatAgent = route.page === 'chat' ? agents.find((a) => a.id === route.id) : undefined;

  return (
    <div className={`frame${live ? '' : ' is-offline'}`}>
      {live ? null : (
        <div className="reconnect" role="status">
          Lost the connection to the app. Trying again.
        </div>
      )}

      <nav className="rail" aria-label="Main">
        <AiaxMark />
        {RAIL.map((item) => (
          <a
            className="rail-item"
            key={item.page}
            href={item.href}
            aria-current={
              route.page === item.page || (item.page === 'tasks' && route.page === 'task')
                ? 'page'
                : undefined
            }
            aria-label={
              item.page === 'inbox' && unread ? `${item.label}, ${unread} new` : item.label
            }
          >
            <Icon name={item.icon} />
            {item.page === 'inbox' && unread ? <span className="rail-badge" /> : null}
            <span className="tip" aria-hidden="true">
              {item.label}
              {item.page === 'inbox' && unread ? (
                <span className="tip-sub">{unread} new</span>
              ) : null}
            </span>
          </a>
        ))}
        <div className="rail-spacer" />
        <a
          className="rail-item"
          href="#/settings"
          aria-current={route.page === 'settings' ? 'page' : undefined}
          aria-label="Settings and usage"
        >
          <Icon name="settings" />
          <span className="tip" aria-hidden="true">
            Settings and usage
          </span>
        </a>
      </nav>

      <div className={`pane${hasRail ? ' hasrail' : ''}`}>
        <div className="topbar">
          {title()}
          <div className="status" aria-live="polite">
            <span className={`dot-sq${waiting ? ' accent' : ''}`} aria-hidden="true" />
            {trouble ?? say}
          </div>
        </div>

        {route.page === 'chat' ? (
          <ChatPage
            tasks={tasks}
            agents={agents}
            agent={chatAgent}
            name={name}
            routing={routing}
            runs={runs}
            status={status}
            onRouting={changeRouting}
            onSend={send}
            onAnswer={(id, text) => answer(id, text)}
            onPickAgent={(id) => go(`#/chat/${id}`)}
          />
        ) : null}

        {route.page === 'tasks' ? (
          <BoardPage
            tasks={tasks}
            agents={agents}
            status={status}
            onOpen={openTask}
            onInbox={() => go('#/inbox')}
            onSend={(text, files) => send(text, files)}
          />
        ) : null}

        {route.page === 'task' ? (
          current ? (
            <TaskPage
              task={current}
              status={status}
              onAnswer={answer}
              onSend={(text, files) => send(text, files)}
            />
          ) : (
            <div className="detail">
              <div className="dcol">
                <div className="empty">
                  <h4>That task is not here.</h4>
                  <p>It may have been started on another day. The board has everything.</p>
                </div>
              </div>
            </div>
          )
        ) : null}

        {route.page === 'inbox' ? (
          <InboxPage
            tasks={tasks}
            agents={agents}
            onOpen={openTask}
            onSend={(text, files) => send(text, files)}
          />
        ) : null}

        {route.page === 'agents' ? (
          <AgentsPage
            agents={agents}
            plugins={plugins}
            status={status}
            onPick={(id) => go(`#/chat/${id}`)}
            onSend={(text, files) => send(text, files)}
          />
        ) : null}

        {route.page === 'plugins' ? (
          <PluginsPage plugins={plugins} onSend={(text, files) => send(text, files)} />
        ) : null}

        {route.page === 'settings' ? (
          <SettingsPage
            status={status}
            name={name}
            onRerunSetup={() => {
              localStorage.removeItem(DONE_KEY);
              setOnboarded(false);
            }}
          />
        ) : null}

        {hasRail ? (
          <ContextRail
            variant={route.page === 'chat' ? 'chat' : (route.page as 'inbox' | 'agents' | 'plugins')}
            tasks={tasks}
            status={status}
            catalog={catalog}
            onOpen={openTask}
            onStop={openTask}
          />
        ) : null}
      </div>
    </div>
  );
}
