import { useState } from 'react';
import { CalendarClock, Link2 } from 'lucide-react';
import { DEFAULT_GEO_BACKLINK_SETTINGS, type Project } from '@citevia/core';
import { request } from './api';
import { ErrorNotice } from './components';

export default function GeoBacklinkSettings({ project, path, onSaved, notify }: {
  project: Project; path: string; onSaved: () => void; notify: (text: string) => void;
}) {
  const [enabled, setEnabled] = useState(project.geoBacklinks?.enabled === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  async function toggle() {
    if (saving || project.demo) return;
    setSaving(true); setError(undefined);
    try {
      const saved = await request<Project>(`${path}/settings`, { method: 'PATCH', body: JSON.stringify({
        version: project.version,
        geoBacklinks: {
          enabled: !enabled,
          target: project.geoBacklinks?.target ?? DEFAULT_GEO_BACKLINK_SETTINGS.target,
          exclusionDays: project.geoBacklinks?.exclusionDays ?? DEFAULT_GEO_BACKLINK_SETTINGS.exclusionDays,
          weights: project.geoBacklinks?.weights ?? DEFAULT_GEO_BACKLINK_SETTINGS.weights,
          ...(project.geoBacklinks?.excludedDomains ? { excludedDomains: project.geoBacklinks.excludedDomains } : {}),
        },
      }) });
      setEnabled(saved.geoBacklinks?.enabled === true);
      notify(saved.geoBacklinks?.enabled ? 'Monthly GEO backlink strategy enabled.' : 'Monthly GEO backlink strategy paused. Saved reports are preserved.');
      onSaved();
    } catch (failure) { setError(failure as Error); onSaved(); }
    finally { setSaving(false); }
  }
  return <section className="card" aria-labelledby="geo-backlink-settings-title">
    <div className="card-header"><div><h2 className="card-title" id="geo-backlink-settings-title"><Link2 size={17} /> GEO Backlink Strategy</h2><p className="card-description">System admin · Prepare a monthly editorial outreach plan using your existing AI scans.</p></div></div>
    <div className="card-content"><div className="scanning-control"><div className="scanning-control-heading"><div><strong id="geo-backlink-toggle-label">Monthly backlink strategy</strong><p className="card-description" role="status">{saving ? 'Saving…' : enabled ? 'On' : 'Off'}</p></div><button type="button" className="scanning-switch" role="switch" aria-checked={enabled} aria-labelledby="geo-backlink-toggle-label" aria-describedby="geo-backlink-toggle-description" disabled={saving || Boolean(project.demo)} onClick={() => void toggle()}><span /></button></div><p id="geo-backlink-toggle-description" className="card-description">Recommend up to {project.geoBacklinks?.target ?? 10} new websites each month. A recommended domain stays excluded for {project.geoBacklinks?.exclusionDays ?? 180} days, including rejected and unpublished opportunities.</p><ErrorNotice error={error} /></div><div className="setting-note"><CalendarClock size={17} /><span>1st of each month at 06:00 ({project.timezone}). Uses the previous calendar month’s completed scans.</span></div><p className="scan-options">Your twice-weekly scan schedule stays unchanged. This feature does not send outreach or purchase placements.</p>{enabled && <a className="button button-outline" href="#geo-backlinks">Open GEO Backlink Strategy</a>}</div>
  </section>;
}
