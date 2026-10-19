import type { OnboardingInput } from '@citevia/core';
import { JOURNEY_STAGES, onboardingInputSchema } from '@citevia/core';
/** RFC 4180-style quoted cells, including commas, escaped quotes and embedded newlines. */
export function csvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const input = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += char;
      continue;
    }
    if (char === '"') {
      if (cell || closed)
        throw new Error('Unexpected quote in CSV. Quote the complete cell.');
      quoted = true;
      continue;
    }
    if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell);
      cell = '';
      closed = false;
      if (char !== ',') {
        if (row.some((value) => value.trim())) rows.push(row);
        row = [];
        if (char === '\r' && input[i + 1] === '\n') i++;
      }
      continue;
    }
    if (closed) {
      if (!/\s/.test(char))
        throw new Error('Unexpected text after a quoted CSV cell.');
      continue;
    }
    cell += char;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted cell.');
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}
export function parseAccountImport(
  source: string,
  defaults: Pick<OnboardingInput, 'country' | 'language' | 'timezone'>,
): OnboardingInput[] {
  let values: unknown[];
  if (source.trim().startsWith('[')) {
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) throw new Error('Supply an array of accounts.');
    values = parsed;
  } else {
    const [headers, ...rows] = csvRows(source);
    if (!headers) throw new Error('The import is empty.');
    const keys = headers.map((value) => value.trim());
    const allowed = [
      'name',
      'website',
      'description',
      'country',
      'language',
      'timezone',
      ...JOURNEY_STAGES,
    ];
    if (
      !keys.includes('name') ||
      !keys.includes('website') ||
      keys.some((key) => !allowed.includes(key)) ||
      new Set(keys).size !== keys.length
    )
      throw new Error(
        'CSV needs name and website headers. Optional headers: description, country, language, timezone, understand, prefer, trust, convert.',
      );
    values = rows.map((row) => {
      if (row.length > keys.length)
        throw new Error(
          'A CSV row has too many columns. Quote values containing commas.',
        );
      const record = Object.fromEntries(
        keys.map((key, index) => [key, (row[index] || '').trim()]),
      );
      return {
        name: record.name,
        website: record.website,
        description: record.description || '',
        country: record.country || defaults.country,
        language: record.language || defaults.language,
        timezone: record.timezone || defaults.timezone,
        manualPrompts: JOURNEY_STAGES.flatMap((stage) =>
          (record[stage] || '')
            .split(/\r?\n|\|/)
            .map((text) => text.trim())
            .filter(Boolean)
            .map((text) => ({ text, stage })),
        ),
      };
    });
  }
  if (!values.length || values.length > 25)
    throw new Error('Import 1–25 accounts per batch.');
  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Each account must be an object.');
    const parsed = onboardingInputSchema.safeParse({ ...defaults, ...value });
    if (!parsed.success)
      throw new Error(
        `Account ${index + 1}: ${parsed.error.issues[0].path.join('.')} ${parsed.error.issues[0].message}`,
      );
    return parsed.data;
  });
}
