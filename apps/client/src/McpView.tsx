import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Copy, KeyRound, LoaderCircle, Plug, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { Project } from '@citevia/core';
import { query, request, useApi } from './api';
import { Drawer, Empty, ErrorNotice, formatDate } from './components';
import { Skeleton } from './Loading';
import { claudeConnectorUrl, mcpClientConfig, mcpConnectionUrl } from './mcp-config';
import './mcp.css';

type Connection = {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  kind: 'api_key' | 'oauth';
};
type Connections = {
  scope: 'system' | 'account';
  projectId: string | null;
  projectName: string | null;
  serverUrl: string;
  oauthEnabled: boolean;
  connections: Connection[];
};
type CreatedConnection = Pick<Connections, 'serverUrl' | 'scope' | 'projectId'> & {
  connection: Connection;
  token: string;
};

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setCopied(false);
    setError('');
  }, [value]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    setError('');
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError('Copy unavailable. Select and copy the value manually.');
    }
  }
  return <div className="mcp-copy-action">
    <button type="button" className="button button-outline" onClick={() => void copy()}>
      {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : label}
    </button>
    {error && <span className="mcp-copy-error" role="alert">{error}</span>}
  </div>;
}

function ConfigSnippet({ value }: { value: string }) {
  return <div className="mcp-config">
    <div className="mcp-config-heading"><span>Client configuration</span><CopyButton value={value} label="Copy JSON" /></div>
    <pre tabIndex={0}>{value}</pre>
  </div>;
}

