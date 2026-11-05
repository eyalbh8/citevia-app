import { publicSourceUrl } from '@citevia/core';
import { Skeleton } from './Loading';
import {
  PROVIDER_LABELS,
  snapshotProvider,
  brandRank,
  reportingCompanies,
} from '@citevia/core';
import { SentimentScore } from './ScoreBadge';
import AnswerMarkdown from './AnswerMarkdown';
import { isReportTextBoundary, reportExcerpt, reportExcerptParts } from './report-excerpt';
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

// Parse provider suggestion cards in an inert template. Their search links still
// point to the provider’s original destination, including any search query.
function searchSuggestionsExcerpt(html: string): string {
  if (typeof document === 'undefined') return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  let inline: Node[] = [];
  function flush() {
    const values = inline.map(node => node.textContent || '');
    const excerpts = reportExcerptParts(values);
    if (values !== excerpts) inline.forEach((node, index) => { node.textContent = excerpts[index]; });
    inline = [];
  }
  function visit(node: Node) {
    const tag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName.toLowerCase() : '';
    if (tag === 'script' || tag === 'style') return;
    if (isReportTextBoundary(tag)) flush();
    if (node.nodeType === Node.TEXT_NODE) inline.push(node);
    node.childNodes.forEach(visit);
    if (isReportTextBoundary(tag)) flush();
  }
  visit(template.content);
  flush();
  for (const element of template.content.querySelectorAll('[title], [alt], [aria-label]')) {
    for (const attr of ['title', 'alt', 'aria-label']) {
      const label = element.getAttribute(attr);
      if (label) element.setAttribute(attr, reportExcerpt(label));
    }
  }
  for (const element of template.content.querySelectorAll('[href], [src]')) {
    for (const attr of ['href', 'src']) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const safe = publicSourceUrl(value);
      if (safe) element.setAttribute(attr, safe); else element.removeAttribute(attr);
    }
  }
  return template.innerHTML;
}

export default function ResponseDrawer({
  path,
  id,
  onClose,
}: {
  path: string;
  id: string;
  onClose: () => void;
}) {
  const { data, error, loading } = useApi<ResponseDetail>(
    `${path}/responses/${encodeURIComponent(id)}`,
  );
  return (
    <Drawer title="Answer details" onClose={onClose}>
      <ErrorNotice error={error} />
      {loading && !data ? (
        <Skeleton variant="detail" rows={3} label="Opening the answer…" />
      ) : (
        data && <ResponseDetailContent data={data} />
      )}
    </Drawer>
  );
}

export function ResponseDetailContent({ data }: { data: ResponseDetail }) {
  const { result, answer, run } = data;
  const metadata = answer?.raw;
  const generated = typeof metadata === 'object' && metadata !== null &&
    (('illustrative' in metadata && metadata.illustrative === true) || ('demo' in metadata && metadata.demo === true));
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
      <p className="drawer-prompt">{reportExcerpt(result.prompt.text)}</p>
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
        <ErrorNotice error={`${result.error.code}: ${reportExcerpt(result.error.message)}`} />
      )}
      {answer ? (
        <>
          <AnswerMarkdown text={answer.text || ''} aliases={aliases} renderReport={(content, omitted) => <>
            <h3 className="drawer-section-title">
              <MessageSquareText size={14} />
              {omitted || ('isExcerpt' in answer && answer.isExcerpt === true) ? 'Answer excerpt' : generated ? 'Answer' : 'Original answer'}{' '}
              <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 400 }}>{reportExcerpt(answer.model)}</span>
            </h3>
            {answer.refusal && <ErrorNotice error={reportExcerpt(answer.refusal)} />}
            <div className="answer-block" dir="auto">
              {answer.text ? content : 'No answer text was returned.'}
            </div>
          </>} />
          {target?.sentimentEvidence && (
            <>
              <h3 className="drawer-section-title">
                <Quote size={14} />
                Sentiment evidence
              </h3>
              <blockquote className="evidence">
                {reportExcerpt(target.sentimentEvidence.quote)}
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
                {reportExcerpt(target.rankEvidence.quote)}
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
                    {reportExcerpt(company.company)}
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
                    <DomainLogo publisher domain={citation.url} />
                    <span className="citation-number">{index + 1}</span>
                  </span>
                  <div>
                    <ExternalLink url={citation.url}>
                      {reportExcerpt(citation.title || citation.url)}
                    </ExternalLink>
                    <small>{reportExcerpt(citation.url)}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="sentiment-note">
              {generated
                ? 'This answer has no citations.'
                : 'The API did not return citation annotations for this answer.'}
            </p>
          )}
          <h3 className="drawer-section-title">
            <Search size={14} />
            Retrieved sources{' '}
            <span className="tag">{answer.sources.length}</span>
          </h3>
          <p className="card-description">
            {generated
              ? 'Sources associated with this answer.'
              : 'Search sources returned by the API. Retrieval does not imply a citation in the answer.'}
          </p>
          {answer.sources.length ? (
            <div className="citation-list">
              {answer.sources.map((source, index) => (
                <div className="citation" key={source.url + index}>
                  <DomainLogo publisher domain={source.url} />
                  <div>
                    <ExternalLink url={source.url}>
                      {reportExcerpt(source.title || source.url)}
                    </ExternalLink>
                    <small>{reportExcerpt(source.url)}</small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="sentiment-note">
              No retrieved sources are available.
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
                searchSuggestionsExcerpt(html)
              }
              style={{ border: 0, width: '100%', minHeight: 120 }}
            />
          ))}
          {!generated && <div className="setting-note" style={{ marginTop: 25 }}>
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
          </div>}
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
