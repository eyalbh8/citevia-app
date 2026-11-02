import { useState, type FormEvent } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import type { Brand, Project } from '@citevia/core';
import { request } from './api';
import { ErrorNotice } from './components';
import CompetitorSettings from './CompetitorSettings';

export default function CompetitorsView(props: {
  project: Project; path: string; onSaved: () => void; notify: (text: string) => void;
}) {
  return <CompetitorsForm key={`${props.project.id}-${props.project.version}`} {...props} />;
}

function CompetitorsForm({ project, path, onSaved, notify }: {
  project: Project; path: string; onSaved: () => void; notify: (text: string) => void;
}) {
  const [value, setValue] = useState<Brand[]>(project.competitors);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error>();
  const [dirty, setDirty] = useState(false);
  const split = (items: string[]) => [...new Set(items.flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean))];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    setError(undefined);
    try {
      await request(`${path}/competitors`, {
        method: 'PATCH',
        body: JSON.stringify({ version: project.version, competitors: value.map(item => ({
          ...item, name: item.name.trim(), aliases: split(item.aliases), domains: split(item.domains),
        })) }),
      });
      setDirty(false);
      notify('Competitors saved. Your comparisons have been updated.');
      onSaved();
    } catch (error) { setError(error as Error); }
    finally { setSaving(false); }
  }
  return (
    <form className="card competitors-page" onSubmit={event => void submit(event)}>
      <div className="card-content">
        <ErrorNotice error={error} retry={onSaved} />
        <fieldset disabled={saving} className="competitors-fieldset">
          <CompetitorSettings project={project} path={path} value={value} onChange={items => { setValue(items); setDirty(true); }} />
        </fieldset>
      </div>
      <footer className="competitors-footer">
        <p>Changes apply to this account for everyone with access.</p>
        <button className="button button-primary" type="submit" disabled={saving || !dirty}>
          {saving ? <LoaderCircle size={14} className="spinner" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save competitors'}
        </button>
      </footer>
    </form>
  );
}
