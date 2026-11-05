import { reportExcerpt } from './report-excerpt';
import { Skeleton } from './Loading';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Search,
} from 'lucide-react';
import type { Dashboard, Page, PromptResult, SourceRow } from '@citevia/core';
import { query, useApi } from './api';
import DomainLogo from './DomainLogo';
import FilterDropdown from './FilterDropdown';
import {
  Badge,
  Drawer,
  Empty,
  ErrorNotice,
  ExternalLink,
  formatDate,
  formatNumber,
  Pagination,
  percent,
} from './components';

const SOURCE_PAGE_SIZE = 10;

export default function SourcesView({
  path,
  dashboard,
  onResponse,
}: {
  path: string;
  dashboard: Dashboard;
  onResponse: (id: string) => void;
}) {
  const [kind, setKind] = useState<'cited' | 'consulted'>('cited');
  const [search, setSearch] = useState(''),
    [debounced, setDebounced] = useState(''),
    [owned, setOwned] = useState('');
  const [selected, setSelected] = useState<SourceRow>();
  const [location, setLocation] = useState({ scope: '', page: 0 });
  const runId = dashboard.run?.id;
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const scope = JSON.stringify([path, runId, kind, debounced, owned]);
  const page = location.scope === scope ? location.page : 0;
  const { data, error, loading } = useApi<Page<SourceRow>>(
    runId
      ? `${path}/sources${query({ runId, kind, groupBy: 'domain', q: debounced, owned, limit: SOURCE_PAGE_SIZE, page })}`
      : null,
  );
  return (
    <>
      <div className="summary-inline">
        <div className="summary-item">
          <strong>{formatNumber(dashboard.metrics.uniqueDomains)}</strong>
          <span>
            Cited
            <br />
            domains
          </span>
        </div>
        <div className="summary-item">
          <strong>{formatNumber(dashboard.metrics.uniqueUrls)}</strong>
          <span>
            Unique cited
            <br />
            pages
          </span>
        </div>
        <div className="summary-item">
          <strong>{formatNumber(dashboard.metrics.citations)}</strong>
          <span>
            Citation
            <br />
            annotations
          </span>
        </div>
        <div className="summary-item">
          <strong>{dashboard.metrics.captured}</strong>
          <span>
            Captured
            <br />
            answers
          </span>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="filter-bar">
          <label className="search-field">
            <Search size={14} />
            <span className="visually-hidden">Search source domains</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search domains…"
            />
          </label>
          <div className="tab-buttons" aria-label="Source type">
            <button
              className={kind === 'cited' ? 'active' : ''}
              onClick={() => setKind('cited')}
            >
              Cited sources
            </button>
            <button
              className={kind === 'consulted' ? 'active' : ''}
              onClick={() => setKind('consulted')}
            >
              Retrieved sources
            </button>
          </div>
          <FilterDropdown
            label="Filter source ownership"
            value={owned}
            onChange={setOwned}
            options={[
              { value: '', label: 'All domains' },
              { value: 'true', label: 'Your domains' },
              { value: 'false', label: 'Third-party domains' },
            ]}
          />
          <span className="filter-count">{formatNumber(data?.total)} domains</span>
        </div>
        <div className="inline-notice">
          {kind === 'cited'
            ? 'Coverage is the share of answers that cite each domain.'
            : 'Sources associated with the selected answers. Some may appear without a citation.'}
        </div>
      </div>
      <ErrorNotice error={error} />
      {!runId ? (
        <div className="card">
          <Empty
            title="Your source map is waiting"
            description="Sources will appear here once your first scan captures answers with web search."
          />
        </div>
      ) : loading && !data ? (
        <Skeleton variant="cards" rows={3} label="Mapping the sources behind your answers…" />
      ) : !data && error ? null : !data?.items.length ? (
        <div className="card">
          <Empty
            title="No sources match these filters"
            description="Try another search or source type. Some answers may have no citations or retrieved sources."
          />
        </div>
      ) : (
        <>
          <div className="sources-list">
            {data.items.map((source) => (
              <DomainCard
                key={`${kind}-${source.id}`}
                source={source}
                path={path}
                runId={runId}
                onSelect={setSelected}
              />
            ))}
          </div>
          {data.total > SOURCE_PAGE_SIZE && (
            <Pagination page={page} size={SOURCE_PAGE_SIZE} total={data.total}
              disabled={loading} onChange={(next) => setLocation({ scope, page: next })} />
          )}
        </>
      )}
      {selected && runId && (
        <SourceAnswers
          source={selected}
          path={path}
          runId={runId}
          onClose={() => setSelected(undefined)}
          onResponse={(id) => {
            setSelected(undefined);
            onResponse(id);
          }}
        />
      )}
    </>
  );
}

