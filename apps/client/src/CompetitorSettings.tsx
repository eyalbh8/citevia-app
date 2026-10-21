import { useState } from 'react';
import { Check, Plus, Search, Trash2 } from 'lucide-react';
import { promptFingerprint, type Brand, type Project } from '@citevia/core';
import { useApi } from './api';
import { ErrorNotice } from './components';
import { Skeleton } from './Loading';
import DomainLogo from './DomainLogo';
import './competitor-settings.css';

type Suggestion = {
  name: string;
  mentions: number;
  evidence: { quote: string; runId: string; promptId: string };
};

export default function CompetitorSettings({
  project,
  path,
  value,
  onChange,
}: {
  project: Project;
  path: string;
  value: Brand[];
  onChange: (brands: Brand[]) => void;
}) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [retry, setRetry] = useState(0);
  const suggestions = useApi<{ items: Suggestion[] }>(
    showSuggestions ? `${path}/competitors/suggestions` : null,
    retry,
  );
  const owner = project.role === 'owner';
  const names = new Set(
    [project.brand, ...value].flatMap((brand) =>
      [brand.name, ...brand.aliases].map(promptFingerprint),
    ),
  );
  const update = (id: string, changes: Partial<Brand>) =>
    onChange(
      value.map((brand) =>
        brand.id === id ? { ...brand, ...changes } : brand,
      ),
    );
  const add = (name = '') =>
    onChange([
      ...value,
      { id: crypto.randomUUID(), name, aliases: [], domains: [] },
    ]);
  return (
    <section
      className="competitor-settings"
      aria-labelledby="competitor-settings-title"
    >
      <header>
        <div>
          <h3 id="competitor-settings-title">Tracked competitors</h3>
          <p>
            Compare up to five competitors in the same AI answers as your brand.
          </p>
        </div>
        <span className="competitor-count">{value.length} / 5</span>
      </header>
      {value.map((competitor, index) => (
        <div className="competitor-editor" key={competitor.id}>
          <div className="competitor-editor-heading">
            <DomainLogo
              domain={competitor.domains[0]}
              name={competitor.name}
              size={28}
            />
            <strong>{competitor.name || `Competitor ${index + 1}`}</strong>
            {owner && (
              <button
                className="icon-button"
                type="button"
                aria-label={`Remove competitor ${competitor.name || index + 1}`}
                onClick={() =>
                  onChange(value.filter((item) => item.id !== competitor.id))
                }
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
          <div className="competitor-editor-fields">
            <label className="field">
              Name
              <input
                required
                maxLength={120}
                value={competitor.name}
                onChange={(event) =>
                  update(competitor.id, { name: event.target.value })
                }
              />
            </label>
            <label className="field">
              Website
              <input
                value={competitor.domains.join(', ')}
                placeholder="competitor.com"
                onChange={(event) =>
                  update(competitor.id, {
                    domains: event.target.value ? [event.target.value] : [],
                  })
                }
              />
            </label>
          </div>
          <label className="field competitor-aliases">
            Other names{' '}
            <span className="field-hint">Optional · separate with commas</span>
            <input
              value={competitor.aliases.join(', ')}
              maxLength={2500}
              onChange={(event) =>
                update(competitor.id, {
                  aliases: event.target.value ? [event.target.value] : [],
                })
              }
            />
          </label>
        </div>
      ))}
      {!value.length && (
        <p className="competitor-empty">
          No competitors assigned yet. Add a brand or find alternatives
          mentioned in your saved answers.
        </p>
      )}
      {owner && (
        <div className="competitor-actions">
          <button
            className="button button-outline"
            type="button"
            disabled={value.length >= 5}
            onClick={() => add()}
          >
            <Plus size={14} /> Add competitor
          </button>
          <button
            className="button button-quiet"
            type="button"
            aria-expanded={showSuggestions}
            onClick={() => setShowSuggestions((shown) => !shown)}
          >
            <Search size={14} />{' '}
            {showSuggestions ? 'Hide suggestions' : 'Find suggestions'}
          </button>
        </div>
      )}
      {showSuggestions && (
        <div
          className="competitor-suggestions"
          aria-label="Suggested competitors"
        >
          <h4>Mentioned in your AI answers</h4>
          <p>
            Alternatives from a sample of recent saved answers. Choose your
            competitors, add their official website, and save your settings to
            start tracking.
          </p>
          <ErrorNotice
            error={suggestions.error}
            retry={() => setRetry((n) => n + 1)}
          />
          {suggestions.loading && (
            <Skeleton
              variant="table"
              rows={3}
              label="Finding competitors in saved answers…"
            />
          )}
          {!suggestions.loading &&
            suggestions.data?.items.map((suggestion) => {
              const added = names.has(promptFingerprint(suggestion.name));
              return (
                <article
                  key={suggestion.name}
                  className="competitor-suggestion"
                >
                  <div>
                    <strong>{suggestion.name}</strong>
                    <span>
                      {suggestion.mentions}{' '}
                      {suggestion.mentions === 1 ? 'answer' : 'answers'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button-outline"
                    disabled={added || value.length >= 5}
                    aria-label={
                      added
                        ? `${suggestion.name} added`
                        : `Add ${suggestion.name} as competitor`
                    }
                    onClick={() => add(suggestion.name)}
                  >
                    {added ? <Check size={14} /> : <Plus size={14} />}
                    {added ? 'Added' : 'Add'}
                  </button>
                  <details>
                    <summary>View evidence</summary>
                    <blockquote>{suggestion.evidence.quote}</blockquote>
                  </details>
                </article>
              );
            })}
          {!suggestions.loading &&
            suggestions.data &&
            !suggestions.data.items.length && (
              <p>
                No new competitors found in recent saved answers. You can add
                one manually, or check again after the next scan.
              </p>
            )}
        </div>
      )}
      {value.length > 0 && (
        <p className="competitor-help">
          Saved answers with verified mentions contribute to the dashboard.
          Future scans measure each competitor’s mentions, rank, and sentiment.
        </p>
      )}
    </section>
  );
}
