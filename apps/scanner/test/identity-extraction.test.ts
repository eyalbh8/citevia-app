import { describe, expect, it } from 'vitest';
import {
  IDENTITY_PARSER_VERSION,
  type CapturedAnswer,
  type Citation,
} from '@citevia/core';
import {
  identityExtractionRequest,
  parseIdentityExtraction,
} from '../src/identity-extraction.js';
import { geminiAnalysisBody } from '../src/gemini-analysis.js';
import { captured, instant, snapshot } from './fixtures.js';

const selected = {
  ...snapshot,
  analysisPromptId: 'prompt-1',
  parserVersion: IDENTITY_PARSER_VERSION,
};
const empty = {
  decision: 'absent',
  nameId: null,
  discussionId: null,
  citationIds: [] as number[],
  sentiment: 'unknown',
  sentimentId: null,
  explicitRank: null,
  rankId: null,
};
const decision = (id: string, changes: Record<string, unknown> = {}) => ({
  id,
  ...empty,
  ...changes,
});
const confirmed = (id: string, nameId: number, discussionId = nameId) =>
  decision(id, { decision: 'specific_discussion', nameId, discussionId });
const from = (
  answer: CapturedAnswer,
  brands: unknown[],
  companies: unknown[] = [],
  context = selected,
) =>
  parseIdentityExtraction(
    {
      requestId: 'r',
      receivedAt: instant,
      response: {
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ brands, companies }),
              },
            ],
          },
        ],
      },
    },
    answer,
    context,
  );
const citation = (
  answer: CapturedAnswer,
  url: string,
  title: string,
  line: number,
): Citation => {
  const text = answer.text.split('\n')[line],
    start = answer.text.indexOf(text);
  return {
    id: 'c1',
    blockId: answer.blocks[0].id,
    url,
    title,
    start,
    end: start + text.length,
  };
};

