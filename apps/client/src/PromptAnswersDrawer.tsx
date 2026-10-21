import { Skeleton } from './Loading';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import {
  PROVIDER_LABELS,
  SCAN_PROVIDERS,
  type Page,
  type Prompt,
  type PromptAnswerRow,
  type ResponseDetail,
} from '@citevia/core';
import { query, useApi } from './api';
import {
  Badge,
  Drawer,
  Empty,
  ErrorNotice,
  formatDate,
} from './components';
import AnswerMarkdown from './AnswerMarkdown';
import FilterDropdown from './FilterDropdown';
import { ResponseDetailContent } from './ResponseDrawer';

type Sort = 'date' | 'model' | 'rank' | 'citations' | 'sentiment';
const PAGE_SIZE = 20;

export default function PromptAnswersDrawer({
  path,
  prompt,
  revision,
  initialProvider,
  onClose,
}: {
  path: string;
  prompt: Prompt;
  revision: number;
  initialProvider: string;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState(initialProvider),
    [days, setDays] = useState('all');
  const [sort, setSort] = useState<Sort>('date'),
    [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [cursors, setCursors] = useState<string[]>(['']);
  const [selected, setSelected] = useState<string>();
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView({ block: 'start' });
  }, [selected]);
  const history = useApi<Page<PromptAnswerRow>>(
    `${path}/prompts/${encodeURIComponent(prompt.id)}/responses${query({ provider, days, sort, direction, limit: PAGE_SIZE, cursor: cursors.at(-1) })}`,
    revision,
  );
  const detail = useApi<ResponseDetail>(
    selected ? `${path}/responses/${encodeURIComponent(selected)}` : null,
    revision,
  );
  function filter(change: () => void) {
    change();
    setCursors(['']);
  }
  function sortHeader(label: string, key: Sort) {
    return (
      <th
        scope="col"
        aria-sort={
          sort === key
            ? direction === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'
        }
      >
        <button
          className="answer-sort"
          onClick={() =>
            filter(() => {
              setSort(key);
              setDirection(
                sort === key && direction === 'desc' ? 'asc' : 'desc',
              );
            })
          }
        >
          {label}
          {sort === key &&
            (direction === 'desc' ? (
              <ArrowDown size={14} />
            ) : (
              <ArrowUp size={14} />
            ))}
        </button>
      </th>
    );
  }
  return (
    <Drawer
      title={selected ? 'Answer details' : 'Prompt answers'}
      onClose={onClose}
      wide={!selected}
    >
      <div ref={heading} tabIndex={-1} className="answer-view-heading">
        {selected ? (
          <button
            className="button answer-back"
            onClick={() => setSelected(undefined)}
          >
            <ArrowLeft size={16} />
            Back to all answers
          </button>
        ) : (
          <>
            <p className="drawer-prompt" dir="auto">
              {prompt.text}
            </p>
            <p className="answer-history-note">
              Every saved answer across scans and providers. Open a row to read
              the full answer and its sources.
            </p>
            {!prompt.active && (
              <p className="answer-history-note">
                This prompt is archived. Its previous answers are preserved.
              </p>
            )}
          </>
        )}
      </div>
      {selected ? (
        <>
          <ErrorNotice error={detail.error} />
          {detail.loading && !detail.data ? (
            <Skeleton variant="detail" rows={3} label="Opening the original answer…" />
          ) : (
            detail.data && <ResponseDetailContent data={detail.data} />
          )}
        </>
      ) : (
        <>
          <div className="answer-history-filters">
            <div className="answer-history-filter">
              <span>Provider</span>
              <FilterDropdown
                label="Answer provider"
                value={provider}
                onChange={(value) => filter(() => setProvider(value))}
                options={[
                  { value: '', label: 'All providers' },
                  ...SCAN_PROVIDERS.map((value) => ({
                    value,
                    label: PROVIDER_LABELS[value],
                    icon: (
                      <img
                        src={`/providers/${value}.svg`}
                        alt=""
                        width={20}
                        height={20}
                        aria-hidden="true"
                      />
                    ),
                  })),
                ]}
              />
            </div>
            <div className="answer-history-filter">
              <span>Date range</span>
              <FilterDropdown
                label="Answer date range"
                value={days}
                active={days !== 'all'}
                icon={<CalendarDays size={16} />}
                onChange={(value) => filter(() => setDays(value))}
                options={[
                  { value: 'all', label: 'All time' },
                  { value: '7', label: 'Last 7 days' },
                  { value: '30', label: 'Last 30 days' },
                  { value: '90', label: 'Last 90 days' },
                ]}
              />
            </div>
            {history.data && (
              <span>
                {history.data.total} saved{' '}
                {history.data.total === 1 ? 'answer' : 'answers'}
              </span>
            )}
          </div>
          <ErrorNotice error={history.error} />
          {history.loading && !history.data ? (
            <Skeleton variant="table" label="Loading answer history…" />
          ) : (
            history.data &&
            (history.data.items.length ? (
              <>
                <div className="table-scroll answer-history-panel">
                  <table className="answer-history-table">
                    <thead>
                      <tr>
                        <th scope="col">Response</th>
                        {sortHeader('Model', 'model')}
                        {sortHeader('Rank', 'rank')}
                        <th scope="col">Brands</th>
                        {sortHeader('Citations', 'citations')}
                        {sortHeader('Sentiment', 'sentiment')}
                        {sortHeader('Date', 'date')}
                      </tr>
                    </thead>
                    <tbody>
                      {history.data.items.map((row) => (
                        <tr
                          key={row.responseId}
                          className="answer-history-row"
                          onClick={() => setSelected(row.responseId)}
                        >
                          <td>
                            <button
                              className="answer-row-open"
                              onClick={() => setSelected(row.responseId)}
                              aria-label={`Read ${PROVIDER_LABELS[row.provider]} answer from ${new Date(row.date).toLocaleString()}`}
                            >
                              {row.answerPreview ? (
                                <AnswerMarkdown
                                  text={row.answerPreview}
                                  preview
                                />
                              ) : (
                                <span>
                                  {row.status === 'succeeded'
                                    ? 'Answer preview unavailable'
                                    : 'View scan details'}
                                </span>
                              )}
                              <span className="answer-read-label">
                                Read full answer <ArrowUpRight size={14} />
                              </span>
                            </button>
                            {row.status !== 'succeeded' && (
                              <Badge value={row.status} />
                            )}
                        {row.promptText !== prompt.text && (
                              <small
                                className="answer-version"
                                title={row.promptText}
                              >
                            Previous wording: {row.promptText}
                              </small>
                            )}
                          </td>
                          <td>
                            <strong>{PROVIDER_LABELS[row.provider]}</strong>
                            <small>{row.model}</small>
                            <small>{row.country}</small>
                          </td>
                          <td>{row.rank === null ? '—' : row.rank}</td>
                          <td>
                            <div className="answer-brands">
                              {row.brands.length
                                ? row.brands.map((name) => (
                                    <span key={name}>{name}</span>
                                  ))
                                : '—'}
                            </div>
                          </td>
                          <td>{row.citationCount}</td>
                          <td>
                            {row.sentimentScore === null ? (
                              '—'
                            ) : (
                              <span
                                className={`prompt-sentiment ${row.sentimentScore >= 60 ? 'positive' : row.sentimentScore >= 40 ? 'neutral' : 'negative'}`}
                              >
                                {row.sentimentScore}
                              </span>
                            )}
                          </td>
                          <td>
                            <time dateTime={row.date}>
                              {formatDate(row.date, true)}
                              <small>
                                {new Date(row.date).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </small>
                            </time>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="pagination">
                  <span>
                    {(cursors.length - 1) * PAGE_SIZE + 1}–
                    {Math.min(cursors.length * PAGE_SIZE, history.data.total)}{' '}
                    of {history.data.total}
                  </span>
                  <div className="page-buttons">
                    <button
                      aria-label="Previous answers"
                      disabled={cursors.length === 1 || history.loading}
                      onClick={() => setCursors(cursors.slice(0, -1))}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      aria-label="Next answers"
                      disabled={!history.data.nextCursor || history.loading}
                      onClick={() =>
                        history.data?.nextCursor &&
                        setCursors([...cursors, history.data.nextCursor])
                      }
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <Empty
                title="No saved answers in this range"
                description="Try all time or another provider. New answers appear here after a scan."
              />
            ))
          )}
        </>
      )}
    </Drawer>
  );
}
