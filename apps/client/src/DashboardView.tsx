import { brandRank } from '@citevia/core';
import { SentimentScore } from './ScoreBadge';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CircleHelp,
  Eye,
  Hash,
  Link2,
  MessageSquareText,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import type {
  Dashboard,
  Page,
  PromptResult,
  SourceRow,
  TrendPoint,
} from '@citevia/core';
import { query, useApi } from './api';
import {
  Badge,
  Empty,
  ErrorNotice,
  formatDate,
  formatNumber,
  percent,
  Spinner,
} from './components';

const sentimentColors: Record<string, string> = {
  positive: '#7fbf9c',
  neutral: '#b5a1df',
  negative: '#e4a4b3',
  mixed: '#dbc29c',
  unknown: '#d8d2df',
};
export function DashboardView({
  dashboard,
  path,
  revision,
  onResponse,
  onMentions,
  onSources,
}: {
  dashboard: Dashboard;
  path: string;
  revision: number;
  onResponse: (id: string) => void;
  onMentions: () => void;
  onSources: () => void;
}) {
  const { metrics, run, comparison } = dashboard;
  const recent = useApi<Page<PromptResult>>(
    run ? `${path}/responses${query({ runId: run.id })}` : null,
    revision,
  );
  const delta = comparison.visibilityDelta;
  const mentionedSentiment = Object.entries(metrics.sentiment).filter(
    ([key]) => key !== 'not_applicable',
  );
  if (!run)
    return (
      <div className="card">
        <Empty
          title="Your first scan starts here"
          description="Add your prompts in Settings, then start a scan. Your visibility, mentions and sources will appear here as answers are collected."
        />
      </div>
    );
  return (
    <>
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">
            Brand visibility{' '}
            <CircleHelp size={11}>
              <title>
                Share of successfully analyzed answers that mention your brand.
              </title>
            </CircleHelp>
            <span className="metric-icon">
              <Eye size={17} />
            </span>
          </div>
          <div className="metric-value">
            {formatNumber(metrics.visibility.value)}
            {metrics.visibility.value !== null && (
              <span className="metric-unit">%</span>
            )}
          </div>
          <div className="metric-footer">
            {delta !== null ? (
              <>
                <span
                  className="metric-delta"
                  style={
                    delta < 0
                      ? { color: '#c48090', background: '#fff2f5' }
                      : undefined
                  }
                >
                  {delta < 0 ? (
                    <ArrowDownRight size={10} />
                  ) : (
                    <ArrowUpRight size={10} />
                  )}
                  {Math.abs(delta).toFixed(1)} pp
                </span>
                <span>{comparison.comparableCount} matched prompts</span>
              </>
            ) : (
              <span>
                {metrics.visibility.numerator} of{' '}
                {metrics.visibility.denominator} analyzed answers
              </span>
            )}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            Average rank{' '}
            <CircleHelp size={11}>
              <title>
                Average position among companies in order of appearance,
                matching iGEO. Older scans retain their original rank method.
              </title>
            </CircleHelp>
            <span className="metric-icon">
              <Hash size={17} />
            </span>
          </div>
          <div className="metric-value">
            {metrics.averageRank.value !== null && (
              <span className="metric-unit" style={{ marginRight: 3 }}>
                #
              </span>
            )}
            {formatNumber(metrics.averageRank.value, 1)}
          </div>
          <div className="metric-footer">
            <span>Across {metrics.ranked} ranked answers</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            Brand mentions
            <span className="metric-icon">
              <MessageSquareText size={16} />
            </span>
          </div>
          <div className="metric-value">
            {formatNumber(metrics.mentioned)}
            <span className="metric-unit"> / {metrics.analyzed}</span>
          </div>
          <div className="metric-footer">
            <span>
              {metrics.analyzed} analyzed · {run.totalCount} scheduled
            </span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            Total citations
            <span className="metric-icon">
              <Link2 size={16} />
            </span>
          </div>
          <div className="metric-value">{formatNumber(metrics.citations)}</div>
          <div className="metric-footer">
            <span>
              {metrics.uniqueDomains} domains · {metrics.uniqueUrls} unique URLs
            </span>
          </div>
        </div>
      </div>
      <div className="chart-row">
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Visibility over time</h2>
              <p className="card-description">
                How often ChatGPT includes your brand in its answers
              </p>
            </div>
            <span className="small-select">Weekly</span>
          </div>
          <div className="card-content">
            <div className="legend">
              <span className="legend-item">
                <span className="legend-dot" />
                {run.snapshot.brand.name}
              </span>
              <span className="legend-item">
                <span className="legend-dot light" />
                Other configuration
              </span>
            </div>
            <TrendChart points={dashboard.trend} selected={run.id} />
            <div className="trend-note">
              <span>
                <TrendingUp size={11} />
                {comparison.comparableCount} matched prompts
              </span>
              <span>
                {comparison.reason ||
                  `${metrics.visibility.denominator} analyzed answers in this scan`}
              </span>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Brand sentiment</h2>
              <p className="card-description">
                The tone of answers mentioning your brand
              </p>
            </div>
            <span className="metric-icon">
              <Sparkles size={14} />
            </span>
          </div>
          <div className="card-content">
            <div className="donut-layout">
              <div className="donut">
                <svg
                  viewBox="0 0 160 160"
                  role="img"
                  aria-label={`Sentiment among ${metrics.mentioned} brand mentions`}
                >
                  <circle
                    cx="80"
                    cy="80"
                    r="65"
                    fill="none"
                    stroke="#f3eff8"
                    strokeWidth="15"
                  />
                  {mentionedSentiment.map(([name, count], index) => {
                    const circumference = 2 * Math.PI * 65,
                      length = metrics.mentioned
                        ? (count / metrics.mentioned) * circumference
                        : 0;
                    const offset =
                      (mentionedSentiment
                        .slice(0, index)
                        .reduce((sum, [, value]) => sum + value, 0) /
                        (metrics.mentioned || 1)) *
                      circumference;
                    return (
                      <circle
                        key={name}
                        cx="80"
                        cy="80"
                        r="65"
                        fill="none"
                        stroke={sentimentColors[name]}
                        strokeWidth="15"
                        strokeDasharray={`${Math.max(0, length - (count ? 3 : 0))} ${circumference}`}
                        strokeDashoffset={-offset}
                      >
                        <title>
                          {name}: {count}
                        </title>
                      </circle>
                    );
                  })}
                </svg>
                <div className="donut-center">
                  <strong>
                    {formatNumber(metrics.sentimentScore?.value ?? null)}
                  </strong>
                  <small>Sentiment score / 100</small>
                </div>
              </div>
              <div className="sentiment-list">
                {mentionedSentiment.map(([name, count]) => (
                  <div className="sentiment-item" key={name}>
                    <span
                      className="swatch"
                      style={{ background: sentimentColors[name] }}
                    />
                    <span>{name[0].toUpperCase() + name.slice(1)}</span>
                    <strong>{count}</strong>
                  </div>
                ))}
              </div>
              <p className="sentiment-note">
                Based on {metrics.mentioned} brand mentions. Absent brands are
                excluded.
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="lower-row">
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Prompt insights</h2>
              <p className="card-description">
                A closer look at the latest answers
              </p>
            </div>
            <button className="button button-quiet" onClick={onMentions}>
              View all <ArrowUpRight size={13} />
            </button>
          </div>
          {recent.error && (
            <div className="card-content">
              <ErrorNotice error={recent.error} />
            </div>
          )}
          {!recent.data && recent.loading ? (
            <Spinner label="Loading prompts…" />
          ) : !recent.data?.items.length ? (
            <Empty
              title="No answers yet"
              description="Answers will appear as the scan progresses."
            />
          ) : (
            <div className="table-scroll dashboard-table">
              <table>
                <thead>
                  <tr>
                    <th>Prompt</th>
                    <th>Rank</th>
                    <th>Sentiment</th>
                    <th>
                      <span className="visually-hidden">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recent.data.items.slice(0, 5).map((result) => (
                    <tr key={result.responseId}>
                      <td className="prompt-cell">
                        <button
                          className="row-button"
                          onClick={() => onResponse(result.responseId)}
                        >
                          <span>
                            <span className="prompt-name">
                              {result.prompt.text}
                            </span>
                            <span className="prompt-category">
                              {result.prompt.branded ? 'Branded' : 'Discovery'}{' '}
                              prompt
                            </span>
                          </span>
                        </button>
                      </td>
                      <td>
                        <span className="rank">
                          {brandRank(result.target) != null
                            ? `#${brandRank(result.target)}`
                            : '—'}
                        </span>
                      </td>
                      <td>
                        {result.status === 'succeeded' ? (
                          <SentimentScore brand={result.target} />
                        ) : (
                          <Badge value={result.status} />
                        )}
                      </td>
                      <td>
                        <button
                          className="table-link"
                          onClick={() => onResponse(result.responseId)}
                          aria-label={`Read answer to ${result.prompt.text}`}
                        >
                          <ArrowUpRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="card-footer">
            <span>{run.totalCount} prompts monitored every week</span>
          </div>
        </section>
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Most cited sources</h2>
              <p className="card-description">
                The domains shaping your brand's answers
              </p>
            </div>
            <button className="button button-quiet" onClick={onSources}>
              View all <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="card-content">
            {dashboard.topSources.length ? (
              dashboard.topSources
                .slice(0, 5)
                .map((source, index) => (
                  <SourcePreview
                    key={source.id}
                    source={source}
                    index={index}
                    onClick={onSources}
                  />
                ))
            ) : (
              <Empty
                title="No citations captured"
                description="This scan has no API-returned citations yet."
              />
            )}
          </div>
          <button
            className="card-footer"
            style={{ width: '100%' }}
            onClick={onSources}
          >
            Explore all sources <ArrowRight size={12} />
          </button>
        </section>
      </div>
    </>
  );
}

function SourcePreview({
  source,
  index,
  onClick,
}: {
  source: SourceRow;
  index: number;
  onClick: () => void;
}) {
  return (
    <button
      className="source-row"
      style={{ width: '100%', textAlign: 'left' }}
      onClick={onClick}
    >
      <span
        className="domain-icon"
        style={{
          background: ['#f6f0fb', '#eff7f4', '#fff4f0', '#f1f3fa', '#faf5eb'][
            index % 5
          ],
        }}
      >
        {source.domain[0].toUpperCase()}
      </span>
      <span className="domain-info">
        <span className="domain-name">{source.domain}</span>
        <span className="domain-meta">
          {source.uniqueUrlCount} pages ·{' '}
          {source.owned ? 'Your domain' : 'Third-party source'}
        </span>
      </span>
      <span className="coverage-bar">
        <span style={{ width: `${source.coverage || 0}%` }} />
      </span>
      <span className="source-count">{percent(source.coverage)}</span>
    </button>
  );
}

function TrendChart({
  points,
  selected,
}: {
  points: TrendPoint[];
  selected: string;
}) {
  const ordered = [...points]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-8);
  if (!ordered.length)
    return (
      <Empty
        title="Your trend starts with this scan"
        description="Weekly scans will build a clearer picture of your visibility."
      />
    );
  const width = 570,
    height = 195,
    left = 31,
    right = 11,
    top = 12,
    bottom = 29;
  const x = (index: number) =>
    left +
    (ordered.length === 1 ? 0.5 : index / (ordered.length - 1)) *
      (width - left - right);
  const y = (value: number) =>
    top + ((100 - value) / 100) * (height - top - bottom);
  const segments: string[] = [];
  let segment = '';
  ordered.forEach((point, index) => {
    if (
      point.visibility === null ||
      (!point.comparable && point.runId !== selected)
    ) {
      if (segment) segments.push(segment);
      segment = '';
      return;
    }
    segment += `${segment ? ' L' : 'M'}${x(index)},${y(point.visibility)}`;
  });
  if (segment) segments.push(segment);
  return (
    <div className="chart-wrap">
      <svg
        className="trend-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Weekly brand visibility, as a percentage of successfully analyzed answers"
      >
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bdd" stopOpacity=".18" />
            <stop offset="100%" stopColor="#a78bdd" stopOpacity=".01" />
          </linearGradient>
        </defs>
        {[0, 25, 50, 75, 100].map((value) => (
          <g key={value}>
            <line
              className="gridline"
              x1={left}
              y1={y(value)}
              x2={width - right}
              y2={y(value)}
            />
            <text x={left - 10} y={y(value) + 3} textAnchor="end">
              {value}%
            </text>
          </g>
        ))}
        {segments.map((line, index) => (
          <path
            key={index}
            d={line}
            stroke="#a38ad2"
            fill="none"
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {ordered.map((point, index) => (
          <g key={point.runId}>
            <text x={x(index)} y={height - 5} textAnchor="middle">
              {formatDate(point.date)}
            </text>
            {point.visibility !== null && (
              <circle
                cx={x(index)}
                cy={y(point.visibility)}
                r={point.runId === selected ? 5 : 3.2}
                fill={
                  point.comparable || point.runId === selected
                    ? '#a38ad2'
                    : '#d8cfdf'
                }
                stroke="white"
                strokeWidth="2"
              >
                <title>
                  {formatDate(point.date)}: {percent(point.visibility)} ·{' '}
                  {point.analyzed}/{point.total} analyzed
                  {point.comparable ? '' : ' · Different configuration'}
                </title>
              </circle>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
