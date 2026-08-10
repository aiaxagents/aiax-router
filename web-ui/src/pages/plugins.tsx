import { useState } from 'react';
import type { PluginTemplate } from '../api';
import { Composer } from '../composer';
import { Brand, Icon } from '../marks';

function Row({ plugin }: { plugin: PluginTemplate }) {
  const [showHow, setShowHow] = useState(false);
  return (
    <div className="prow">
      <Brand id={plugin.brand ?? plugin.id} size="xl" />
      <div>
        <div className="name">
          <b>{plugin.name}</b>
          {plugin.label ? <span className="kind">{plugin.label}</span> : null}
        </div>
        {plugin.does ? <p className="does">{plugin.does}</p> : null}
        {plugin.note && !plugin.connected ? (
          <p className="note">
            <span>{plugin.note}</span>
            {showHow && plugin.keyEnv ? (
              <span>
                Put your key in {plugin.keyEnv} before you start the app, and this turns green.
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="acts">
        {plugin.pricingUrl ? (
          <a
            className="link-quiet"
            href={plugin.pricingUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            See pricing
          </a>
        ) : null}
        {plugin.connected ? (
          <span className="state-ok">
            <Icon name="check" size={13} /> Connected
          </span>
        ) : plugin.keyEnv ? (
          <button className="btn" onClick={() => setShowHow(!showHow)}>
            {showHow ? 'Hide' : 'How to connect'}
          </button>
        ) : (
          <span className="state">Not connected</span>
        )}
      </div>
    </div>
  );
}

export interface PluginsProps {
  plugins: PluginTemplate[];
  onSend: (text: string, files: File[]) => void;
}

export function PluginsPage({ plugins, onSend }: PluginsProps) {
  const connected = plugins.filter((p) => p.connected).length;

  return (
    <>
      <div className="page-wrap">
        <div className="page-intro">
          <div>
            <h3>Tools for mail, pictures, video and sound</h3>
            <p>Your agents pick these on their own when a task needs them.</p>
          </div>
          <div className="count">
            <span className="numeral">{connected}</span>
            <span>connected</span>
          </div>
        </div>

        <div className="list">
          {plugins.map((plugin) => (
            <Row key={plugin.id} plugin={plugin} />
          ))}
          {plugins.length ? null : (
            <div className="empty">
              <p>Nothing to add yet.</p>
            </div>
          )}
        </div>
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
