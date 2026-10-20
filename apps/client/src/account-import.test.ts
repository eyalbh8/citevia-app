import { expect, it } from 'vitest';
import { csvRows, parseAccountImport } from './account-import';
it('imports only the four onboarding fields and supports quoted names and URLs', () => {
  const accounts = parseAccountImport(
    'name,region,language,website\r\n"Acme, Inc.",us,en,https://acme.com',
  );
  expect(accounts).toEqual([
    {
      name: 'Acme, Inc.',
      region: 'US',
      language: 'en',
      website: 'https://acme.com',
    },
  ]);
  expect(
    parseAccountImport(
      '[{"name":"Acme","region":"GB","language":"en-GB","website":"https://acme.com"}]',
    )[0].region,
  ).toBe('GB');
});
it('rejects incomplete, obsolete or misleading imports instead of inventing region or language defaults', () => {
  expect(() => csvRows('"unfinished')).toThrow();
  for (const csv of [
    'name,website\nAcme,https://acme.com',
    'name,region,language,url\nAcme,US,en,https://acme.com',
    'name,region,language,website\nAcme,US,en,https://acme.com,extra',
    'name,region,language,website,description\nAcme,US,en,https://acme.com,Notes',
    'name,region,language,website\nAcme,,en,https://acme.com',
  ])
    expect(() => parseAccountImport(csv)).toThrow();
  expect(() =>
    parseAccountImport('[{"name":"Acme","website":"https://acme.com"}]'),
  ).toThrow();
  expect(() =>
    parseAccountImport(
      JSON.stringify([
        {
          name: 'Acme',
          region: 'US',
          language: 'en',
          website: 'https://acme.com',
          manualPrompts: [],
        },
      ]),
    ),
  ).toThrow();
  expect(() =>
    parseAccountImport(
      JSON.stringify(
        Array.from({ length: 26 }, () => ({
          name: 'Acme',
          region: 'US',
          language: 'en',
          website: 'https://acme.com',
        })),
      ),
    ),
  ).toThrow();
});
