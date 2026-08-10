import { useCallback, useEffect, useState } from 'react';
import type { MemoryPageInfo, Status } from '../api';
import { fetchMemory, postMemoryConfirm, postMemoryForget } from '../api';
import { Brand, Icon } from '../marks';
import { leftWord, plainName } from '../util';

function stateLine(p: Status['providers'][number]): string {
  if (p.dead) return p.dead.reason;
  if (!p.installed) return 'Not on this computer yet.';
  if (!p.loggedIn) return `Installed, but not signed in. ${p.loginHint}`;
  return p.detail ? `Ready. ${p.detail}` : 'Ready to use.';
}

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyline">
      <span className="path">{value}</span>
      <button
        className="btn"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => undefined,
          );
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function MemoryRow({
  page,
  onConfirm,
  onForget,
}: {
  page: MemoryPageInfo;
  onConfirm: (page: MemoryPageInfo) => void;
  onForget: (page: MemoryPageInfo) => void;
}) {
  return (
    <div>
      <div className="setrow">
        <b>{page.title}</b>
        {page.stale ? <span className="n is-todo">Still true?</span> : null}
      </div>
      <div className="sethint">
        <p>{page.description || 'Nothing more written down about this one.'}</p>
      </div>
      <div className="copyline">
        <button className="btn" onClick={() => onConfirm(page)}>
          {page.stale ? 'Yes, keep it' : page.tier === 'human' ? 'Confirm again' : 'Confirm'}
        </button>
        <button className="btn" onClick={() => onForget(page)}>
          Forget
        </button>
      </div>
    </div>
  );
}

/** The two shelves of "What it remembers": confirmed by you, and picked up on its own. */
function MemorySection({ name }: { name: string }) {
  const [pages, setPages] = useState<MemoryPageInfo[] | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);

  const pull = useCallback(() => {
    void fetchMemory()
      .then((got) => setPages(got.pages.filter((p) => p.status !== 'deprecated')))
      .catch(() => setPages([]));
  }, []);

  useEffect(pull, [pull]);

  const act = (work: Promise<void>): void => {
    setTrouble(null);
    void work.then(pull).catch((err) => {
      setTrouble(err instanceof Error ? err.message : 'That did not go through.');
      pull();
    });
  };
  const confirm = (page: MemoryPageInfo): void => act(postMemoryConfirm(page.path, name));
  const forget = (page: MemoryPageInfo): void => act(postMemoryForget(page.path));

  const confirmed = (pages ?? []).filter((p) => p.tier === 'human');
  const learned = (pages ?? []).filter((p) => p.tier !== 'human');

  return (
    <div className="dsec">
      <div className="dsec-label">What it remembers</div>
      {pages === null ? (
        <div className="sethint">
          <p>Having a look.</p>
        </div>
      ) : pages.length === 0 ? (
        <div className="sethint">
          <p>
            Nothing yet. What it learns ends up as plain files you can read, in a folder on this
            computer and nowhere else.
          </p>
        </div>
      ) : (
        <>
          <div className="setrow">
            <b>You confirmed this</b>
          </div>
          {confirmed.length ? (
            confirmed.map((p) => (
              <MemoryRow key={p.path} page={p} onConfirm={confirm} onForget={forget} />
            ))
          ) : (
            <div className="sethint">
              <p>Nothing confirmed yet. Anything below you know is right, confirm it.</p>
            </div>
          )}
          <div className="setrow">
            <b>Picked up along the way</b>
          </div>
          {learned.length ? (
            learned.map((p) => (
              <MemoryRow key={p.path} page={p} onConfirm={confirm} onForget={forget} />
            ))
          ) : (
            <div className="sethint">
              <p>Nothing new picked up.</p>
            </div>
          )}
        </>
      )}
      {trouble ? (
        <div className="sethint">
          <p>{trouble}</p>
        </div>
      ) : null}
      <p style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--faint)' }}>
        All of it lives as readable files on this computer, and nowhere else.
      </p>
    </div>
  );
}

export interface SettingsProps {
  status: Status | null;
  name: string;
  onRerunSetup: () => void;
}

