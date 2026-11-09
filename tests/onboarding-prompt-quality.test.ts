import { describe, expect, it } from 'vitest';
import { validateBuyerSearches } from '../apps/scanner/src/onboarding-prompt-quality.js';

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

  it('detects repeated Hebrew and Japanese openings even when complete questions are unique', () => {
    const hebrew = Array.from({length: 20}, (_, i) => (i % 2 ? 'מאילו משרדים כדאי להזמין ' : 'אילו חברות מציעות ') + 'שירות ' + i);
    expect(() => check(hebrew, 'he-IL')).toThrowError(expect.objectContaining({code: 'onboarding_repetitive_openings'}));
    expect(() => check(Array.from({length: 20}, (_, i) => 'おすすめの投資会社を教えて' + i), 'ja')).toThrowError(expect.objectContaining({code: 'onboarding_repetitive_openings'}));
  });

  it('requires local-language wording around foreign names and handles mixed scripts', () => {
    expect(() => check(['Who compares E2 Visas USA with specialist firms?'], 'he-IL')).toThrowError(expect.objectContaining({code: 'onboarding_prompt_language'}));
    expect(() => check(['מחפש חברה עם מומחיות E2'], 'en-US')).toThrowError(expect.objectContaining({code: 'onboarding_prompt_language'}));
    expect(() => check(['איפה מזמינים פגישה עם E2 Visas USA?'], 'he-IL')).not.toThrow();
    expect(() => check(['法人向けの販売会社を比較したい'], 'ja')).not.toThrow();
    expect(() => check(['من يقدم استشارات للشركات؟'], 'ar')).not.toThrow();
  });
});
