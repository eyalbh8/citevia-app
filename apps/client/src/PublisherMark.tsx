import { normalizeDomain } from '@citevia/core';

// Small, local publication emblems for sources without a published favicon.
// Index both the drawing and its inks by hostname, so a publication keeps the
// same identity in the list, article drawer and dashboard, even offline.
const designs = [
  ['M5 23 12 8l4 8-3 7z', 'm15 23 6-13 6 13z'], // peaks
  ['M5 9c4-1 7 0 10 3v14c-3-3-6-4-10-3z', 'M17 12c3-3 6-4 10-3v14c-4-1-7 0-10 3z'], // open book
  ['M5 23h4V12H5zm7 0h4V8h-4zm7 0h4V5h-4z', 'M4 25h23v2H4z'], // index
  ['m16 4 10 11-9 13 2-13z', 'M16 4 6 15l11 13-4-13z'], // facets
  ['M5 22c0-8 6-15 16-16-1 9-8 16-16 16z', 'M12 25c1-6 6-11 15-11-2 8-7 12-15 11z'], // leaves
  ['M4 12 16 5l12 7zM6 24h20v3H6z', 'M8 14h3v8H8zm7 0h3v8h-3zm7 0h3v8h-3z'], // portico
  ['M4 20 12 9l5 5-4 5-1-2-5 6z', 'm14 2 12-16v8l-9 12z'], // ribbons
  ['m6 23 5-13 15-5-6 15z', 'm12 17 4 4 5-11z'], // compass
  ['M5 22V11l9 5V5l6 4v16z', 'm22 10 5 3v12h-5z'], // skyline
  ['M4 10h16l-3 4H7zm4 7h18l-3 4H11z', 'm6 24 3 3h11l2-3z'], // folio
] as const;
const palettes = [
  [205, 54], [166, 45], [232, 48], [326, 43], [18, 60], [144, 38], [257, 40], [190, 58],
] as const;

export default function PublisherMark({ domain }: { domain?: string | null }) {
  const host = normalizeDomain(domain || '') || 'publication';
  let hash = 2166136261;
  for (const char of host) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const [body, detail] = designs[hash % designs.length];
  const [base, saturation] = palettes[(hash >>> 10) % palettes.length];
  const hue = (base + (hash >>> 20) % 19) % 360;
  return <svg className="publisher-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="6" fill={`hsl(${hue},${saturation}%,29%)`} />
    <path d={body} fill="#fff" />
    <path d={detail} fill={`hsl(${(hue + 30) % 360},65%,76%)`} />
  </svg>;
}