export function SettingsPage({ status, name, onRerunSetup }: SettingsProps) {
  const providers = status?.providers ?? [];
  const ready = providers.filter((p) => p.ready).length;

  return (
    <div className="page-wrap">
      <div className="page-intro">
        <div>
          <h3>Settings and usage</h3>
          <p>What is connected, how much you have used, and where your work is kept.</p>
        </div>
        <div className="count">
          <span className="numeral">{ready}</span>
          <span>ready</span>
        </div>
      </div>

      <div className="list">
        <div className="dsec" style={{ marginTop: 0, borderTop: 0, paddingTop: 0 }}>
          <div className="dsec-label">Your subscriptions</div>
          <div className="spec">
            {providers.map((p) => (
              <div key={p.id}>
                <div className="specrow">
                  <Brand id={p.id} size="lg" />
                  <b>{plainName(p.id, p.displayName)}</b>
                  <span className="leader" aria-hidden="true" />
                  {p.ready ? (
                    <span className="state-ok">
                      <Icon name="check" size={13} /> Connected
                    </span>
                  ) : (
                    <span className="n is-todo">{p.installed ? 'Sign in' : 'Not installed'}</span>
                  )}
                </div>
                <div className="spechint">
                  <p>{stateLine(p)}</p>
                  {p.version ? <p>Version {p.version}.</p> : null}
                </div>
              </div>
            ))}
            {providers.length ? null : <p>Looking at what you have.</p>}
          </div>
        </div>

        <div className="dsec">
          <div className="dsec-label">Used this week</div>
          <div className="quota">
            {providers
              .filter((p) => p.installed)
              .map((p) => (
                <div className="qrow" key={p.id}>
                  <span className="svc">
                    <Brand id={p.id} />
                    {plainName(p.id, p.displayName)}
                  </span>
                  {/* two different facts: what the router sent, and what the plan has left */}
                  <span className="num">
                    {p.runs} {p.runs === 1 ? 'run' : 'runs'} from here
                  </span>
                  <span className="left">
                    {leftWord(p.headroom)} on the subscription
                    {p.headroomMeasured ? '' : ', estimated'}
                  </span>
                </div>
              ))}
          </div>
          <p style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--faint)' }}>
            Counted as runs. Your subscriptions never tell anyone the token count, so nothing here
            pretends to know it.
          </p>
        </div>

        <div className="dsec">
          <div className="dsec-label">Other computers</div>
          <div className="setrow">
            <b>Only this computer so far</b>
          </div>
          <div className="sethint">
            <p>
              {status?.fleet.note ??
                'Only this computer so far. Sharing work with another computer is not built yet.'}
            </p>
          </div>
          {status?.fleet.machines.map((m) => (
            <div key={m.name}>
              <div className="setrow">
                <b>{m.name}</b>
                <span className="n">{m.providers.join(', ')}</span>
              </div>
            </div>
          ))}
          <Copyable value={window.location.origin} />
          <p style={{ marginTop: '8px', fontSize: '12.5px', color: 'var(--faint)' }}>
            That address only works on this computer for now.
          </p>
        </div>

        <MemorySection name={name} />

        <div className="dsec">
          <div className="dsec-label">Where your work is kept</div>
          <div className="setrow">
            <b>On this computer, nowhere else</b>
          </div>
          <div className="sethint">
            <p>
              Every task, result and note lives in a folder in your home directory. Nothing is
              uploaded by the router itself.
            </p>
          </div>
          <Copyable value="~/.aiax-router" />
        </div>

        <div className="dsec">
          <div className="dsec-label">Light and dark</div>
          <div className="setrow">
            <b>Follows your computer</b>
          </div>
          <div className="sethint">
            <p>When your computer goes dark, so does this.</p>
          </div>
        </div>

        <div className="dsec">
          <div className="dsec-label">Setup</div>
          <div className="setrow">
            <b>Run the setup again</b>
          </div>
          <div className="sethint">
            <p>Walks you through your subscriptions once more. Nothing is deleted.</p>
          </div>
          <div className="copyline">
            <button className="btn" onClick={onRerunSetup}>
              Start setup
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
