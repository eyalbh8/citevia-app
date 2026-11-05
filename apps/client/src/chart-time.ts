/** Choose equally spaced calendar buckets, always including both ends of the selected range. */
export function axisTickIndices(bucketCount: number, availableWidth: number, minSpacing = 80) {
  const count = Math.min(bucketCount, Math.max(2, 1 + Math.floor(availableWidth / minSpacing)));
  return Array.from({ length: count }, (_, index) =>
    Math.round(index * (bucketCount - 1) / Math.max(1, count - 1)),
  );
}
