import { Fragment } from 'react';
import type { AgentTemplate, PluginTemplate, Status } from '../api';
import { Composer } from '../composer';
import { Avatar, Brand } from '../marks';
import { agentReady, optionMet } from '../needs';

export interface AgentsProps {
  agents: AgentTemplate[];
  plugins: PluginTemplate[];
  status: Status | null;
  onPick: (id: string) => void;
  onSend: (text: string, files: File[]) => void;
}

export function AgentsPage({ agents, plugins, status, onPick, onSend }: AgentsProps) {
  const ready = agents.filter((a) => agentReady(a, status, plugins)).length;

  return (
    <>
      <div className="page-wrap">
        <div className="page-intro">
          <div>
            <h3>Who you can talk to</h3>
            <p>
              {ready
                ? `${ready} of ${agents.length} can run with what you have connected.`
                : 'Connect a subscription and these come alive.'}
            </p>
          </div>
          <div className="count">
            <span className="numeral">{agents.length}</span>
            <span>agents</span>
          </div>
        </div>

        <div className="list">
          {agents.map((agent) => {
            const usable = agentReady(agent, status, plugins);
            return (
              <div className="arow" key={agent.id}>
                <Avatar file={agent.avatar} />
                <div>
                  <b>{agent.name}</b>
                  <p className="does">{agent.tagline}</p>
                </div>
                <div className="areq">
                  {agent.requires?.length ? (
                    <p className="needs">
                      <span className="needs-label">Needs</span>
                      {agent.requires.map((group, gi) => (
                        <Fragment key={gi}>
                          {gi ? <span className="conj">and</span> : null}
                          {group.any.map((option, oi) => (
                            <Fragment key={`${option.kind}${option.id ?? option.name}`}>
                              {oi ? <span className="conj">or</span> : null}
                              <span
                                className={`req${optionMet(option, status, plugins) ? '' : ' is-missing'}`}
                              >
                                {option.id ? <Brand id={option.id} /> : null}
                                {option.name}
                              </span>
                            </Fragment>
                          ))}
                        </Fragment>
                      ))}
                    </p>
                  ) : null}
                  {!usable && agent.hint ? <p className="needs-hint">{agent.hint}</p> : null}
                </div>
                <button className="btn" onClick={() => onPick(agent.id)}>
                  Chat
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="dock">
        <Composer
          placeholder="Write what you want done."
          hint="Pick an agent, or just say what you need and I pick one."
          onSend={onSend}
        />
      </div>
    </>
  );
}
