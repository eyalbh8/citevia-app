if(process.env.NODE_ENV!=='test')throw new Error('Test fixtures cannot be used by the application.');
// Test fixtures only. Never import this module from application or script code.
import type { Brandbook, OnboardingJob } from '@citevia/core';
import { journeyAllocation } from '@citevia/core';
import type { OnboardingProvider } from '../../apps/scanner/src/onboarding-provider.js';
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
  async prompts(job: OnboardingJob, book: Brandbook) {
    const templates = {
      understand:
        'What should I understand about choosing this type of solution',
      prefer: 'Which providers should I compare',
      trust: 'What evidence should I check before trusting a provider',
      convert: 'How can I evaluate pricing and arrange the next step',
    };
    const audiences = [
      'a small team',
      'a growing company',
      'an enterprise team',
      'an independent consultant',
      'an agency',
      'a new business',
    ];
    const constraints = [
      'setup',
      'support',
      'reliability',
      'integrations',
      'cost',
      'implementation',
      'training',
      'scalability',
      'reporting',
    ];
    const prompts = Object.entries(
      journeyAllocation(job.input.manualPrompts),
    ).flatMap(([stage, count]) =>
      Array.from({ length: count }, (_, i) => ({
        text: `${templates[stage as keyof typeof templates]} for ${audiences[i % audiences.length]}, focusing on ${constraints[Math.floor(i / audiences.length)]}?`,
        stage,
        topic: 'Sample buyer journey',
        branded: false,
      })),
    );
    return {
      prompts: validatePortfolio(job, book, { prompts }),
      receipt: { demo: true },
    };
  }
}
