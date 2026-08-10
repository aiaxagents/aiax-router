import { useState } from 'react';
import type { PluginTemplate, Status } from '../api';
import { DecisionBlock } from '../decision';
import { AiaxMark, Brand, Icon } from '../marks';
import { plainName } from '../util';

const STATIONS = ['Welcome', 'Subscriptions', 'Extras', 'Ready'];

/** Where each station sits on the ruled measure, centred in its quarter. */
function stationLeft(index: number): string {
  return `${(index + 0.5) * (100 / STATIONS.length)}%`;
}

function Band({ step }: { step: number }) {
  return (
    <div className="band">
      <div className="band-top">
        <AiaxMark className="logo-tile xl" />
        <div className="band-name">
          <b>AiAx Router</b>
          <span>Setting up</span>
        </div>
      </div>

      <div className="measure">
        <svg
          className="measure-ticks"
          height="9"
          width="100%"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <pattern id="ob-ticks" width="13" height="9" patternUnits="userSpaceOnUse">
              <rect x="0" y="0" width="1" height="4" fill="oklch(0.60 0.13 32)" />
            </pattern>
          </defs>
          <rect width="100%" height="9" fill="url(#ob-ticks)" />
        </svg>
        <span className="measure-line" />
        <span className="measure-run" style={{ width: stationLeft(step) }} />
        {STATIONS.map((name, i) => (
          <i
            key={name}
            className={`station${i < step ? ' is-done' : i === step ? ' is-now' : ''}`}
            style={{ left: stationLeft(i) }}
          />
        ))}
      </div>

      <ol className="stations">
        {STATIONS.map((name, i) => (
          <li
            key={name}
            className={i < step ? 'is-done' : i === step ? 'is-now' : undefined}
            style={{ left: stationLeft(i) }}
          >
            {name}
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface OnboardingProps {
  status: Status | null;
  plugins: PluginTemplate[];
  name: string;
  onRefresh: () => void;
  onDone: (name: string) => void;
}

export function Onboarding({ status, plugins, name, onRefresh, onDone }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState(name);
  const [leaving, setLeaving] = useState(false);

  const providers = status?.providers ?? [];
  const ready = providers.filter((p) => p.ready).length;
  const next = (): void => setStep((s) => Math.min(s + 1, STATIONS.length - 1));

  const finish = (): void => {
    setLeaving(true);
    setTimeout(() => onDone(typed.trim()), 900);
  };

  if (leaving) {
    return (
      <div className="ob-beat">
        <AiaxMark className="logo-tile xl" />
      </div>
    );
  }

  return (
    <div className="onboard-screen">
      <Band step={step} />

      <div className="ob-body">
        {step === 0 ? (
          <>
            <div className="ob-lead">
              <div>
                <h3>What should I call you?</h3>
                <p className="lede">It only goes in the greeting. Nothing is sent anywhere.</p>
              </div>
              <span className="illo illo-onb">
                <img src="./assets/illo-onboarding.png" alt="" />
              </span>
            </div>
            <input
              className="ob-name"
              value={typed}
              autoFocus
              placeholder="Type your name"
              aria-label="Your name"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typed.trim()) next();
              }}
            />
            <div className="ob-foot">
              <div className="right">
                <span className="kb">
                  <kbd>Enter</kbd> continues.
                </span>
                <button className="btn-primary" disabled={!typed.trim()} onClick={next}>
                  Continue
                </button>
              </div>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="ob-lead">
              <div>
                <h3>Which AI subscriptions do you have?</h3>
                <p className="lede">
                  We looked on this computer already. Two or three is plenty, and you can add more later.
                </p>
              </div>
            </div>

            <div className="spec">
              {providers.map((p) => (
                <div key={p.id}>
                  <div className="specrow">
                    <Brand id={p.id} size="lg" />
                    <b>{plainName(p.id, p.displayName)}</b>
                    <span className="leader" aria-hidden="true" />
                    {p.ready ? (
                      <span className="state-ok">
                        <Icon name="check" size={13} /> Ready
                      </span>
                    ) : (
                      <span className={`n${p.installed ? ' is-todo' : ''}`}>
                        {p.installed ? 'Sign in' : 'Not here'}
                      </span>
                    )}
                  </div>
                  <div className="spechint">
                    {p.ready ? (
                      <p>Ready to go. Nothing more to do.</p>
                    ) : p.dead ? (
                      <p>Taking a break after a problem. It comes back on its own.</p>
                    ) : p.installed ? (
                      <p>
                        On this computer, but you have not signed in. Sign in the way you normally do,
                        then press Look again.
                      </p>
                    ) : (
                      <p>Not on this computer. Skip it, you can add it whenever you like.</p>
                    )}
                  </div>
                </div>
              ))}
              {providers.length ? null : <p className="lede">Looking at what you have.</p>}
            </div>

            <div className="ob-foot">
              <button className="link-quiet" onClick={onRefresh}>
                Look again
              </button>
              <div className="right">
                <span className="kb">
                  {ready
                    ? `${ready} ready.`
                    : 'None yet. You can carry on and sort it out later.'}
                </span>
                <button className="btn-primary" onClick={next}>
                  Continue
                </button>
              </div>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="ob-lead">
              <div>
                <h3>Anything extra?</h3>
                <p className="lede">
                  These are paid tools for pictures, video and email. You do not need any of them to
                  start, and you can add one later from the Plugins page.
                </p>
              </div>
            </div>

            <div className="spec">
              {plugins.map((plugin) => (
                <div key={plugin.id}>
                  <div className="specrow">
                    <Brand id={plugin.brand ?? plugin.id} size="lg" />
                    <b>{plugin.name}</b>
                    <span className="leader" aria-hidden="true" />
                    {plugin.connected ? (
                      <span className="state-ok">
                        <Icon name="check" size={13} /> Connected
                      </span>
                    ) : (
                      <span className="n">Not yet</span>
                    )}
                  </div>
                  <div className="spechint">
                    <p>{plugin.does ?? ''}</p>
                  </div>
                </div>
              ))}
              {plugins.length ? null : <p className="lede">Nothing to add yet.</p>}
            </div>

            <div className="ob-foot">
              <div className="right">
                <span className="kb">All of these are optional.</span>
                <button className="btn-primary" onClick={next}>
                  Continue
                </button>
              </div>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div className="ob-lead">
              <div>
                <h3>{ready ? "You're set. Ask for anything." : 'Almost there.'}</h3>
                <p className="lede">
                  {ready
                    ? 'Say what you want done in plain words. The router picks who does the work and tells you when it is finished.'
                    : 'Nothing is connected yet, so nothing can run. You can still look around.'}
                </p>
              </div>
              {ready ? (
                <div className="dcount">
                  <div className="numeral">{ready}</div>
                  <span>{ready === 1 ? 'subscription ready' : 'subscriptions ready'}</span>
                </div>
              ) : null}
            </div>

            {ready ? null : (
              <div style={{ marginTop: '22px' }}>
                <DecisionBlock
                  small
                  question={{
                    id: 'none-connected',
                    question: 'Nothing is connected yet.',
                    choices: [
                      {
                        label: 'Look again',
                        means: 'Check this computer once more for subscriptions you have signed into.',
                        recommended: true,
                      },
                      {
                        label: 'Carry on anyway',
                        means: 'Open the app. Nothing will run until something is connected.',
                      },
                    ],
                  }}
                  onPick={(answer) => (answer === 'Look again' ? onRefresh() : finish())}
                />
              </div>
            )}

            <div className="ob-foot">
              <div className="right">
                <span className="kb">{typed.trim() ? `See you inside, ${typed.trim()}.` : ''}</span>
                <button className="btn-primary" onClick={finish}>
                  Start using it
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
