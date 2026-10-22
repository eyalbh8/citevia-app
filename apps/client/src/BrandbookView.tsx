import { Skeleton } from './Loading';
import { useState, type FormEvent } from 'react';
import { ExternalLink, Save } from 'lucide-react';
import type { Brandbook } from '@citevia/core';
import { request, useApi } from './api';
import { Empty, ErrorNotice, formatDate } from './components';
type BookData = { brandbook: Brandbook | null; version: number; role: string };
export default function BrandbookView({
  path,
  onSaved,
  notify,
  readOnly = false,
}: {
  path: string;
  onSaved: () => void;
  notify: (text: string) => void;
  readOnly?: boolean;
}) {
  const { data, error, loading } = useApi<BookData>(
    `${path}/brandbook`,
  );
  return (
    <>
      <ErrorNotice error={error} retry={onSaved} />
      {loading && !data ? (
        <Skeleton variant="form" label="Loading brandbook…" />
      ) : data?.brandbook ? (
        <BrandbookForm
          key={`${path}:${data.version}`}
          data={data as BookData & { brandbook: Brandbook }}
          path={path}
          onSaved={onSaved}
          notify={notify}
          readOnly={readOnly}
        />
      ) : error ? null : (
        <section className="card">
          <Empty
            title="Your brandbook is being prepared"
            description="Create an account in Accounts to generate its brandbook, or check the setup status there."
          />
        </section>
      )}
    </>
  );
}
function BrandbookForm({
  data,
  path,
  onSaved,
  notify,
  readOnly,
}: {
  data: BookData & { brandbook: Brandbook };
  path: string;
  onSaved: () => void;
  notify: (text: string) => void;
  readOnly: boolean;
}) {
  const [draft, setDraft] = useState(data.brandbook),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error>();
  const owner = data.role === 'owner' && !readOnly;
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const {
        about,
        industryCategory,
        subIndustryCategory,
        names,
        keyFeatures,
        toneOfVoice,
        values,
        personality,
        targetAudience,
        knowledgeSources,
        sitemapUrl,
        caseStudiesSourceUrl,
        postGuidelines,
        evidence,
        unknowns,
      } = draft;
      const clean = (items: string[]) =>
        items.map((item) => item.trim()).filter(Boolean);
      await request(`${path}/brandbook`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: data.version,
          about,
          industryCategory,
          subIndustryCategory,
          names: clean(names),
          keyFeatures: clean(keyFeatures),
          toneOfVoice: clean(toneOfVoice),
          values: clean(values),
          personality: clean(personality),
          targetAudience: clean(targetAudience),
          knowledgeSources: clean(knowledgeSources),
          sitemapUrl,
          caseStudiesSourceUrl,
          postGuidelines: {
            dos: clean(postGuidelines.dos),
            donts: clean(postGuidelines.donts),
          },
          evidence,
          unknowns,
        }),
      });
      notify('Brandbook saved. Existing scan snapshots are preserved.');
      onSaved();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }
  const arrays = [
    'names',
    'keyFeatures',
    'targetAudience',
    'toneOfVoice',
    'values',
    'personality',
    'knowledgeSources',
  ] as const;
  const labels = {
    names: 'Names & aliases',
    keyFeatures: 'Key features',
    targetAudience: 'Target audience',
    toneOfVoice: 'Tone of voice',
    values: 'Values',
    personality: 'Personality',
    knowledgeSources: 'Knowledge sources',
  };
  return (
    <div className="brandbook-layout">
      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Company brandbook</h2>
            <p className="card-description">
              Your company identity, audience, voice and source library.
            </p>
          </div>
        </div>
        <form
          className="card-content form-stack"
          onSubmit={(event) => void save(event)}
        >
          <ErrorNotice error={error} />
          <fieldset disabled={!owner || busy} className="onboarding-fieldset">
            <label className="field">
              About the company
              <textarea
                required
                minLength={20}
                maxLength={10000}
                rows={5}
                value={draft.about}
                onChange={(e) => setDraft({ ...draft, about: e.target.value })}
              />
            </label>
            <div className="field-row">
              <label className="field">
                Industry
                <input
                  value={draft.industryCategory}
                  onChange={(e) =>
                    setDraft({ ...draft, industryCategory: e.target.value })
                  }
                />
              </label>
              <label className="field">
                Subindustry
                <input
                  value={draft.subIndustryCategory}
                  onChange={(e) =>
                    setDraft({ ...draft, subIndustryCategory: e.target.value })
                  }
                />
              </label>
            </div>
            <div className="journey-grid">
              {arrays.map((key) => (
                <label className="field" key={key}>
                  {labels[key]}
                  <textarea
                    rows={4}
                    value={draft[key].join('\n')}
                    onChange={(e) =>
                      setDraft({ ...draft, [key]: e.target.value.split('\n') })
                    }
                  />
                  <small>One value per line.</small>
                </label>
              ))}
            </div>
            <div className="field-row">
              <label className="field">
                Sitemap URL
                <input
                  type="url"
                  value={draft.sitemapUrl || ''}
                  onChange={(e) =>
                    setDraft({ ...draft, sitemapUrl: e.target.value || null })
                  }
                />
              </label>
              <label className="field">
                Case studies URL
                <input
                  type="url"
                  value={draft.caseStudiesSourceUrl || ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      caseStudiesSourceUrl: e.target.value || null,
                    })
                  }
                />
              </label>
            </div>
            <div className="field-row">
              {(['dos', 'donts'] as const).map((key) => (
                <label className="field" key={key}>
                  {key === 'dos'
                    ? 'Writing guidelines'
                    : 'Claims and wording to avoid'}
                  <textarea
                    rows={4}
                    value={draft.postGuidelines[key].join('\n')}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        postGuidelines: {
                          ...draft.postGuidelines,
                          [key]: e.target.value.split('\n'),
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            {owner && (
              <div className="form-actions">
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={busy}
                >
                  <Save size={13} />
                  {busy ? 'Saving…' : 'Save brandbook'}
                </button>
              </div>
            )}
          </fieldset>
        </form>
      </section>
      <aside>
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Research provenance</h2>
          </div>
          <div className="card-content">
            <p className="scan-options">
              Generated {formatDate(draft.generatedAt)}
              <br />
              Model: {draft.model}
              <br />
              Brandbook version: {draft.version}
            </p>
            {draft.unknowns.length > 0 && (
              <>
                <h3 className="drawer-section-title">Needs verification</h3>
                <ul className="brandbook-unknowns">
                  {draft.unknowns.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="drawer-section-title">Research evidence</h3>
            {draft.evidence.map((item, index) => (
              <div className="brandbook-evidence" key={index}>
                <small>{item.field}</small>
                <blockquote>{item.quote}</blockquote>
                <a href={item.url} target="_blank" rel="noreferrer">
                  {new URL(item.url).hostname}
                  <ExternalLink size={11} />
                </a>
              </div>
            ))}
            {!draft.evidence.length && (
              <p className="scan-options">
                No researched evidence is attached to this profile.
              </p>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}
