import { brandSentimentScore, type BrandAnalysis } from '@citevia/core';
import { Badge } from './components';

export function SentimentScore({ brand }: { brand?: BrandAnalysis }) {
  const score = brandSentimentScore(brand);
  return score === null ? (
    <>—</>
  ) : (
    <span title={`${brand!.sentiment}: ${score} out of 100`}>
      <Badge value={brand!.sentiment} label={`${score} / 100`} />
    </span>
  );
}
export function MetricChange({ value }: { value?: number | null }) {
  if (value == null) return null;
  return (
    <small
      className={`prompt-measurement-note metric-change ${value > 0 ? 'improved' : value < 0 ? 'declined' : ''}`}
      title="Change from the previous comparable scan"
    >
      {value > 0 ? '+' : ''}
      {value}%
    </small>
  );
}
