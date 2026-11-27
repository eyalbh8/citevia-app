import { describe, expect, it } from 'vitest';
import { buyerSearchIssues, validateBuyerSearches } from '../apps/scanner/src/onboarding-prompt-quality.js';

const brand = { name: 'E2 Visas USA', aliases: [], domains: ['example.test'] };
const check = (strings: string[], locale: string) =>
  validateBuyerSearches(strings.map(text => ({ text, branded: text.includes(brand.name) })), locale, brand);

describe('generated buyer search quality', () => {
  it('distinguishes requests for names from educational definitions and checklists', () => {
    for (const text of ['מה זה ויזת E2?', 'אילו מסמכים נדרשים לרכישת עסק?', 'איך בוחרים משרד לעריכת צוואה?', 'אילו שירותים עוזרים למשקיע לבחון מסמכים?', 'איזה שירותים מוצעים למשפחות משקיעים?'])
      expect(() => check([text], 'he-IL')).toThrowError(expect.objectContaining({code: 'onboarding_generic_prompt'}));
    for (const text of ['What is a broker?', 'What are the requirements to trade?', 'How do I select a broker?', 'What kinds of services are available to small investors?'])
      expect(() => check([text], 'en')).toThrowError(expect.objectContaining({code: 'onboarding_generic_prompt'}));
    expect(() => check(['Who can prepare the documents?', 'What are three firms serving new investors?', 'Where can I book advice?'], 'en')).not.toThrow();
    expect(() => check(['מה מציע משרד E2 Visas USA למשקיעים?', 'אצל מי אפשר לקבוע פגישת ייעוץ דחופה?', 'חברות מומלצות לליווי בקניית עסק', 'אילו משרדים מציעים שירותי בדיקת מסמכים?'], 'he-IL')).not.toThrow();
  });

  it('accepts natural repeated openings when the buyer decision changes', () => {
    const needs = ['copy trading', 'low fees', 'ISA transfers', 'overnight costs', 'beginner practice', 'stock transfers',
      'trading oil', 'market orders', 'fractional shares', 'GBP deposits', 'dollar accounts', 'paper trading'];
    expect(() => check(needs.map(need => 'Which UK brokers offer ' + need + '?'), 'en-GB')).not.toThrow();
    expect(() => check(['אילו חברות מציעות תוכנה?', 'אילו חברות מציעות הדרכה?'], 'he')).not.toThrow();
    expect(() => check(['おすすめの証券会社は？', 'おすすめの投資信託は？'], 'ja')).not.toThrow();
  });

  it('reports wording and language failures together in a ten-row preview', () => {
    const english = ['Which banks offer an ISA?', 'Where can I buy shares?', 'Best trading apps',
      'Who offers gold CFDs?', 'Can I trade oil futures?', 'How do I contact a broker?',
      'Which fund has the lowest fees?', 'How much is a broker account?', 'Should I choose a local bank?'];
    const inputs = [...english, '¿Qué es un bróker?'].map(text => ({text, branded: false}));
    const issues = buyerSearchIssues(inputs, 'es-MX', brand);
    expect(issues).toHaveLength(10);
    expect(issues.slice(0, 9).every(issue => issue.code === 'onboarding_prompt_language')).toBe(true);
    expect(() => validateBuyerSearches(inputs, 'es-MX', brand)).toThrowError(expect.objectContaining({
      rowIndices: Array.from({length: 10}, (_, i) => i),
      message: expect.stringContaining('Row 10:'),
    }));
    expect(() => check(['mejor shortlist de corredores internacionales'], 'es-MX')).toThrowError(expect.objectContaining({code: 'onboarding_prompt_wording'}));
    expect(() => check(['¿Qué plataformas ofrecen copy trading?', '¿Qué bróker es mejor para México, Norte o Banco Pino?',
      'Brókers con cuentas demo', '¿Dónde puedo comprar acciones desde México?'], 'es-MX')).not.toThrow();
    expect(() => check(['¿Qué brokers cobran menos por retiro?'], 'en-GB')).toThrowError(expect.objectContaining({code: 'onboarding_prompt_language'}));
  });

  it('allows feature combinations and detects independent questions in one sentence', () => {
    for (const [locale, text] of [
      ['en-GB', 'Which investing app is cheapest and how do I file my taxes?'],
      ['en-GB', 'Which broker should I choose and what documents do I need?'],
      ['es-MX', '¿Qué bróker cobra menos y cuánto tarda el retiro?'],
      ['he-IL', 'איפה קונים מניות ואיך פותחים חשבון?'],
    ]) {
      expect(() => check([text], locale)).toThrowError(expect.objectContaining({code: 'onboarding_multiple_decisions'}));
    }
    for (const [locale, text] of [
      ['en-GB', 'Which UK apps sell stocks and crypto?'],
      ['en-GB', 'Which platforms show holdings and how they change over time?'],
      ['es-MX', '¿Qué banco ofrece cuentas en dólares y pesos?'],
      ['he-IL', 'אילו אפליקציות מציעות מניות וקריפטו?'],
    ]) expect(() => check([text], locale)).not.toThrow();
  });

  it('finds conservative rewordings and keeps distinct rivals, criteria and transfer directions', () => {
    const olmo = { name: 'Olmo Capital', aliases: ['Olmo'], domains: ['olmo.example'] };
    const peers = [{name: 'Banco Pino', aliases: [], domains: []}, {name: 'Roble.example', aliases: [], domains: []}];
    const searches = [
      'Which UK brokers offer demo accounts?', 'Recommend UK brokers with demo accounts',
      'Which UK brokers offer margin accounts?', 'Compare Olmo Capital vs Banco Pino on fees',
      'Compare Olmo Capital vs Roble.example on fees', 'Compare Olmo vs Banco Pino on fees',
      'Which banks convert GBP to USD?', 'Which banks convert USD to GBP?',
      'Which UK brokers have the lowest FX fees?', 'UK brokers with the lowest FX fees',
    ].map(text => ({text, branded: text.includes('Olmo')}));
    expect(buyerSearchIssues(searches, 'en-GB', olmo, peers).map(({index, code}) => ({index, code})))
      .toEqual([{index: 1, code: 'onboarding_duplicate_decision'}, {index: 5, code: 'onboarding_duplicate_decision'},
        {index: 9, code: 'onboarding_duplicate_decision'}]);
  });

  it('requires local-language wording around foreign names and handles mixed scripts', () => {
    expect(() => check(['Who compares E2 Visas USA with specialist firms?'], 'he-IL')).toThrowError(expect.objectContaining({code: 'onboarding_prompt_language'}));
    expect(() => check(['מחפש חברה עם מומחיות E2'], 'en-US')).toThrowError(expect.objectContaining({code: 'onboarding_prompt_language'}));
    expect(() => check(['איפה מזמינים פגישה עם E2 Visas USA?'], 'he-IL')).not.toThrow();
    expect(() => check(['法人向けの販売会社を比較したい'], 'ja')).not.toThrow();
    expect(() => check(['من يقدم استشارات للشركات؟'], 'ar')).not.toThrow();
  });
});
