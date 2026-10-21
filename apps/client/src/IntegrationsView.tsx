import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Info, Link2, Plug, Search, Settings2, X, Zap } from 'lucide-react';
import type { Project } from '@citevia/core';
import { query, useApi } from './api';
import { Drawer, Empty, ErrorNotice } from './components';
import IntegrationMark from './IntegrationMark';
import { filterIntegrations, INTEGRATIONS, INTEGRATION_CATEGORIES, type Integration, type IntegrationCategory } from './integration-catalog';
import './agents-integrations.css';

type McpConnections = { connections: { revokedAt: string | null; expiresAt: string | null }[] };

export default function IntegrationsView({ systemAdmin, project, highlight, onMcp, onTraffic }: {
  systemAdmin: boolean;
  project?: Project;
  highlight?: string;
  onMcp: () => void;
  onTraffic: () => void;
}) {
  const [category, setCategory] = useState<IntegrationCategory>('All');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Integration>();
  const highlighted = useRef<HTMLElement>(null);
  const mcp = useApi<McpConnections>(systemAdmin || project
    ? `/mcp/connections${query({ projectId: systemAdmin ? undefined : project!.id })}` : null);
  const activeConnections = mcp.data?.connections.filter(connection => !connection.revokedAt &&
    (!connection.expiresAt || Date.parse(connection.expiresAt) > Date.now())).length ?? 0;
  const items = filterIntegrations(category, search);
  useEffect(() => {
    if (!highlight || !INTEGRATIONS.some(item => item.id === highlight)) return;
    setCategory('All');
    setSearch('');
    setSelected(undefined);
  }, [highlight]);
  useEffect(() => {
    if (!highlight || category !== 'All' || search) return;
    // Wait until the card is rendered and the workspace has reset page scroll.
    const frame = requestAnimationFrame(() => highlighted.current?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [highlight, category, search]);

  return <div className="integrations-screen">
    <section className="integrations-hero" aria-labelledby="integrations-title">
      <div className="integration-floating-tiles" aria-hidden="true">
        {['bing', 'slack', 'facebook', 'google', 'cloudflare', 'instagram'].map(id =>
          <span key={id} className={`integration-floating-tile floating-${id}`}><IntegrationMark integration={INTEGRATIONS.find(item => item.id === id)!} size={30} /></span>)}
      </div>
      <span className="integrations-eyebrow"><Zap size={14} />Integrations</span>
      <h1 id="integrations-title">Connect the tools behind every <span>AI answer</span></h1>
      <p>Bring your content, traffic and data into Citevia — and give your brand more ways to be discovered.</p>
    </section>

    <div className="integrations-toolbar">
      <div className="integration-categories" role="group" aria-label="Integration category">
        {INTEGRATION_CATEGORIES.map(value => <button key={value} aria-pressed={value === category} onClick={() => setCategory(value)}>{value}</button>)}
      </div>
      <div className="integration-search"><Search size={17} /><input aria-label="Search integrations" placeholder="Search integrations" value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</div>
    </div>
    <div className="integration-results-meta" role="status"><span>{items.length} {items.length === 1 ? 'integration' : 'integrations'}{category === 'All' ? ' available to explore' : ` in ${category}`}</span><span><Plug size={13} />MCP connections are available now</span></div>
    <ErrorNotice error={mcp.error} />
    <div className="integrations-grid">
      {items.map(item => {
        const isMcp = item.category === 'MCP';
        const ready = isMcp && activeConnections > 0;
        return <article key={item.id} ref={item.id === highlight ? highlighted : undefined} id={`integration-${item.id}`} className={`integration-card${item.id === highlight ? ' is-highlighted' : ''}`} aria-label={item.name}>
          <div className="integration-card-tint" style={{ background: item.tint }}>
            {ready && <span className="integration-ready"><Check size={13} />MCP ready</span>}
          </div>
          <span className="integration-card-logo"><IntegrationMark integration={item} /></span>
          <div className="integration-card-body"><h2>{item.name}</h2><p>{item.description}</p>
            {!isMcp && <span className="integration-availability">Coming soon</span>}
            <button className={`integration-card-action${ready ? ' is-ready' : ''}`} onClick={() => isMcp ? onMcp() : setSelected(item)}>
              {ready ? <Settings2 size={16} /> : isMcp ? <Link2 size={16} /> : <Info size={16} />}{ready ? 'Manage' : isMcp ? 'Connect' : 'View setup'}
            </button>
            {isMcp && <button className="integration-setup-link" onClick={() => setSelected(item)}>View setup guide</button>}
          </div>
        </article>;
      })}
    </div>
    {!items.length && <div className="card"><Empty title="No integrations match your search" description="Try a different name or category."><button className="button button-outline" onClick={() => { setSearch(''); setCategory('All'); }}>Clear filters</button></Empty></div>}
    <aside className="integration-bottom-note"><span className="integration-note-icon"><Plug size={20} /></span><div><h2>Your tools. One connected workspace.</h2><p>Manage assistant access in MCP connections, or set up first-party website tracking in AI Traffic.</p></div><button className="button button-outline" onClick={onTraffic}>Website tracking<ArrowRight size={14} /></button></aside>

    {selected && <Drawer title={`${selected.name} setup`} onClose={() => setSelected(undefined)}>
      <div className="integration-setup-intro"><span style={{ background: selected.tint }}><IntegrationMark integration={selected} size={40} /></span><h3>{selected.name}</h3><p>{selected.description}</p></div>
      {selected.category === 'MCP' ? <>
        <div className="setting-note"><Plug size={17} /><span>{activeConnections ? 'Your MCP credentials are ready. Add the connection to your client to finish setup.' : 'Create a Citevia MCP connection to get a connection URL and client configuration.'}</span></div>
        <ol className="integration-setup-steps"><li>Open MCP connections and create a connection for your assistant or workflow.</li><li>Copy the connection URL or the advanced client configuration.</li><li>Add Citevia in your client’s MCP settings. Access follows your Citevia permissions.</li></ol>
        <p className="integration-scope-note">{systemAdmin ? 'System administrators can connect to all accounts.' : project ? `This connection is scoped to ${project.name}.` : 'An assigned account is required before you can connect.'} A ready credential does not confirm that the client has been linked.</p>
        <button className="button button-primary" onClick={onMcp}><Plug size={15} />Open MCP connections<ArrowRight size={15} /></button>
      </> : <>
        <div className="setting-note" role="status"><Info size={17} /><span><strong>Not available in Citevia yet.</strong> {selected.category === 'Social Media' || selected.category === 'Publishing' ? 'Account connection and publishing are not enabled for this provider.' : 'This provider’s connection is not enabled yet.'}</span></div>
        <p className="integration-scope-note">When this integration is available, you’ll be able to authorize your account and manage it here.</p>
        {selected.category === 'Analytics' && <button className="button button-primary" onClick={onTraffic}>Set up Citevia website tracking<ArrowRight size={15} /></button>}
        <button className="button button-outline" onClick={() => setSelected(undefined)}>Done</button>
      </>}
    </Drawer>}
  </div>;
}
