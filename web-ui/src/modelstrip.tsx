import type { ActiveRun, Effort, RoutingState, Status } from './api';
import { plainName } from './util';

/**
 * The slim line under the composer: which model is on the job right now, and
 * the Auto/Manual switch. In Manual the person pins the model and effort
 * themselves; in Auto the router picks per task and this line shows its pick
 * live, helpers included.
 */

const ROLE_WORD: Record<ActiveRun['role'], string> = {
  work: 'working',
  planning: 'planning',
  review: 'reviewing',
  helper: 'helping',
};

/** 'work' first, then the helpers, so the main model always leads the line. */
const ROLE_ORDER: ActiveRun['role'][] = ['work', 'planning', 'review', 'helper'];

interface Group {
  provider: string;
  model: string;
  effort: Effort;
  role: ActiveRun['role'];
  count: number;
}

function grouped(runs: ActiveRun[]): Group[] {
  const map = new Map<string, Group>();
  for (const run of runs) {
    const key = `${run.provider}/${run.model}/${run.effort}/${run.role}`;
    const got = map.get(key);
    if (got) got.count++;
    else map.set(key, { ...run, count: 1 });
  }
  return [...map.values()].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
  );
}

export interface ModelStripProps {
  routing: RoutingState | null;
  runs: ActiveRun[];
  status: Status | null;
  onChange: (
    next: { mode: 'auto' } | { mode: 'manual'; provider: string; model: string; effort: Effort },
  ) => void;
}

export function ModelStrip({ routing, runs, status, onChange }: ModelStripProps) {
  if (!routing) return null;

  const manual = routing.mode === 'manual';
  const ready = new Set(
    (status?.providers ?? []).filter((p) => p.ready).map((p) => p.id),
  );
  const groups = grouped(runs);

  const pickDefault = (): { provider: string; model: string } => {
    const first =
      routing.options.find((o) => ready.has(o.provider)) ?? routing.options[0];
    return first ?? { provider: '', model: '' };
  };

  const setMode = (next: 'auto' | 'manual'): void => {
    if (next === 'auto') return onChange({ mode: 'auto' });
    const current =
      routing.provider && routing.model
        ? { provider: routing.provider, model: routing.model }
        : pickDefault();
    if (!current.provider) return;
    onChange({ mode: 'manual', ...current, effort: routing.effort ?? 'medium' });
  };

  return (
    <div className="modelstrip">
      <div className="ms-live" aria-live="polite">
        {groups.length ? (
          groups.map((g) => (
            <span
              key={`${g.provider}${g.model}${g.role}`}
              className={`ms-chip${g.role === 'work' ? ' is-work' : ''}`}
            >
              <span className="ms-pulse" aria-hidden="true" />
              {g.count > 1 ? `${g.count} × ` : ''}
              {plainName(g.provider)} {g.model}
              <span className="ms-effort">{g.effort}</span>
              <span className="ms-role">{ROLE_WORD[g.role]}</span>
            </span>
          ))
        ) : manual ? (
          <span className="ms-chip">
            {plainName(routing.provider ?? '')} {routing.model}
            <span className="ms-effort">{routing.effort}</span>
            <span className="ms-role">ready</span>
          </span>
        ) : (
          <span className="ms-idle">Auto: the best model for each task.</span>
        )}
      </div>

      {manual ? (
        <span className="ms-picks">
          <select
            className="ms-select"
            aria-label="Model"
            value={`${routing.provider}/${routing.model}`}
            onChange={(e) => {
              const [provider, ...rest] = e.target.value.split('/');
              onChange({
                mode: 'manual',
                provider,
                model: rest.join('/'),
                effort: routing.effort ?? 'medium',
              });
            }}
          >
            {routing.options.map((o) => (
              <option
                key={`${o.provider}/${o.model}`}
                value={`${o.provider}/${o.model}`}
                disabled={!ready.has(o.provider)}
              >
                {plainName(o.provider)} {o.model}
                {ready.has(o.provider) ? '' : ' (signed out)'}
              </option>
            ))}
          </select>
          <select
            className="ms-select"
            aria-label="Effort"
            value={routing.effort ?? 'medium'}
            onChange={(e) =>
              onChange({
                mode: 'manual',
                provider: routing.provider ?? '',
                model: routing.model ?? '',
                effort: e.target.value as Effort,
              })
            }
          >
            {routing.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort} effort
              </option>
            ))}
          </select>
        </span>
      ) : null}

      <div className="ms-mode" role="group" aria-label="Who picks the model">
        <button
          type="button"
          className={`ms-seg${manual ? '' : ' is-on'}`}
          aria-pressed={!manual}
          onClick={() => setMode('auto')}
        >
          Auto
        </button>
        <button
          type="button"
          className={`ms-seg${manual ? ' is-on' : ''}`}
          aria-pressed={manual}
          onClick={() => setMode('manual')}
        >
          Manual
        </button>
      </div>
    </div>
  );
}