describe('business identity scoring', () => {
  it('sends the selected prompt and attached citation pages with provider labels; omits other prompts and retrieved-only URLs', () => {
    const answer = captured('מידע כללי.\nחברת Acme מפעילה כאן שלושה סניפים.');
    answer.provider = 'gemini';
    answer.citations = [
      citation(
        answer,
        'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token',
        'acme.example',
        1,
      ),
    ];
    const request = identityExtractionRequest(answer, selected);
    expect(request.input).toMatchObject({
      question: selected.prompts[0].text,
      brands: [
        { id: 'acme', domains: ['acme.example'] },
        { id: 'bravo', domains: ['bravo.example'] },
      ],
      citations: [{ id: 0, page: 'acme.example', evidenceIds: [1] }],
    });
    const sent = JSON.stringify(geminiAnalysisBody(request));
    for (const omitted of [
      selected.prompts[1].text,
      'opaque-token',
      'other.example/research',
    ])
      expect(sent).not.toContain(omitted);
    expect(() =>
      identityExtractionRequest(answer, {
        ...selected,
        analysisPromptId: undefined,
      }),
    ).toThrow(/associated with/);
  });

  it('orders companies by the first accepted discussion and keeps the basis for negative text-only mentions', () => {
    const answer = captured(
      'Acme or Bravo?\nBravo provides daily exports.\nAcme repeatedly lost our uploaded reports.',
    );
    const result = from(answer, [
      decision('acme', {
        ...confirmed('acme', 2),
        sentiment: 'negative',
        sentimentId: 2,
      }),
      confirmed('bravo', 1),
    ]);
    expect(result.companies?.map((c) => [c.brandId, c.rank])).toEqual([
      ['bravo', 1],
      ['acme', 2],
    ]);
    expect(result.brands[0]).toMatchObject({
      mentioned: true,
      appearanceRank: 2,
      mentionOrder: 2,
      explicitRank: null,
      sentiment: 'negative',
      sentimentScore: 0,
      identity: {
        status: 'confirmed',
        evidence: [{ quote: 'Acme repeatedly lost our uploaded reports.' }],
      },
    });
  });

  it('leaves quoted questions and headings uncredited and rejects borrowing an adjacent competitor claim', () => {
    const answer = captured(
      selected.prompts[0].text + '\n## Acme\nBravo offers next-day repairs.',
    );
    for (const [nameId, discussionId] of [
      [1, 0],
      [1, 1],
      [1, 2],
    ]) {
      const result = from(answer, [
        confirmed('acme', nameId, discussionId),
        confirmed('bravo', 2),
      ]);
      expect(result.brands[0]).toMatchObject({
        mentioned: false,
        appearanceRank: null,
        sentimentScore: null,
        identity: { status: 'unresolved' },
      });
      expect(result.companies?.map((c) => c.name)).toEqual(['Bravo']);
    }
    const positive = captured(
      '## Acme\nIts support team offers a 24-hour repair guarantee.',
    );
    expect(
      from(positive, [confirmed('acme', 0, 1), decision('bravo')]).brands[0]
        .mentioned,
    ).toBe(true);
  });

  it('keeps source-only visibility separate and excludes the generic service and a declined identification', () => {
    const answer = captured('לא ניתן לזהות את Acme.\nאיך בוחרים את השירות?');
    answer.citations = [
      citation(answer, 'https://acme.example/guide', 'Acme guide', 1),
    ];
    for (const reason of [
      'cannot_identify',
      'generic_topic',
      'prompt_echo',
      'source_only',
    ]) {
      const result = from(answer, [
        decision('acme', {
          decision: reason,
          nameId: 0,
          discussionId: 1,
          citationIds: [0],
        }),
        decision('bravo'),
      ]);
      expect(result.brands[0]).toMatchObject({
        mentioned: false,
        evidence: [],
        appearanceRank: null,
        identity: { citationIds: ['c1'] },
      });
      expect(result.companies).toEqual([]);
      expect(answer.citations).toHaveLength(1);
    }
  });

  it('requires supporting citations to belong to the selected text when official ownership is claimed', () => {
    const answer = captured(
      'Acme offers legal support.\nAn unrelated paragraph cites a guide.',
    );
    answer.citations = [
      citation(answer, 'https://acme.example/guide', 'Guide', 1),
    ];
    const credit = () =>
      from(answer, [
        decision('acme', {
          decision: 'official_site',
          nameId: 0,
          discussionId: 0,
          citationIds: [0],
        }),
        decision('bravo'),
      ]).brands[0];
    expect(credit().mentioned).toBe(false);
    answer.citations = [
      citation(answer, 'https://press.example/article', 'acme.example', 0),
    ];
    expect(credit().mentioned).toBe(false);
    answer.citations = [
      citation(
        answer,
        'https://profile.acme.example/support',
        'Official support',
        0,
      ),
    ];
    expect(credit().identity).toMatchObject({
      status: 'confirmed',
      citationIds: ['c1'],
    });
    answer.citations = [
      citation(
        answer,
        'https://linkedin.com/company/acme',
        'Acme company profile',
        0,
      ),
    ];
    expect(
      from(answer, [
        decision('acme', {
          decision: 'independent_source',
          nameId: 0,
          discussionId: 0,
          citationIds: [0],
        }),
        decision('bravo'),
      ]).brands[0].mentioned,
    ).toBe(true);
  });

  it('preserves a discussed namesake as untracked, also when the analyzer overlooks the lookalike host', () => {
    const firm = {
      ...selected,
      brand: {
        id: 'acme',
        name: 'Visa Law',
        aliases: [],
        domains: ['visalaw.co.il'],
      },
    };
    const answer = captured(
      'Visa Law (Dotan Cohen) provides representation in Tel Aviv.',
    );
    answer.citations = [
      citation(answer, 'https://visa-law.co.il/attorneys', 'Dotan Cohen', 0),
    ];
    const actual = {
      name: 'Dotan Cohen',
      nameId: 0,
      discussionId: 0,
      sentiment: 'neutral',
      sentimentId: 0,
    };
    const wrong = from(
      answer,
      [confirmed('acme', 0), decision('bravo')],
      [actual],
      firm,
    );
    expect(wrong.brands[0].mentioned).toBe(false);
    const resolved = from(
      answer,
      [
        decision('acme', {
          decision: 'other_business',
          nameId: 0,
          discussionId: 0,
          citationIds: [0],
        }),
        decision('bravo'),
      ],
      [actual],
      firm,
    );
    expect(resolved.companies).toMatchObject([
      { name: 'Dotan Cohen', brandId: null, rank: 1 },
    ]);
    expect(resolved.brands[0].identity?.reason).toContain('different business');
  });

  it('uses an attached exact business profile if the official citation supports only a later passage', () => {
    const answer = captured(
      'Acme offers in-home repairs.\nAcme also sells replacement parts.',
    );
    const credit = () =>
      from(answer, [
        decision('acme', {
          decision: 'official_site',
          nameId: 0,
          discussionId: 0,
          citationIds: [0, 1],
        }),
        decision('bravo'),
      ]).brands[0];
    answer.citations = [
      {
        ...citation(
          answer,
          'https://www.linkedin.com/company/acme/',
          'Acme | LinkedIn',
          0,
        ),
        id: 'profile',
      },
      {
        ...citation(answer, 'https://acme.example/shop', 'Acme shop', 1),
        id: 'official',
      },
    ];
    expect(credit().identity).toMatchObject({
      status: 'confirmed',
      reason: expect.stringContaining('independent source'),
      citationIds: ['profile'],
    });
    for (const url of [
      'https://linkedin.com/company/acme-repairs',
      'https://linkedin.com.evil.test/company/acme',
      'https://linkedin.com/posts/company/acme',
    ]) {
      answer.citations[0].url = url;
      expect(credit().mentioned).toBe(false);
    }
  });

  it('retains a separately identified namesake when a model accidentally credits the tracked firm', () => {
    const answer = captured(
      '* **Visa Law (Smith & Partners):**\nIts downtown office provides legal consultations.\nBravo runs a referral line.',
    );
    const firm = {
      ...selected,
      brand: {
        id: 'acme',
        name: 'Visa Law',
        aliases: [],
        domains: ['visalaw.example'],
      },
    };
    answer.citations = [
      citation(answer, 'https://visa-law.example/team', 'Smith & Partners', 1),
    ];
    const credit = (additional: unknown[] = []) =>
      from(
        answer,
        [
          decision('acme', {
            decision: 'official_site',
            nameId: 0,
            discussionId: 1,
            citationIds: [0],
          }),
          confirmed('bravo', 2),
        ],
        additional,
        firm,
      );
    expect(credit().brands[0]).toMatchObject({
      mentioned: false,
      identity: { reason: expect.stringContaining('different business') },
    });
    expect(credit().companies?.map((c) => [c.name, c.brandId, c.rank])).toEqual(
      [
        ['Visa Law (Smith & Partners)', null, 1],
        ['Bravo', 'bravo', 2],
      ],
    );
    expect(
      credit([
        {
          name: 'Smith & Partners',
          nameId: 0,
          discussionId: 1,
          sentiment: 'neutral',
          sentimentId: 1,
        },
      ]).companies,
    ).toHaveLength(2);
    answer.citations = [
      citation(
        answer,
        'https://unrelated.example/guide',
        'Smith & Partners',
        1,
      ),
    ];
    expect(credit().companies?.map((c) => c.name)).toEqual(['Bravo']);
  });

  it('credits a substantive opening comparison and excludes headings, questions, and lists of names', () => {
    const firm = {
      ...selected,
      brand: {
        id: 'acme',
        name: 'Visa Law',
        aliases: [],
        domains: ['visalaw.example'],
      },
    };
    const answer = captured(
      'Bravo makes repair kits while **Visa Law** (the firm owned by Smith & Partners) handles its contracts.',
    );
    answer.citations = [
      citation(answer, 'https://visa-law.example/team', 'Smith & Partners', 0),
    ];
    const result = from(
      answer,
      [
        decision('acme', {
          decision: 'other_business',
          nameId: 0,
          discussionId: 0,
          citationIds: [0],
        }),
        confirmed('bravo', 0),
      ],
      [
        {
          name: 'Visa Law (Smith & Partners)',
          nameId: 0,
          discussionId: 0,
          sentiment: 'neutral',
          sentimentId: 0,
        },
      ],
      firm,
    );
    expect(result.companies?.map((c) => [c.name, c.rank])).toEqual([
      ['Bravo', 1],
      ['Visa Law (Smith & Partners)', 2],
    ]);
    for (const introduction of [
      'Acme and Bravo',
      '### About Acme',
      '### Acme: pricing and service',
      'Who should I choose, Acme or Bravo?',
    ]) {
      expect(
        from(captured(introduction), [confirmed('acme', 0), decision('bravo')])
          .brands[0].mentioned,
      ).toBe(false);
    }
  });

  it('accepts an official citation attached to a separately assessed business-specific passage and rejects a citation attached to another subject', () => {
    const credit = (
      later: string,
      corroboration = true,
      sentiment = 'positive',
    ) => {
      const answer = captured(
        'Acme replaces specialist machine components.\n' +
          later +
          '\nAcme runs repair workshops across three cities.',
      );
      const reference = (line: number) =>
        citation(answer, 'https://acme.example/shop', 'Acme repair shop', line);
      answer.citations = [reference(1)];
      if (corroboration) answer.citations.push({ ...reference(2), id: 'c2' });
      return from(answer, [
        decision('acme', {
          decision: 'official_site',
          nameId: 0,
          discussionId: 0,
          sentiment,
          sentimentId: 1,
          citationIds: [0],
        }),
        decision('bravo'),
      ]).brands[0];
    };
    const confirmed = credit(
      'Acme owns two repair workshops and accepts overnight orders.',
    );
    expect(confirmed).toMatchObject({
      mentioned: true,
      appearanceRank: 1,
      identity: { citationIds: ['c1', 'c2'] },
    });
    expect(confirmed.identity?.evidence).toHaveLength(3);
    expect(
      credit(
        'For general filing requirements, consult the guide from Acme.',
        false,
        'neutral',
      ).mentioned,
    ).toBe(false);
    expect(
      credit('The advice in the Acme guide is excellent.', false).mentioned,
    ).toBe(false);
    for (const unrelated of [
      'Bravo owns two repair workshops.',
      'Some customers hire Bravo after trying Acme.',
      'Read the [Acme](https://acme.example/) guide for details.',
      '### About Acme',
    ])
      expect(credit(unrelated).mentioned).toBe(false);
  });

  it('leaves a qualified namesake unresolved when its passage cites both confusable hosts', () => {
    const answer = captured('Acme (Robin Mills) operates a jewelry store.');
    answer.citations = [
      citation(answer, 'https://ac-me.example/shop', 'Robin Mills Jewelry', 0),
      citation(
        answer,
        'https://acme.example/guide',
        'General business registration',
        0,
      ),
    ];
    expect(
      from(answer, [
        decision('acme', {
          decision: 'official_site',
          nameId: 0,
          discussionId: 0,
          citationIds: [0, 1],
        }),
        decision('bravo'),
      ]).brands[0].identity?.status,
    ).toBe('unresolved');
  });

  it('treats duplicate brand decisions and invalid evidence as analysis failures', () => {
    const answer = captured();
    expect(() =>
      from(answer, [confirmed('acme', 0), confirmed('acme', 1)]),
    ).toThrow(/exactly once/);
    expect(() =>
      from(answer, [decision('bravo'), confirmed('acme', 99)]),
    ).toThrow(/Unknown evidence/);
    expect(() =>
      from(answer, [
        decision('bravo'),
        decision('acme', { citationIds: [99] }),
      ]),
    ).toThrow(/Unknown citation/);
  });
});
