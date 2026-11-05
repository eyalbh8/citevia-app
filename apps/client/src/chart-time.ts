import type { MonitoringPeriod } from '@citevia/core';

export function timeBuckets({ start, end, granularity }: MonitoringPeriod) {
  const hourly = granularity === 'hourly';
  const step = hourly ? 3_600_000 : 86_400_000;
  const first = Math.floor(Date.parse(start) / step);
  const last = Math.floor(Date.parse(end) / step);
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const iso = new Date((first + index) * step).toISOString();
    return hourly ? iso : iso.slice(0, 10);
  });
}

/** Choose equally spaced calendar buckets, always including both ends of the selected range. */
export function axisTickIndices(bucketCount: number, availableWidth: number, minSpacing = 80) {
  const count = Math.min(bucketCount, Math.max(2, 1 + Math.floor(availableWidth / minSpacing)));
  return Array.from({ length: count }, (_, index) =>
    Math.round(index * (bucketCount - 1) / Math.max(1, count - 1)),
  );
}
