import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, Plug, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import type { Project } from '@citevia/core';
import { query, request, useApi } from './api';
import { Drawer, Empty, ErrorNotice, formatDate } from './components';
import { Skeleton } from './Loading';
import { mcpClientConfig } from './mcp-config';
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

/** Remount on scope changes so even an in-flight key response cannot cross accounts. */
export default function McpView({ systemAdmin, project, revision }: {
  systemAdmin: boolean;
  project?: Project;
  revision: number;
}) {
  if (!systemAdmin && !project) return <div className="card"><Empty title="Select an account to connect" description="Your MCP connection gives access to one assigned account. Ask your system administrator to assign an account if none are available." /></div>;
  return <ScopedMcpView key={systemAdmin ? 'system' : project!.id} systemAdmin={systemAdmin} project={systemAdmin ? undefined : project} revision={revision} />;
}

function ScopedMcpView({ systemAdmin, project, revision }: { systemAdmin: boolean; project?: Project; revision: number }) {
  const [localRevision, setLocalRevision] = useState(0);
  const result = useApi<Connections>(`/mcp/connections${query({ projectId: systemAdmin ? undefined : project!.id })}`, revision + localRevision);
  const [createOpen, setCreateOpen] = useState(false);
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
      <section className="card mcp-connect" aria-labelledby="mcp-connect-title">
        <div className="mcp-section-heading">
          <span className="mcp-feature-icon"><Plug size={21} /></span>
          <div><h2 id="mcp-connect-title">Connect your AI assistant</h2><p>Use Citevia from an MCP client with Streamable HTTP support.</p></div>
        </div>
        <label className="field" htmlFor="mcp-server-url">Server URL</label>
        <div className="mcp-value-row">
          <input id="mcp-server-url" className="mcp-value" value={data.serverUrl} readOnly onFocus={event => event.currentTarget.select()} />
          <CopyButton value={data.serverUrl} label="Copy URL" />
        </div>
        <div className="mcp-methods">
          {data.oauthEnabled && <div className="mcp-method">
            <span className="mcp-method-label">RECOMMENDED</span>
            <h3>Sign in with Citevia</h3>
            <p>Add a custom MCP connection in your assistant, paste this server URL, and choose OAuth. Sign in to Citevia and approve access when prompted.</p>
            <p className="mcp-method-detail">For ChatGPT, Claude, or other clients that support remote MCP and OAuth. Connector availability depends on your client and plan.</p>
          </div>}
          <div className="mcp-method">
            <span className="mcp-method-label">API KEY</span>
            <h3>Connect with a bearer credential</h3>
            <p>Create a key below, then add it to your client’s Authorization header as <code>Bearer YOUR_API_KEY</code>. Your server URL stays the same.</p>
            <p className="mcp-method-detail">For Cursor or another client that accepts custom HTTP headers. Save the generated key before leaving this page.</p>
          </div>
        </div>
        <details className="mcp-config-details">
          <summary>View JSON configuration</summary>
          <p>{data.oauthEnabled ? 'Use this URL configuration with a client that supports OAuth, or create a key for a configuration that includes the Authorization header.' : 'Create a key below to get this configuration with the required Authorization header.'}</p>
          <ConfigSnippet value={mcpClientConfig(data.serverUrl, data.oauthEnabled ? undefined : 'YOUR_API_KEY')} />
        </details>
      </section>

      {created && <section className="card mcp-created" aria-labelledby="mcp-created-title">
        <div className="mcp-section-heading"><span className="mcp-feature-icon"><KeyRound size={21} /></span><div><h2 id="mcp-created-title">Save your new key</h2><p>The full key is only available now. Store it securely before hiding it or leaving this account.</p></div></div>
        <label className="field" htmlFor="mcp-new-key">{created.connection.name}</label>
        <div className="mcp-value-row"><input id="mcp-new-key" className="mcp-value" value={created.token} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /><CopyButton value={created.token} label="Copy key" /></div>
        <label className="field" htmlFor="mcp-bearer">Authorization header value</label>
        <div className="mcp-value-row"><input id="mcp-bearer" className="mcp-value" value={`Bearer ${created.token}`} readOnly autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /><CopyButton value={`Bearer ${created.token}`} label="Copy bearer" /></div>
        <ConfigSnippet value={mcpClientConfig(created.serverUrl, created.token)} />
        <button className="button button-outline" onClick={() => setCreated(undefined)}><Check size={14} />I saved my key — hide it</button>
      </section>}

      <section className="card mcp-connections" aria-labelledby="mcp-connections-title">
        <div className="mcp-section-heading mcp-connections-heading"><div><h2 id="mcp-connections-title">Your connections</h2><p>Manage the credentials you created for {scopeLabel}. {readOnly && 'Your keys allow read-only access.'}</p></div><button className="button button-primary" onClick={() => { setCreateOpen(true); setNotice(''); }}><Plus size={14} />Create API key</button></div>
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

    {createOpen && <CreateConnection projectId={systemAdmin ? undefined : project!.id} scopeLabel={scopeLabel} onClose={() => setCreateOpen(false)} onCreated={value => {
      setCreated(value);
      setCreateOpen(false);
      setLocalRevision(revision => revision + 1);
      setNotice('API key created. Copy and save it below.');
    }} />}
    {revokeTarget && <Drawer title="Revoke connection" onClose={() => { if (!revoking) { setRevokeTarget(undefined); setError(undefined); } }}>
      <div className="form-stack"><p className="mcp-drawer-copy"><strong>{revokeTarget.name}</strong> will immediately lose access to Citevia. Any assistant using this credential will need a new connection.</p><ErrorNotice error={error} /><div className="mcp-form-actions"><button className="button button-outline" disabled={revoking} onClick={() => { setRevokeTarget(undefined); setError(undefined); }}>Cancel</button><button className="button button-danger" disabled={revoking} onClick={() => void revoke()}>{revoking ? <LoaderCircle size={14} className="spinner" /> : <Trash2 size={14} />}{revoking ? 'Revoking…' : 'Revoke connection'}</button></div></div>
    </Drawer>}
  </div>;
}

function CreateConnection({ projectId, scopeLabel, onClose, onCreated }: { projectId?: string; scopeLabel: string; onClose: () => void; onCreated: (value: CreatedConnection) => void }) {
  const [name, setName] = useState('');
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
    <p className="mcp-drawer-copy">This key will use your permissions for <strong>{scopeLabel}</strong>. Its full value is shown once after creation.</p>
    <ErrorNotice error={error} />
    <label className="field">Connection name<input required maxLength={80} value={name} autoFocus autoComplete="off" placeholder="e.g. Cursor on my laptop" onChange={event => setName(event.target.value)} disabled={saving} /></label>
    <label className="field">Expires after<select value={expires} onChange={event => setExpires(event.target.value)} disabled={saving}><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="">Never</option></select><small>Choose an expiry that matches how long you need this connection.</small></label>
    <div className="mcp-form-actions"><button type="button" className="button button-outline" disabled={saving} onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !name.trim()}>{saving ? <LoaderCircle size={14} className="spinner" /> : <KeyRound size={14} />}{saving ? 'Creating…' : 'Create API key'}</button></div>
  </form></Drawer>;
}
