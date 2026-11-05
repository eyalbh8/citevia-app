import type { Citation, DemoConfig, Prompt } from '@citevia/core';

const places = [
  'Aberdeen', 'Bath', 'Belfast', 'Birmingham', 'Bradford', 'Brighton', 'Bristol', 'Cambridge',
  'Canterbury', 'Cardiff', 'Carlisle', 'Chelmsford', 'Chester', 'Chichester', 'Coventry', 'Derby',
  'Dundee', 'Durham', 'Edinburgh', 'Exeter', 'Glasgow', 'Gloucester', 'Inverness', 'Lancaster',
  'Leeds', 'Leicester', 'Lincoln', 'Liverpool', 'London', 'Manchester', 'Newcastle', 'Newport',
  'Norwich', 'Nottingham', 'Oxford', 'Perth', 'Peterborough', 'Plymouth', 'Portsmouth', 'Preston',
  'Reading', 'Sheffield', 'Southampton', 'Stirling', 'Swansea', 'Winchester', 'Worcester', 'York',
];
const investingPublications = [
  'Investor Journal', 'Fund Review', 'Markets Digest', 'Broker Bulletin', 'Capital Observer', 'ETF Weekly',
  'Pension Review', 'Dividend Monitor', 'Savings Journal', 'Portfolio Digest', 'Equity Wire', 'Wealth Review',
  'Markets Notebook', 'Investment Brief', 'Shares Report', 'Money Quarterly', 'Finance Review', 'Trading Journal',
  'Risk Monitor', 'Index Report', 'Asset Review', 'Investment Almanac', 'Capital Letter', 'Investor Chronicle',
];
const investingGuides = [
  'A guide for UK investors', 'Fees and features', 'Questions to ask your broker', 'Comparing platform options',
  'An investor checklist', 'Costs and trade-offs', 'The essentials', 'A practical overview',
];
const paymentPublications = [
  'Merchant Payments Review', 'Acquiring Bulletin', 'Checkout Journal', 'Commerce Technology Digest',
  'Retail Payments Review', 'Settlement Monitor', 'Open Banking Brief', 'Dispute Management Journal',
  'Merchant Services Weekly', 'Payment Security Report', 'Card Acceptance Review', 'Digital Commerce Wire',
  'Payment Operations Journal', 'Cross Border Commerce Review', 'Retail Systems Quarterly', 'Fintech Ledger',
  'Subscription Commerce Report', 'Business Banking Review', 'Payment Methods Digest', 'Treasury Monitor',
  'Commerce Risk Review', 'Online Retail Almanac', 'Merchant Technology Letter', 'Payments Chronicle',
];
const paymentGuides = [
  'A guide for merchants', 'Understanding commercial terms', 'Questions for a payments partner', 'Comparing providers',
  'A merchant checklist', 'Costs and trade-offs', 'Operational considerations', 'A procurement overview',
];
const roofingPlaces = [
  'Acworth', 'Alpharetta', 'Atlanta', 'Auburn', 'Austell', 'Avondale Estates', 'Ball Ground', 'Berkeley Lake',
  'Braselton', 'Brookhaven', 'Buford', 'Canton', 'Cartersville', 'Chamblee', 'Clarkston', 'Conyers',
  'Covington', 'Cumming', 'Dacula', 'Dallas', 'Decatur', 'Doraville', 'Douglasville', 'Duluth',
  'Dunwoody', 'East Point', 'Fayetteville', 'Flowery Branch', 'Gainesville', 'Grayson', 'Hiram', 'Holly Springs',
  'Johns Creek', 'Kennesaw', 'Lawrenceville', 'Lilburn', 'Loganville', 'Marietta', 'Milton', 'Norcross',
  'Peachtree City', 'Peachtree Corners', 'Powder Springs', 'Roswell', 'Sandy Springs', 'Smyrna', 'Suwanee', 'Woodstock',
];
const roofingPublications = [
  'Residential Roofing Review', 'Roof Inspection Journal', 'Building Envelope Digest', 'Storm Restoration Report',
  'Home Repair Bulletin', 'Roof Systems Weekly', 'Shingle Review', 'Exterior Renovation Journal',
  'Roofing Materials Digest', 'Homeowner Ledger', 'Roof Ventilation Review', 'Residential Construction Wire',
  'Gutter and Drainage Report', 'Building Science Quarterly', 'Property Maintenance Journal', 'Weather Resilience Review',
  'Remodeling Chronicle', 'Roofing Warranty Bulletin', 'Home Improvement Almanac', 'Exterior Trades Review',
  'Residential Contractor Digest', 'Roof Repair Monitor', 'Building Products Ledger', 'Neighborhood Homes Journal',
];
const roofingGuides = [
  'A guide for homeowners', 'Comparing written estimates', 'What to ask a roofing contractor', 'Planning an inspection',
  'A homeowner checklist', 'Materials and workmanship', 'Understanding warranties', 'Signs of storm damage',
];
type Profile = NonNullable<DemoConfig['reportingProfile']>;
const industries = {
  uk_investing: { places, publications: investingPublications, guides: investingGuides, fallback: 'UK investing platforms', idPrefix: 'demo_investing' },
  merchant_payments: { places, publications: paymentPublications, guides: paymentGuides, fallback: 'Merchant payments', idPrefix: 'merchant_payments' },
  residential_roofing: { places: roofingPlaces, publications: roofingPublications, guides: roofingGuides, fallback: 'Residential roofing', idPrefix: 'residential_roofing' },
} satisfies Record<Profile, { places: string[]; publications: string[]; guides: string[]; fallback: string; idPrefix: string }>;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const caches = {
  uk_investing: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  merchant_payments: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  residential_roofing: new WeakMap<Prompt[], Map<string, Citation[]>>(),
} satisfies Record<Profile, WeakMap<Prompt[], Map<string, Citation[]>>>;
const noSources: Citation[] = [];

// One compact catalog per prompt cohort. Runs reference the same immutable
// annotations, including in year-long reports and individual answer drilldowns.
export function industrySources(profile: Profile, prompts: Prompt[], promptId: string): Citation[] {
  const { places, publications, guides, fallback, idPrefix } = industries[profile];
  const byCohort = caches[profile];
  let catalog = byCohort.get(prompts);
  if (!catalog) {
    catalog = new Map(prompts.map(prompt => [prompt.id, [] as Citation[]]));
    if (prompts.length) {
      let index = 0;
      for (const place of places) for (const publication of publications) {
        const prompt = prompts[index % prompts.length];
        const topic = prompt.topic || fallback;
        const title = `${topic}: ${guides[index % guides.length]}`;
        const publisher = `${place} ${publication}`;
        const citation: Citation = {
          id: `${idPrefix}_source_${index + 1}`, blockId: 'answer',
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
