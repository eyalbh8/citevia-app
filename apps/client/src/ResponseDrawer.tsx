import { Skeleton } from './Loading';
import {
  PROVIDER_LABELS,
  snapshotProvider,
  brandRank,
  reportingCompanies,
} from '@citevia/core';
import { SentimentScore } from './ScoreBadge';
import AnswerMarkdown from './AnswerMarkdown';
import DomainLogo from './DomainLogo';
import {
  ExternalLink as LinkIcon,
  Info,
  MessageSquareText,
  Quote,
  Search,
} from 'lucide-react';
import type { ResponseDetail } from '@citevia/core';
import { useApi } from './api';
import {
  Badge,
  Drawer,
  Empty,
  ErrorNotice,
  ExternalLink,
  formatDate,
} from './components';

export default function ResponseDrawer({
  path,
  id,
  onClose,
  revision,
}: {
  path: string;
  id: string;
  onClose: () => void;
  revision: number;
}) {
  const { data, error, loading } = useApi<ResponseDetail>(
    `${path}/responses/${encodeURIComponent(id)}`,
    revision,
  );
  return (
    <Drawer title="Answer details" onClose={onClose}>
      <ErrorNotice error={error} />
      {loading && !data ? (
        <Skeleton variant="detail" rows={3} label="Opening the original answer…" />
      ) : (
        data && <ResponseDetailContent data={data} />
      )}
    </Drawer>
  );
}

export function ResponseDetailContent({ data }: { data: ResponseDetail }) {
  const { result, answer, run } = data;
  const target =
    data.analysis?.brands.find(
      (brand) => brand.brandId === run.snapshot.brand.id,
    ) || result.target;
  const aliases = [run.snapshot.brand.name, ...run.snapshot.brand.aliases];
  return (
    <>
      <div className="eyebrow">
        {formatDate(result.capturedAt || run.createdAt, true)} ·{' '}
        {result.prompt.branded ? 'Branded' : 'Discovery'} prompt
      </div>
      <p className="drawer-prompt">{result.prompt.text}</p>
      <div style={{ marginBottom: 18 }}>
        <Badge value={result.status} />
      </div>
      <div className="drawer-metrics">
        <div>
          <small>Brand visibility</small>
          <strong>
            {target
              ? target.mentioned
                ? 'Mentioned'
                : 'Not mentioned'
              : 'Pending analysis'}
          </strong>
        </div>
        <div>
          <small>Rank among companies</small>
          <strong>
            {brandRank(target) != null ? `#${brandRank(target)}` : '—'}
          </strong>
        </div>
        <div>
          <small>Explicit rank</small>
          <strong>
            {target?.explicitRank ? `#${target.explicitRank}` : 'Not ranked'}
          </strong>
        </div>
        <div>
          <small>First-mention order</small>
          <strong>
            {target?.mentionOrder ? `#${target.mentionOrder}` : '—'}
          </strong>
        </div>
        <div>
          <small>Sentiment</small>
          <SentimentScore brand={target} />
        </div>
      </div>
      {result.error && (
        <ErrorNotice error={`${result.error.code}: ${result.error.message}`} />
      )}
      {answer ? (
        <>
          <h3 className="drawer-section-title">
            <MessageSquareText size={14} />
            Original answer{' '}
            <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 400 }}>
              {answer.model}
            </span>
          </h3>
          {answer.refusal && <ErrorNotice error={answer.refusal} />}
          <div className="answer-block" dir="auto">
            {answer.text ? (
              <AnswerMarkdown text={answer.text} aliases={aliases} />
            ) : (
              'No answer text was returned.'
            )}
          </div>
          {target?.sentimentEvidence && (
            <>
              <h3 className="drawer-section-title">
                <Quote size={14} />
                Sentiment evidence
              </h3>
              <blockquote className="evidence">
                {target.sentimentEvidence.quote}
              </blockquote>
            </>
          )}
          {target?.rankEvidence && (
            <>
              <h3 className="drawer-section-title">
                <Quote size={14} />
                Rank evidence
              </h3>
              <blockquote className="evidence">
                {target.rankEvidence.quote}
              </blockquote>
            </>
          )}
          {data.analysis && (
            <div style={{ marginBottom: 20 }}>
              <h3 className="drawer-section-title">
                Companies in order of appearance
              </h3>
              {reportingCompanies(data.analysis, run.snapshot, answer).map(
                (company) => (
                  <p className="card-description" key={company.company}>
                    {company.rank === null ? 'Unranked' : `#${company.rank}`} ·{' '}
                    {company.company}
                    {company.sentimentScore !== null && (
                      <> · Sentiment {company.sentimentScore}/100</>
                    )}
                  </p>
                ),
              )}
            </div>
          )}
          <h3 className="drawer-section-title">
            <LinkIcon size={14} />
            Citations in this answer{' '}
            <span className="tag">{answer.citations.length}</span>
          </h3>
          {answer.citations.length ? (
            <div className="citation-list">
              {answer.citations.map((citation, index) => (
                <div className="citation" key={citation.id + index}>
                  <span className="citation-logo-stack">
                    <DomainLogo domain={citation.url} />
                    <span className="citation-number">{index + 1}</span>
                  </span>
                  <div>
                    <ExternalLink url={citation.url}>
                      {citation.title || citation.url}
                    </ExternalLink>
                    <small>{citation.url}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="sentiment-note">
              The API did not return citation annotations for this answer.
            </p>
          )}
          <h3 className="drawer-section-title">
            <Search size={14} />
            Retrieved sources{' '}
            <span className="tag">{answer.sources.length}</span>
          </h3>
          <p className="card-description">
            Search sources returned by the API. Retrieval does not imply a
            citation in the answer.
          </p>
          {answer.sources.length ? (
            <div className="citation-list">
              {answer.sources.map((source, index) => (
                <div className="citation" key={source.url + index}>
                  <DomainLogo domain={source.url} />
                  <div>
                    <ExternalLink url={source.url}>
                      {source.title || source.url}
                    </ExternalLink>
                    <small>{source.url}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="sentiment-note">
              No retrieved-source list was returned.
            </p>
          )}
          {answer.searchSuggestions?.map((html, index) => (
            <iframe
              key={index}
              title="Google Search suggestions"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="no-referrer"
              srcDoc={
                '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;; img-src https:; base-uri &apos;none&apos;">' +
                html
              }
              style={{ border: 0, width: '100%', minHeight: 120 }}
            />
          ))}
          <div className="setting-note" style={{ marginTop: 25 }}>
            <Info size={14} />
            <span>
              Captured from the{' '}
              {PROVIDER_LABELS[snapshotProvider(run.snapshot)]} API. Rank and
              sentiment are analyzed with OpenAI. Highlighting is for
              navigation; rank and sentiment come from validated evidence. This
              answer is preserved with its original scan configuration.
              {run.reanalysisOf &&
                ' This report reanalyzes saved answers from an earlier scan; no new collection calls were made.'}
            </span>
          </div>
        </>
      ) : (
        <Empty
          title="No answer captured yet"
          description={
            ['failed_collection', 'refused', 'incomplete'].includes(
              result.status,
            )
              ? 'The collection did not return a complete answer. The scan status and error above explain what happened.'
              : 'This prompt is waiting for collection. The details update as the scan progresses.'
          }
        />
      )}
    </>
  );
}
