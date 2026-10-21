import { useRef, useState } from 'react';
import { ArrowRight, LoaderCircle, Plug, ShieldCheck } from 'lucide-react';
import { query, request, useApi } from './api';
import { ErrorNotice, Logo } from './components';
import { Skeleton } from './Loading';
import './mcp.css';

type Consent = {
  clientName: string;
  scope: 'system' | 'account';
  projectId: string | null;
  projectName: string | null;
  expiresAt: string;
  projects?: { id: string; name: string; role: 'owner' | 'viewer' }[];
};

export default function McpConsent({ requestId }: { requestId: string }) {
  const [revision, setRevision] = useState(0);
  const consent = useApi<Consent>(`/mcp/oauth/consent${query({ requestId })}`, revision);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState<'approve' | 'deny'>();
  const [error, setError] = useState<Error>();
  const submitting = useRef(false);
  const data = consent.data;
  const selectAccount = data?.scope === 'account' && !data.projectId;
  const selected = data?.projects?.find(project => project.id === projectId);
  const expired = Boolean(data && Date.parse(data.expiresAt) <= Date.now());

  async function decide(approve: boolean) {
    if (submitting.current || !data) return;
    submitting.current = true;
    setBusy(approve ? 'approve' : 'deny');
    setError(undefined);
    try {
      const result = await request<{ redirectUrl: string }>('/mcp/oauth/consent', {
        method: 'POST',
        body: JSON.stringify({ requestId, approve, ...(selectAccount && projectId ? { projectId } : {}) }),
      });
      const destination = new URL(result.redirectUrl);
      if (!['https:', 'http:'].includes(destination.protocol)) throw new Error('The assistant returned an unsupported redirect address. Restart the connection from your assistant.');
      window.location.assign(destination.href);
    } catch (error) {
      setError(error as Error);
      setBusy(undefined);
      submitting.current = false;
    }
  }

  return <main className="mcp-consent-page">
    <Logo />
    <section className="card mcp-consent" aria-labelledby="mcp-consent-title">
      <span className="mcp-feature-icon"><Plug size={24} /></span>
      <div className="eyebrow">CONNECT YOUR AI ASSISTANT</div>
      <h1 id="mcp-consent-title">{data ? `Connect ${data.clientName} to Citevia?` : 'Connect to Citevia'}</h1>
      <ErrorNotice error={consent.error} retry={() => setRevision(value => value + 1)} />
      {consent.loading && !data && <Skeleton variant="form" rows={2} label="Checking the connection request…" />}
      {data && <>
        <p>Approve this assistant only if you started this connection and trust it to access your Citevia data.</p>
        <div className="mcp-consent-access">
          <ShieldCheck size={20} />
          <div><strong>{data.scope === 'system' ? 'All accounts · System administrator' : data.projectName || 'One account'}</strong>
            <p>{data.scope === 'system'
              ? 'This connection can read data and make changes across every account, including accounts added later, using your system administrator permissions.'
              : 'This connection can access only the selected account, using your current permissions. Viewers have read-only access; owners can also make changes.'}</p>
          </div>
        </div>
        {selectAccount && <label className="field">Account<select value={projectId} onChange={event => setProjectId(event.target.value)} disabled={Boolean(busy)} required><option value="">Choose an account</option>{data.projects?.map(project => <option key={project.id} value={project.id}>{project.name}{project.role === 'viewer' ? ' · Read-only' : ''}</option>)}</select><small>{selected?.role === 'viewer' ? 'Your viewer role permits read-only access to this account.' : 'A separate connection is required for each account.'}</small></label>}
        {selectAccount && !data.projects?.length && <ErrorNotice error="You do not have access to any accounts. Ask your system administrator to assign one, then restart the connection." />}
        {expired && <ErrorNotice error="This connection request has expired. Restart the connection from your assistant." />}
        <p className="mcp-consent-note">You can revoke this connection later in MCP connections. Access ends if your account permissions are removed.</p>
        <ErrorNotice error={error} />
        <div className="mcp-consent-actions">
          <button className="button button-outline" disabled={Boolean(busy)} onClick={() => void decide(false)}>{busy === 'deny' && <LoaderCircle size={14} className="spinner" />}Cancel</button>
          <button className="button button-primary" disabled={Boolean(busy) || expired || Boolean(selectAccount && !selected)} onClick={() => void decide(true)}>{busy === 'approve' ? <LoaderCircle size={14} className="spinner" /> : <ArrowRight size={14} />}{busy === 'approve' ? 'Connecting…' : 'Approve connection'}</button>
        </div>
      </>}
      {consent.error && <a className="button button-outline" href={`${window.location.pathname}#mcp`}>Return to Citevia</a>}
    </section>
  </main>;
}