function AssistantActions({ connectionUrl, onCreate }: { connectionUrl?: string; onCreate: (name: string) => void }) {
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed'>();
  useEffect(() => setCopyStatus(undefined), [connectionUrl]);
  async function copyForChatGpt() {
    if (!connectionUrl) return;
    try {
      await navigator.clipboard.writeText(connectionUrl);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }
  return <div className="mcp-assistants">
    <div className="mcp-assistant-actions">
      {connectionUrl ? <>
        <a className="button button-primary" href={claudeConnectorUrl(connectionUrl)} target="_blank" rel="noopener noreferrer">Add to Claude<ArrowUpRight size={14} /></a>
        <a className="button button-primary" href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer" onClick={() => void copyForChatGpt()}>Add to ChatGPT<ArrowUpRight size={14} /></a>
      </> : <>
        <button className="button button-primary" onClick={() => onCreate('Claude')}>Add to Claude<ArrowUpRight size={14} /></button>
        <button className="button button-primary" onClick={() => onCreate('ChatGPT')}>Add to ChatGPT<ArrowUpRight size={14} /></button>
      </>}
    </div>
    {copyStatus === 'copied' && <p className="mcp-copy-success" role="status">Connection URL copied. Paste it into ChatGPT’s Server URL field and choose None / No authentication.</p>}
    {copyStatus === 'failed' && <p className="mcp-copy-error" role="alert">The URL could not be copied automatically. Return here, select and copy the full Connection URL on this page, then paste it into ChatGPT’s Server URL field.</p>}
  </div>;
}

export function CreatedConnectionPanel({ created, onHide }: { created: CreatedConnection; onHide: () => void }) {
  const connectionUrl = mcpConnectionUrl(created.serverUrl, created.token, created.projectId);
  return <section className="card mcp-created" aria-labelledby="mcp-created-title">
    <div className="mcp-section-heading"><span className="mcp-feature-icon"><KeyRound size={21} /></span><div><h2 id="mcp-created-title">Your connection URL is ready</h2><p>This URL includes your API key. Keep it private and save it now; its full value is only available until you hide it or leave this account.</p></div></div>
    <label className="field" htmlFor="mcp-connection-url">Connection URL (URL-only)<small>{created.connection.name}</small></label>
    <div className="mcp-value-row"><textarea id="mcp-connection-url" className="mcp-value mcp-connection-url" value={connectionUrl} rows={3} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /><CopyButton value={connectionUrl} label="Copy connection URL" /></div>
    <div className="mcp-url-instructions"><p>Paste the <strong>full connection URL</strong> into your assistant’s <strong>Server URL</strong> field. Select <strong>None / No authentication</strong>: the API key is already included in the URL.</p><p>“Add to ChatGPT” copies this URL and opens the connector setup page. “Add to Claude” opens its connector form with this URL filled in.</p></div>
    <AssistantActions connectionUrl={connectionUrl} onCreate={() => undefined} />
    <details className="mcp-config-details">
      <summary>Advanced: API key, bearer header and JSON</summary>
      <p>For clients with header authentication, use the normal server URL and the bearer credential below.</p>
      <label className="field" htmlFor="mcp-new-key">API key</label>
      <div className="mcp-value-row"><input id="mcp-new-key" className="mcp-value" value={created.token} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /><CopyButton value={created.token} label="Copy key" /></div>
      <label className="field" htmlFor="mcp-bearer">Authorization header value</label>
      <div className="mcp-value-row"><input id="mcp-bearer" className="mcp-value" value={`Bearer ${created.token}`} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /><CopyButton value={`Bearer ${created.token}`} label="Copy bearer" /></div>
      <ConfigSnippet value={mcpClientConfig(created.serverUrl, created.token)} />
    </details>
    <button className="button button-outline" onClick={onHide}><Check size={14} />I saved my connection URL — hide it</button>
  </section>;
}

/** Remount on scope changes so even an in-flight key response cannot cross accounts. */
export default function McpView({ systemAdmin, project }: {
  systemAdmin: boolean;
  project?: Project;
}) {
  if (!systemAdmin && !project) return <div className="card"><Empty title="Select an account to connect" description="Your MCP connection gives access to one assigned account. Ask your system administrator to assign an account if none are available." /></div>;
  return <ScopedMcpView key={systemAdmin ? 'system' : project!.id} systemAdmin={systemAdmin} project={systemAdmin ? undefined : project} />;
}

function ScopedMcpView({ systemAdmin, project }: { systemAdmin: boolean; project?: Project }) {
  const [localRevision, setLocalRevision] = useState(0);
  const result = useApi<Connections>(`/mcp/connections${query({ projectId: systemAdmin ? undefined : project!.id })}`, localRevision);
  const [createOpen, setCreateOpen] = useState(false);
  const [suggestedName, setSuggestedName] = useState('');
  const [created, setCreated] = useState<CreatedConnection>();
  const [revokeTarget, setRevokeTarget] = useState<Connection>();
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<Error>();
  const [notice, setNotice] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const data = result.data;
  const scopeLabel = systemAdmin ? 'All accounts' : data?.projectName || project!.name;
  const readOnly = !systemAdmin && project?.role !== 'owner';
  function openCreate(name = '') {
    setSuggestedName(name);
    setCreateOpen(true);
    setNotice('');
  }

  async function revoke() {
    if (!revokeTarget || revoking) return;
    setRevoking(true);
    setError(undefined);
    try {
      await request<void>(`/mcp/connections/${encodeURIComponent(revokeTarget.id)}`, { method: 'DELETE' });
      if (!live.current) return;
      if (created?.connection.id === revokeTarget.id) setCreated(undefined);
      setRevokeTarget(undefined);
      setNotice('Connection revoked. This credential can no longer access Citevia.');
      setLocalRevision(value => value + 1);
    } catch (error) {
      if (live.current) setError(error as Error);
    } finally {
      if (live.current) setRevoking(false);
    }
  }

  return <div className="mcp-page">
    <section className="mcp-scope card" aria-labelledby="mcp-scope-title">
      <span className="mcp-feature-icon"><ShieldCheck size={23} /></span>
      <div>
        <div className="eyebrow">{systemAdmin ? 'SYSTEM ADMIN CONNECTION' : 'ACCOUNT CONNECTION'}</div>
        <h2 id="mcp-scope-title">{scopeLabel}</h2>
        <p>{systemAdmin
          ? 'One MCP connection gives you access to every account, including accounts added later. Switching accounts here does not change this connection.'
          : `This connection is limited to ${scopeLabel}. Switch accounts to set up a separate connection for another account.`}</p>
        <span className="mcp-access"><ShieldCheck size={13} />{readOnly ? 'Read-only access · Viewer' : systemAdmin ? 'System administrator access' : 'Account owner access'}</span>
        <p className="mcp-scope-footnote">Each connection uses your current permissions. Removing your access also removes the connection’s access.</p>
      </div>
    </section>

    <ErrorNotice error={result.error} retry={() => setLocalRevision(value => value + 1)} />
    {!revokeTarget && <ErrorNotice error={error} />}
    {notice && <div className="mcp-success" role="status"><Check size={16} />{notice}</div>}
    {result.loading && !data ? <Skeleton variant="cards" rows={2} label="Loading your MCP connections…" /> : data && <>
      {created && <CreatedConnectionPanel key={created.connection.id} created={created} onHide={() => { setCreated(undefined); setNotice(''); }} />}
      <section className="card mcp-connect" aria-labelledby="mcp-connect-title">
        <div className="mcp-section-heading">
          <span className="mcp-feature-icon"><Plug size={21} /></span>
          <div><h2 id="mcp-connect-title">Connect your AI assistant</h2><p>Use Citevia from an MCP client with Streamable HTTP support.</p></div>
        </div>
        <label className="field" htmlFor="mcp-server-url">Server URL (OAuth or bearer authentication)</label>
        <div className="mcp-value-row">
          <input id="mcp-server-url" className="mcp-value" value={data.serverUrl} readOnly onFocus={event => event.currentTarget.select()} />
          <CopyButton value={data.serverUrl} label="Copy URL" />
        </div>
        <div className="mcp-methods">
          <div className="mcp-method mcp-method-url">
            <span className="mcp-method-label">URL-ONLY CONNECTION</span>
            <h3>Connect with one URL</h3>
            <p>Create a key to get a full connection URL, then paste it into your assistant’s Server URL field and choose <strong>None / No authentication</strong>. No separate login or Authorization header is needed.</p>
            <p className="mcp-method-detail">Start with an assistant below. Your connection URL is shown once after key creation.</p>
            <AssistantActions connectionUrl={created ? mcpConnectionUrl(created.serverUrl, created.token, created.projectId) : undefined} onCreate={openCreate} />
          </div>
          {data.oauthEnabled && <div className="mcp-method">
            <span className="mcp-method-label">OAUTH</span>
            <h3>Sign in with Citevia</h3>
            <p>For OAuth, paste the normal server URL above and choose OAuth. Sign in to Citevia and approve access when prompted.</p>
            <p className="mcp-method-detail">For ChatGPT, Claude, or other clients that support remote MCP and OAuth. Connector availability depends on your client and plan.</p>
          </div>}
        </div>
        <details className="mcp-config-details">
          <summary>View JSON configuration</summary>
          <p>{data.oauthEnabled ? 'Use this URL configuration with a client that supports OAuth, or create a key for a configuration that includes the Authorization header.' : 'Create a key below to get this configuration with the required Authorization header.'}</p>
          <ConfigSnippet value={mcpClientConfig(data.serverUrl, data.oauthEnabled ? undefined : 'YOUR_API_KEY')} />
        </details>
      </section>

      <section className="card mcp-connections" aria-labelledby="mcp-connections-title">
        <div className="mcp-section-heading mcp-connections-heading"><div><h2 id="mcp-connections-title">Your connections</h2><p>Manage the credentials you created for {scopeLabel}. {readOnly && 'Your keys allow read-only access.'}</p></div><button className="button button-primary" onClick={() => openCreate()}><Plus size={14} />Create API key</button></div>
        {!data.connections.length ? <Empty title="No connections yet" description={data.oauthEnabled ? 'Connect an assistant using OAuth or create your first API key.' : 'Create an API key to connect your assistant to Citevia.'} /> : <div className="table-scroll"><table className="mcp-table"><thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Status</th><th><span className="mcp-visually-hidden">Actions</span></th></tr></thead><tbody>{data.connections.map(connection => {
          const expired = Boolean(connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now());
          const status = connection.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active';
          return <tr key={connection.id}>
            <td><strong>{connection.name}</strong><span className="mcp-connection-detail">{connection.kind === 'oauth' ? 'OAuth' : `${connection.keyPrefix}…`}</span></td>
            <td>{formatDate(connection.createdAt, true)}</td>
            <td>{connection.lastUsedAt ? formatDate(connection.lastUsedAt, true) : 'Never'}</td>
            <td><span className={`tag ${status === 'Active' ? 'positive' : 'neutral'}`}>{status}</span><span className="mcp-connection-detail">{connection.expiresAt ? `Expires ${formatDate(connection.expiresAt, true)}` : 'No expiry'}</span></td>
            <td><button className="button button-outline" disabled={Boolean(connection.revokedAt)} aria-label={`Revoke ${connection.name}`} onClick={() => { setError(undefined); setRevokeTarget(connection); }}><Trash2 size={13} />Revoke</button></td>
          </tr>;
        })}</tbody></table></div>}
      </section>
    </>}

    {createOpen && <CreateConnection projectId={systemAdmin ? undefined : project!.id} scopeLabel={scopeLabel} suggestedName={suggestedName} onClose={() => setCreateOpen(false)} onCreated={value => {
      setCreated(value);
      setCreateOpen(false);
      setLocalRevision(revision => revision + 1);
      setNotice('Connection URL created. Copy and save the full URL below.');
    }} />}
    {revokeTarget && <Drawer title="Revoke connection" onClose={() => { if (!revoking) { setRevokeTarget(undefined); setError(undefined); } }}>
      <div className="form-stack"><p className="mcp-drawer-copy"><strong>{revokeTarget.name}</strong> will immediately lose access to Citevia. Any assistant using this credential will need a new connection.</p><ErrorNotice error={error} /><div className="mcp-form-actions"><button className="button button-outline" disabled={revoking} onClick={() => { setRevokeTarget(undefined); setError(undefined); }}>Cancel</button><button className="button button-danger" disabled={revoking} onClick={() => void revoke()}>{revoking ? <LoaderCircle size={14} className="spinner" /> : <Trash2 size={14} />}{revoking ? 'Revoking…' : 'Revoke connection'}</button></div></div>
    </Drawer>}
  </div>;
}

function CreateConnection({ projectId, scopeLabel, suggestedName, onClose, onCreated }: { projectId?: string; scopeLabel: string; suggestedName: string; onClose: () => void; onCreated: (value: CreatedConnection) => void }) {
  const [name, setName] = useState(suggestedName);
  const [expires, setExpires] = useState('90');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const live = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const value = await request<CreatedConnection>('/mcp/connections', { method: 'POST', body: JSON.stringify({ name: name.trim(), expiresInDays: expires ? Number(expires) : null, ...(projectId ? { projectId } : {}) }) });
      if (live.current) onCreated(value);
    } catch (error) {
      if (live.current) setError(error as Error);
    } finally {
      submitting.current = false;
      if (live.current) setSaving(false);
    }
  }
  return <Drawer title="Create API key" onClose={() => { if (!saving) onClose(); }}><form className="form-stack" onSubmit={event => void create(event)}>
    <p className="mcp-drawer-copy">This key will use your permissions for <strong>{scopeLabel}</strong>. Your full connection URL and API key are shown once after creation.</p>
    <ErrorNotice error={error} />
    <label className="field">Connection name<input required maxLength={80} value={name} autoFocus autoComplete="off" placeholder="e.g. Cursor on my laptop" onChange={event => setName(event.target.value)} disabled={saving} /></label>
    <label className="field">Expires after<select value={expires} onChange={event => setExpires(event.target.value)} disabled={saving}><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="">Never</option></select><small>Choose an expiry that matches how long you need this connection.</small></label>
    <div className="mcp-form-actions"><button type="button" className="button button-outline" disabled={saving} onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle size={14} className="spinner" /> : <KeyRound size={14} />}{saving ? 'Creating…' : 'Create API key'}</button></div>
  </form></Drawer>;
}
