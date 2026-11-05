import type { Citation, Prompt } from '@citevia/core';

const places = [
  'Aberdeen', 'Bath', 'Belfast', 'Birmingham', 'Bradford', 'Brighton', 'Bristol', 'Cambridge',
  'Canterbury', 'Cardiff', 'Carlisle', 'Chelmsford', 'Chester', 'Chichester', 'Coventry', 'Derby',
  'Dundee', 'Durham', 'Edinburgh', 'Exeter', 'Glasgow', 'Gloucester', 'Inverness', 'Lancaster',
  'Leeds', 'Leicester', 'Lincoln', 'Liverpool', 'London', 'Manchester', 'Newcastle', 'Newport',
  'Norwich', 'Nottingham', 'Oxford', 'Perth', 'Peterborough', 'Plymouth', 'Portsmouth', 'Preston',
  'Reading', 'Sheffield', 'Southampton', 'Stirling', 'Swansea', 'Winchester', 'Worcester', 'York',
];
const publications = [
  'Investor Journal', 'Fund Review', 'Markets Digest', 'Broker Bulletin', 'Capital Observer', 'ETF Weekly',
  'Pension Review', 'Dividend Monitor', 'Savings Journal', 'Portfolio Digest', 'Equity Wire', 'Wealth Review',
  'Markets Notebook', 'Investment Brief', 'Shares Report', 'Money Quarterly', 'Finance Review', 'Trading Journal',
  'Risk Monitor', 'Index Report', 'Asset Review', 'Investment Almanac', 'Capital Letter', 'Investor Chronicle',
];
const guideTitles = [
  'A guide for UK investors', 'Fees and features', 'Questions to ask your broker', 'Comparing platform options',
  'An investor checklist', 'Costs and trade-offs', 'The essentials', 'A practical overview',
];
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const byCohort = new WeakMap<Prompt[], Map<string, Citation[]>>();
const noSources: Citation[] = [];

// One compact catalog per prompt cohort. Runs reference the same immutable
// annotations, including in year-long reports and individual answer drilldowns.
export function investingSources(prompts: Prompt[], promptId: string): Citation[] {
  let catalog = byCohort.get(prompts);
  if (!catalog) {
    catalog = new Map(prompts.map(prompt => [prompt.id, [] as Citation[]]));
    if (prompts.length) {
      let index = 0;
      for (const place of places) for (const publication of publications) {
        const prompt = prompts[index % prompts.length];
        const topic = prompt.topic || 'UK investing platforms';
        const title = `${topic}: ${guideTitles[index % guideTitles.length]}`;
        const publisher = `${place} ${publication}`;
        const citation: Citation = {
          id: `demo_investing_source_${index + 1}`, blockId: 'answer',
          url: `https://${slug(publisher)}.example/guides/${slug(topic)}/`,
          title: `${title} | ${publisher}`, start: null, end: null,
        };
        catalog.get(prompt.id)!.push(citation);
        // Some publications inform adjacent questions within the scan, too.
        if (prompts.length > 1 && index % 7 === 0)
          catalog.get(prompts[(index + 1) % prompts.length].id)!.push(citation);
        if (prompts.length > 2 && index % 35 === 0)
          catalog.get(prompts[(index + 2) % prompts.length].id)!.push(citation);
        index++;
      }
    }
    byCohort.set(prompts, catalog);
  }
  return catalog.get(promptId) || noSources;
}
