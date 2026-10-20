import type { AccountOnboardingInput } from '@citevia/core';
import { onboardingInputSchema } from '@citevia/core';
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
export function parseAccountImport(source: string): AccountOnboardingInput[] {
  let values: unknown[];
  if (source.trim().startsWith('[')) {
    const parsed = JSON.parse(source);
    if (!Array.isArray(parsed)) throw new Error('Supply an array of accounts.');
    values = parsed;
  } else {
    const [headers, ...rows] = csvRows(source);
    if (!headers) throw new Error('The import is empty.');
    const keys = headers.map((value) => value.trim());
    const allowed = ['name', 'region', 'language', 'website'];
    if (
      keys.length !== 4 ||
      allowed.some((key) => !keys.includes(key)) ||
      new Set(keys).size !== keys.length
    )
      throw new Error(
        'CSV needs exactly four headers: name, region, language, website.',
      );
    values = rows.map((row) => {
      if (row.length > keys.length)
        throw new Error(
          'A CSV row has too many columns. Quote values containing commas.',
        );
      return Object.fromEntries(
        keys.map((key, index) => [key, (row[index] || '').trim()]),
      );
    });
  }
  if (!values.length || values.length > 25)
    throw new Error('Import 1–25 accounts per batch.');
  return values.map((value, index) => {
    const parsed = onboardingInputSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(
        `Account ${index + 1}: ${parsed.error.issues[0].path.join('.')} ${parsed.error.issues[0].message}`,
      );
    return parsed.data;
  });
}
