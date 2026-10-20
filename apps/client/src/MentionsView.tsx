import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
} from 'lucide-react';
import { JOURNEY_STAGES, brandRank, brandSentimentScore } from '@citevia/core';
import { SentimentScore } from './ScoreBadge';
import type { Page, PromptResult } from '@citevia/core';
import { downloadCsv, query, request, useApi } from './api';
import { Badge, Empty, ErrorNotice, Spinner } from './components';

export default function MentionsView({
  path,
  runId,
  revision,
  onResponse,
  notify,
}: {
  path: string;
  runId?: string;
  revision: number;
  onResponse: (id: string) => void;
  notify: (text: string) => void;
}) {
  const [search, setSearch] = useState(''),
    [debounced, setDebounced] = useState('');
  const [mentioned, setMentioned] = useState(''),
    [sentiment, setSentiment] = useState(''),
    [status, setStatus] = useState(''),
    [stage, setStage] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState<Error>();
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    setCursors([undefined]);
  }, [debounced, mentioned, sentiment, status, stage, runId]);
  const filters = { runId, q: debounced, mentioned, sentiment, status, stage };
  const { data, error, loading } = useApi<Page<PromptResult>>(
    runId
      ? `${path}/responses${query({ ...filters, cursor: cursors.at(-1) })}`
      : null,
    revision,
  );
  async function exportRows() {
    if (!runId) return;
    setExporting(true);
    setExportError(undefined);
    try {
      const rows: PromptResult[] = [];
      let cursor: string | undefined;
      do {
        const page = await request<Page<PromptResult>>(
          `${path}/responses${query({ ...filters, cursor })}`,
        );
        rows.push(...page.items);
        cursor = page.nextCursor || undefined;
      } while (cursor && rows.length < 1000);
      downloadCsv(
        `citevia-mentions-${runId}.csv`,
        [
          'Prompt',
          'Section',
          'Status',
          'Mentioned',
          'Rank',
          'Explicit recommendation rank',
          'Sentiment score (0-100)',
          'Sentiment',
          'Citations',
          'Captured at',
          'Response ID',
        ],
        rows.map((row) => [
          row.prompt.text,
          row.prompt.stage,
          row.status,
          row.target ? String(row.target.mentioned) : '',
          brandRank(row.target),
          row.target?.explicitRank,
          brandSentimentScore(row.target),
          row.target?.sentiment,
          row.citationCount,
          row.capturedAt,
          row.responseId,
        ]),
      );
      notify(`Exported ${rows.length} prompt results.`);
    } catch (error) {
      setExportError(error as Error);
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <ErrorNotice error={exportError} />
      <section className="card">
        <div className="filter-bar">
          <label className="search-field">
            <Search size={14} />
            <span className="visually-hidden">Search prompts</span>
            <input
              placeholder="Search prompts…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select
            aria-label="Filter by section"
            value={stage}
            onChange={(event) => setStage(event.target.value)}
          >
            <option value="">All sections</option>
            {JOURNEY_STAGES.map((value) => (
              <option key={value} value={value}>
                {value[0].toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by visibility"
            value={mentioned}
            onChange={(event) => setMentioned(event.target.value)}
          >
            <option value="">All visibility</option>
            <option value="true">Mentioned</option>
            <option value="false">Not mentioned</option>
          </select>
          <select
            aria-label="Filter by sentiment"
            value={sentiment}
            onChange={(event) => setSentiment(event.target.value)}
          >
            <option value="">All sentiment</option>
            {['positive', 'neutral', 'negative', 'mixed', 'unknown'].map(
              (value) => (
                <option value={value} key={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </option>
              ),
            )}
          </select>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            <option value="succeeded">Analyzed</option>
            <option value="queued">Queued</option>
            <option value="collecting">Collecting</option>
            <option value="extracting">Analyzing</option>
            <option value="failed_collection">Collection failed</option>
            <option value="failed_extraction">Analysis failed</option>
            <option value="refused">Refused</option>
            <option value="incomplete">Incomplete</option>
          </select>
          <button
            className="button button-outline"
            onClick={() => void exportRows()}
            disabled={exporting || !data?.items.length}
          >
            <Download size={12} />
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
        <ErrorNotice error={error} />
        {!runId ? (
          <Empty
            title="No scan selected"
            description="Run your first weekly scan to see how AI providers respond to your prompts."
          />
        ) : loading && !data ? (
          <Spinner label="Loading prompt results…" />
        ) : !data?.items.length ? (
          <Empty
            title="No matching answers"
            description="Try a different search or filter. Brand absence and scan failures are included when no filters are selected."
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Prompt</th>
                    <th>Visibility</th>
                    <th>Rank</th>
                    <th>Sentiment</th>
                    <th>Citations</th>
                    <th>Status</th>
                    <th>
                      <span className="visually-hidden">Open answer</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((result, index) => (
                    <tr key={result.responseId} className="clickable">
                      <td className="prompt-cell">
                        <button
                          className="row-button"
                          onClick={() => onResponse(result.responseId)}
                        >
                          <span className="prompt-index">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <span>
                            <span className="prompt-name">
                              {result.prompt.text}
                            </span>
                            <span className="prompt-category">
                              {result.prompt.stage
                                ? `${result.prompt.stage} · `
                                : ''}
                              {result.prompt.branded ? 'Branded' : 'Discovery'}{' '}
                              · v{result.prompt.version}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td>
                        <Badge
                          value={
                            result.target?.mentioned ? 'positive' : 'neutral'
                          }
                          label={
                            result.target
                              ? result.target.mentioned
                                ? 'Mentioned'
                                : 'Absent'
                              : '—'
                          }
                        />
                      </td>
                      <td>
                        <span className="rank">
                          {brandRank(result.target) != null
                            ? `#${brandRank(result.target)}`
                            : '—'}
                        </span>
                      </td>
                      <td>
                        <SentimentScore
                          brand={
                            result.status === 'succeeded'
                              ? result.target
                              : undefined
                          }
                        />
                      </td>
                      <td>{result.capturedAt ? result.citationCount : '—'}</td>
                      <td>
                        <Badge
                          value={result.status}
                          label={
                            result.status === 'succeeded'
                              ? 'Analyzed'
                              : undefined
                          }
                        />
                      </td>
                      <td>
                        <button
                          className="table-link"
                          aria-label={`Read answer to ${result.prompt.text}`}
                          onClick={() => onResponse(result.responseId)}
                        >
                          <ArrowUpRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {data.items.length} results on this page · {data.total} total
                {loading ? ' · Updating…' : ''}
              </span>
              <div className="page-buttons">
                <button
                  disabled={cursors.length === 1}
                  onClick={() =>
                    setCursors((previous) => previous.slice(0, -1))
                  }
                  aria-label="Previous page"
                >
                  <ChevronLeft size={13} />
                </button>
                <span style={{ padding: '0 8px' }}>Page {cursors.length}</span>
                <button
                  disabled={!data.nextCursor}
                  onClick={() =>
                    setCursors((previous) => [...previous, data.nextCursor!])
                  }
                  aria-label="Next page"
                >
                  <ChevronRight size={13} />
                </button>
              </div>
            </div>
          </>
        )}
      </section>
      <p className="scan-options">
        Rank is company appearance order, matching iGEO. Older scans retain
        their original explicit recommendation rank. Failed and pending answers
        do not count toward visibility.
      </p>
    </>
  );
}
