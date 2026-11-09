if (process.env.NODE_ENV !== 'test')
  throw new Error('Test fixtures cannot be used by the application.');
// Test fixtures only. Never import this module from application or script code.
import type { Brandbook, OnboardingJob } from '@citevia/core';
import {
  brandedAllocation,
  comparisonAllocation,
  isBrandedPrompt,
  journeyAllocation,
  STAGE_INTENTS,
  type JourneyStage,
  type PromptIntent,
} from '@citevia/core';
import type {
  OnboardingProvider,
  PortfolioPeer,
} from '../../apps/scanner/src/onboarding-provider.js';
import { validatePortfolio } from '../../apps/scanner/src/onboarding-provider.js';
export class FixtureOnboardingProvider implements OnboardingProvider {
  async research(job: OnboardingJob) {
    const text = `Synthetic demonstration research for ${job.input.name}. ${job.input.description || 'This fictional brief demonstrates the onboarding workflow.'}`;
    return {
      providerResponseId: `demo-onboard-${job.id}`,
      model: 'demo-fixture',
      status: 'completed' as const,
      blocks: [{ id: 'block_0', text }],
      text,
      citations: [],
      sources: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      createdAt: new Date().toISOString(),
      raw: { demo: true },
    };
  }
  async brandbook(job: OnboardingJob) {
    const brandbook: Brandbook = {
      about:
        job.input.description ||
        `A sample brand profile for ${job.input.name}. Replace this demonstration description with verified company information.`,
      industryCategory: 'Demonstration',
      subIndustryCategory: '',
      companyCountry: job.input.country,
      language: job.input.language,
      names: [job.input.name],
      domains: [new URL(job.input.website).hostname],
      keyFeatures: ['Sample offering'],
      toneOfVoice: ['Clear'],
      values: [],
      personality: [],
      targetAudience: ['Prospective buyers'],
      knowledgeSources: [],
      sitemapUrl: null,
      caseStudiesSourceUrl: null,
      caseStudies: [],
      postGuidelines: {
        dos: ['Use verified company facts'],
        donts: ['Invent claims or customer results'],
      },
      evidence: [],
      unknowns: [
        'Simulated profile: no public research or paid API call was made.',
      ],
      generatedAt: new Date().toISOString(),
      model: 'demo-fixture',
      version: 1,
      generationId: job.id,
    };
    return { brandbook, receipt: { demo: true } };
  }
  async prompts(
    job: OnboardingJob,
    book: Brandbook,
    peers: readonly PortfolioPeer[] = [],
  ) {
    const allocation = journeyAllocation(job.input.manualPrompts);
    const brand = {
      name: job.input.name,
      domains: book.domains,
      aliases: book.names,
    };
    const branded = brandedAllocation(
      allocation,
      job.input.manualPrompts.filter((p) => isBrandedPrompt(p.text, brand))
        .length,
    );
    const compare = comparisonAllocation(
      allocation.prefer,
      branded.prefer,
      peers.length,
    );
    const topics = [
      'setup',
      'support',
      'training',
      'costs',
      'reporting',
      'maintenance',
      'integrations',
      'ordering',
      'delivery',
      'installation',
      'repairs',
      'returns',
      'billing',
    ];
    const prompts = Object.entries(allocation).flatMap(([key, count]) => {
      const stage = key as JourneyStage;
      return Array.from({ length: count }, (_, i) => {
        const topic = topics[i % topics.length];
        const isBranded = i < branded[stage];
        const name = isBranded ? job.input.name : 'providers';
        const unbrandedIndex = i - branded[stage];
        const comparing =
          stage === 'prefer' &&
          (isBranded
            ? i < compare.branded
            : unbrandedIndex < compare.unbranded);
        const alternative =
          isBranded && i < compare.distinct_named_rivals
            ? peers[i].name
            : 'other providers';
        const options = {
          understand: [
            `Who offers ${topic} for small teams?`,
            `Providers with help for ${topic}`,
            `Looking for a supplier for ${topic}`,
          ],
          prefer: [
            `Recommended providers for ${topic}`,
            `Which suppliers offer affordable ${topic}?`,
            `Find a provider with ${topic} support`,
          ],
          trust: [
            `Whose published guides cover ${topic} for buyers?`,
            `Suppliers with reliable documentation on ${topic}`,
            `Who shares detailed guidance on ${topic}?`,
          ],
          convert: [
            `Where can I book ${topic} support?`,
            `Which supplier can quote for ${topic}?`,
            `Looking to hire providers for ${topic}`,
          ],
        };
        let text = options[stage][i % 3];
        if (isBranded)
          text = {
            understand: `Does ${name} provide ${topic} services?`,
            prefer: `Would ${name} suit a team prioritizing ${topic}?`,
            trust: `Where does ${name} document its ${topic} service?`,
            convert: `Can I contact ${name} for a ${topic} quote?`,
          }[stage];
        if (comparing)
          text = isBranded
            ? `Compare ${name} and ${alternative} on ${topic}`
            : [
                `Which providers should I compare for ${topic}?`,
                `Compare suppliers by ${topic} options`,
                `Alternatives for outsourced ${topic}: which providers stand out?`,
              ][i % 3];
        const intent: PromptIntent =
          stage === 'prefer'
            ? comparing
              ? 'comparison'
              : 'commercial'
            : STAGE_INTENTS[stage][i % STAGE_INTENTS[stage].length];
        return { text, stage, topic, branded: isBranded, intent };
      });
    });
    return {
      prompts: validatePortfolio(job, book, { prompts }, peers),
      receipt: { demo: true },
    };
  }
}
