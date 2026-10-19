import { expect, it } from 'vitest';
import { csvRows, parseAccountImport } from './account-import';
const defaults = { country: 'US', language: 'en', timezone: 'UTC' };
it('imports quoted company names, descriptions and multiple categorized prompts', () => {
  const accounts = parseAccountImport(
    'name,website,description,trust,convert\r\n"Acme, Inc.",https://acme.com,"Says ""hello"".","Is Acme reliable?\nWhat evidence supports Acme?",How can I request a quote?',
    defaults,
  );
  expect(accounts[0]).toMatchObject({
    name: 'Acme, Inc.',
    description: 'Says "hello".',
    ...defaults,
  });
  expect(accounts[0].manualPrompts).toEqual([
    { text: 'Is Acme reliable?', stage: 'trust' },
    { text: 'What evidence supports Acme?', stage: 'trust' },
    { text: 'How can I request a quote?', stage: 'convert' },
  ]);
});
it('rejects broken or misleading imports and applies JSON defaults', () => {
  expect(() => csvRows('"unfinished')).toThrow();
  expect(() =>
    parseAccountImport('name,url\nAcme,https://acme.com', defaults),
  ).toThrow();
  expect(() =>
    parseAccountImport('name,website\nAcme,https://acme.com,extra', defaults),
  ).toThrow();
  expect(
    parseAccountImport(
      '[{"name":"Acme","website":"https://acme.com"}]',
      defaults,
    )[0],
  ).toEqual({
    name: 'Acme',
    website: 'https://acme.com',
    description: '',
    manualPrompts: [],
    ...defaults,
  });
});