function DomainCard({
  source,
  path,
  runId,
  onSelect,
}: {
  source: SourceRow;
  path: string;
  runId: string;
  onSelect: (source: SourceRow) => void;
}) {
  const [open, setOpen] = useState(false),
    [cursor, setCursor] = useState<string>();
  const { data, error, loading } = useApi<Page<SourceRow>>(
    open
      ? `${path}/sources${query({ runId, kind: source.kind, groupBy: 'url', domain: source.domain, cursor })}`
      : null,
  );
  return (
    <details
      className="source-card"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="source-card-summary">
        <DomainLogo publisher domain={source.domain} size={30} className="domain-icon" />
        <div className="domain-info">
          <span className="domain-name">{reportExcerpt(source.domain)}</span>
          <span className="domain-meta">
            {source.owned ? 'Your domain' : 'Third-party source'} ·{' '}
            {source.uniqueUrlCount}{' '}
            {source.uniqueUrlCount === 1 ? 'page' : 'pages'}
          </span>
        </div>
        <div className="source-stats">
          <div>
            <strong>{percent(source.coverage)}</strong>
            <small>Coverage</small>
          </div>
          {source.kind === 'cited' && (
            <>
              <div>
                <strong>{source.citationCount}</strong>
                <small>Citations</small>
              </div>
              <div title="Citation occurrences per answer citing this domain">
                <strong>{formatNumber(source.avgCitations, 1)}</strong>
                <small>Avg. citations</small>
              </div>
            </>
          )}
        </div>
        <ChevronRight size={16} />
      </summary>
      {open && (
        <div className="source-urls">
          <p className="card-description">
            {source.promptCount} prompts · Last cited/retrieved{' '}
            {formatDate(source.lastSeenAt, true)}
            {source.kind === 'cited' && (
              <>
                {' '}
                · {percent(source.usedPercent)} citation frequency across
                captured answers (repeats included)
              </>
            )}
          </p>
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              paddingTop: 8,
            }}
          >
            <button
              className="button button-quiet"
              onClick={() => onSelect(source)}
            >
              View answers <ArrowRight size={12} />
            </button>
          </div>
          <ErrorNotice error={error} />
          {loading && !data ? (
            <Skeleton variant="table" label="Loading pages…" />
          ) : (
            data?.items.map((url) => (
              <div className="source-url" key={url.id}>
                <DomainLogo publisher domain={url.domain || url.url} size={24} />
                <div>
                  <ExternalLink url={url.url || ''}>
                    {reportExcerpt(url.title || url.url || '')}
                  </ExternalLink>
                  <small>{reportExcerpt(url.url || '')}</small>
                  <small>
                    {url.citationCount} citations · {url.promptCount} prompts ·
                    Last seen {formatDate(url.lastSeenAt)}
                  </small>
                </div>
                <button className="button" onClick={() => onSelect(url)}>
                  View answers
                  <ArrowUpRight size={12} />
                </button>
              </div>
            ))
          )}
          {(cursor || data?.nextCursor) && (
            <div className="pagination">
              <button
                className="button button-quiet"
                disabled={!cursor}
                onClick={() => setCursor(undefined)}
              >
                First pages
              </button>
              <button
                className="button button-quiet"
                disabled={!data?.nextCursor}
                onClick={() => setCursor(data?.nextCursor || undefined)}
              >
                More pages <ChevronRight size={12} />
              </button>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function SourceAnswers({
  source,
  path,
  runId,
  onClose,
  onResponse,
}: {
  source: SourceRow;
  path: string;
  runId: string;
  onClose: () => void;
  onResponse: (id: string) => void;
}) {
  const [cursor, setCursor] = useState<string>();
  const { data, error, loading } = useApi<Page<PromptResult>>(
    `${path}/sources/${encodeURIComponent(source.id)}/responses${query({ runId, cursor })}`,
  );
  return (
    <Drawer title="Answers using this source" onClose={onClose}>
      <div className="eyebrow">
        {source.kind === 'cited' ? 'Cited source' : 'Retrieved source'}
      </div>
      <h3 className="drawer-prompt" style={{ overflowWrap: 'anywhere' }}>
        {reportExcerpt(source.title || source.domain)}
      </h3>
      {source.url && (
        <div className="source-url">
          <DomainLogo publisher domain={source.domain || source.url} size={24} />
          <ExternalLink url={source.url}>{reportExcerpt(source.url)}</ExternalLink>
        </div>
      )}
      <ErrorNotice error={error} />
      {loading && !data ? (
        <Skeleton variant="table" label="Finding answers…" />
      ) : data?.items.length ? (
        <div className="citation-list">
          {data.items.map((result) => (
            <button
              className="citation"
              style={{ textAlign: 'left' }}
              key={result.responseId}
              onClick={() => onResponse(result.responseId)}
            >
              <div style={{ flex: 1 }}>
                <span className="prompt-name">{reportExcerpt(result.prompt.text)}</span>
                <div style={{ marginTop: 8 }}>
                  <Badge
                    value={
                      result.target?.mentioned
                        ? result.target.sentiment
                        : 'not_applicable'
                    }
                  />
                </div>
              </div>
              <ArrowUpRight
                size={14}
                style={{ color: 'var(--primary, #3930cf)', marginTop: 3 }}
              />
            </button>
          ))}
        </div>
      ) : error ? null : (
        <Empty
          title="No answers found"
          description="This source has no matching answers in the selected scan."
        />
      )}
      {(cursor || data?.nextCursor) && (
        <div className="pagination">
          <button
            className="button button-quiet"
            disabled={!cursor}
            onClick={() => setCursor(undefined)}
          >
            First answers
          </button>
          <button
            className="button button-quiet"
            disabled={!data?.nextCursor}
            onClick={() => setCursor(data?.nextCursor || undefined)}
          >
            More answers <ChevronRight size={12} />
          </button>
        </div>
      )}
    </Drawer>
  );
}
