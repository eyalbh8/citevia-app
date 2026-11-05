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
const usMarkets = [
  'Atlanta', 'Austin', 'Baltimore', 'Birmingham', 'Boston', 'Buffalo', 'Charlotte', 'Chicago',
  'Cincinnati', 'Cleveland', 'Columbus', 'Dallas', 'Denver', 'Detroit', 'El Paso', 'Fort Worth',
  'Fresno', 'Houston', 'Indianapolis', 'Jacksonville', 'Kansas City', 'Las Vegas', 'Long Beach', 'Los Angeles',
  'Louisville', 'Memphis', 'Miami', 'Milwaukee', 'Minneapolis', 'Nashville', 'New Orleans', 'New York',
  'Oklahoma City', 'Omaha', 'Orlando', 'Philadelphia', 'Phoenix', 'Pittsburgh', 'Portland', 'Raleigh',
  'Sacramento', 'Salt Lake City', 'San Antonio', 'San Diego', 'San Francisco', 'Seattle', 'Tampa', 'Tucson',
];
const unattendedPublications = [
  'Vending Operator Journal', 'Unattended Retail Review', 'Cashless Acceptance Report', 'Micro Market Bulletin',
  'Self Service Kiosk Digest', 'Route Operations Weekly', 'Machine Telemetry Review', 'Retail Automation Wire',
  'Parking Payments Journal', 'Smart Cooler Digest', 'Coin Laundry Ledger', 'Contactless Retail Review',
  'Amusement Payments Weekly', 'Office Coffee Journal', 'Automated Merchandising Report', 'Fuel Retail Bulletin',
  'Merchant Acquiring Digest', 'Point of Sale Journal', 'Car Wash Operator Review', 'Retail Hardware Chronicle',
  'EV Charging Report', 'Foodservice Technology Ledger', 'Payment Terminal Review', 'Convenience Retail Observer',
];
const unattendedGuides = [
  'An operator guide', 'Choosing a card reader', 'Planning a rollout', 'Comparing processing costs',
  'A route operator checklist', 'Terminal integration options', 'Managing a machine fleet', 'Evaluating a payment provider',
];
type Profile = NonNullable<DemoConfig['reportingProfile']>;
const beddingPublications = [
  'Bedding Journal', 'Textile Design Review', 'Linen Closet Quarterly', 'Bath and Home Digest',
  'Cotton Weave Review', 'Bedroom Design Weekly', 'Home Fabrics Journal', 'Sleep Comfort Report',
  'Household Textile Ledger', 'Interior Design Chronicle', 'Linen Care Bulletin', 'Guest Room Review',
  'Soft Furnishings Journal', 'Bath Linen Observer', 'Everyday Interiors Review', 'Quilt and Coverlet Digest',
  'Natural Fiber Journal', 'Home Goods Almanac', 'Bedroom Styling Weekly', 'Fabric Testing Report',
  'Home Design Letter', 'Pillow and Duvet Review', 'Household Essentials Digest', 'Textile Sourcing Monitor',
];
const beddingGuides = [
  'Choosing a fabric', 'Comparing weaves and finishes', 'A bedding care guide', 'What to look for in a set',
  'Understanding fill and weight', 'A guide to fit and sizing', 'Matching fabrics to the season', 'A material checklist',
];
const yachtPlaces = [
  'Alghero', 'Amalfi', 'Ancona', 'Antibes', 'Athens', 'Barcelona', 'Bari', 'Bastia',
  'Bodrum', 'Bonifacio', 'Brindisi', 'Cagliari', 'Cannes', 'Capri', 'Catania', 'Civitavecchia',
  'Corfu', 'Dubrovnik', 'Elba', 'Gallipoli', 'Genoa', 'Ibiza', 'Imperia', 'Ischia',
  'Kotor', 'La Maddalena', 'La Spezia', 'Livorno', 'Mallorca', 'Marseille', 'Messina', 'Monaco',
  'Naples', 'Nice', 'Olbia', 'Palermo', 'Palma', 'Porto Cervo', 'Portofino', 'Ravenna',
  'Salerno', 'Sanremo', 'Sicily', 'Sorrento', 'Split', 'Trieste', 'Valletta', 'Venice',
];
const yachtPublications = [
  'Yachting Review', 'Charter Journal', 'Mediterranean Cruising Digest', 'Marina Bulletin',
  'Yacht Brokerage Report', 'Superyacht Ledger', 'Sailing Almanac', 'Marine Survey Review',
  'Crewed Charter Weekly', 'Yacht Design Observer', 'Motor Yacht Quarterly', 'Coastal Itinerary Journal',
  'Boat Ownership Review', 'Harbour Guide', 'Marine Refit Chronicle', 'Yacht Management Digest',
  'Charter Operations Report', 'Sailing Routes Letter', 'Marine Engineering Review', 'Classic Yacht Journal',
  'Luxury Charter Digest', 'Port Services Review', 'Yacht Market Monitor', 'Fleet Management Journal',
];
const yachtGuides = [
  'Planning a Mediterranean itinerary', 'A charterer’s checklist', 'Comparing yachts', 'Working with a broker',
  'Choosing a departure port', 'Preparing for a viewing', 'Understanding running costs', 'Questions about crew and service',
];
const restorationPlaces = [
  'Istanbul', 'Ankara', 'Izmir', 'Bursa', 'Antalya', 'Adana', 'Konya', 'Kayseri',
  'Samsun', 'Trabzon', 'Eskisehir', 'Denizli', 'Athens', 'Barcelona', 'Belgrade', 'Berlin',
  'Bologna', 'Brussels', 'Bucharest', 'Budapest', 'Copenhagen', 'Dublin', 'Frankfurt', 'Geneva',
  'Hamburg', 'Helsinki', 'Lisbon', 'London', 'Lyon', 'Madrid', 'Manchester', 'Milan',
  'Munich', 'Naples', 'Oslo', 'Paris', 'Porto', 'Prague', 'Rome', 'Rotterdam',
  'Sofia', 'Stockholm', 'Stuttgart', 'Turin', 'Valencia', 'Vienna', 'Warsaw', 'Zurich',
];
const restorationPublications = [
  'Hair Restoration Review', 'Scalp Health Journal', 'Follicular Surgery Digest', 'Patient Education Bulletin',
  'Hair Loss Review', 'Donor Assessment Journal', 'Dermatology Care Report', 'Restoration Outcomes Monitor',
  'Hair Transplant Quarterly', 'Aftercare Review', 'Hairline Design Journal', 'Patient Consultation Digest',
  'Follicular Unit Review', 'Scalp Surgery Journal', 'Hair Density Report', 'Clinical Follow Up Review',
  'Patient Safety Letter', 'Surgical Planning Review', 'Hair Science Digest', 'Dermatology Practice Journal',
  'Restoration Techniques Review', 'Recovery Journal', 'Hair Care Research Bulletin', 'Patient Information Review',
];
const restorationGuides = [
  'Questions for a consultation', 'Preparing for a clinical assessment', 'Comparing treatment approaches', 'Understanding donor areas',
  'Talking through potential risks', 'Planning follow-up appointments', 'Discussing graft estimates', 'Considering aftercare needs',
];
const italyPlaces = [
  'Arezzo', 'Assisi', 'Bari', 'Bergamo', 'Bologna', 'Bolzano', 'Brescia', 'Cagliari',
  'Capri', 'Catania', 'Cefalu', 'Como', 'Cortona', 'Ferrara', 'Fiesole', 'Florence',
  'Genoa', 'Greve', 'Lake Garda', 'Livorno', 'Lucca', 'Mantua', 'Matera', 'Milan',
  'Modena', 'Montalcino', 'Montepulciano', 'Naples', 'Orvieto', 'Padua', 'Palermo', 'Parma',
  'Perugia', 'Pienza', 'Pisa', 'Portofino', 'Positano', 'Ravenna', 'Rome', 'San Gimignano',
  'Siena', 'Sorrento', 'Taormina', 'Trieste', 'Turin', 'Venice', 'Verona', 'Vicenza',
];
const hospitalityPublications = [
  'City Hotels Journal', 'Guest Experience Review', 'Historic Residences Quarterly', 'Tuscan Travel Digest',
  'Art and Architecture Guide', 'Dining Room Journal', 'Luxury Travel Report', 'Hotel Design Review',
  'Independent Concierge Bulletin', 'Regional Cuisine Observer', 'Family Travel Review', 'Garden Visits Journal',
  'Hotel Spa Digest', 'Heritage Hospitality Review', 'Courtyard and Palace Journal', 'Cultural Itineraries',
  'Wedding Venues Report', 'Artisan Travel Quarterly', 'Private Dining Review', 'Travel Planner Almanac',
  'Museum and Gallery Guide', 'Restaurant Chronicle', 'Boutique Hotels Ledger', 'Italian Destinations Weekly',
];
const hospitalityGuides = [
  'Choosing a neighbourhood', 'Planning a seasonal stay', 'Exploring historic properties', 'Comparing room categories',
  'Dining and reservations', 'A family travel checklist', 'Making time for local art', 'Questions for the concierge',
];
const mobilityMarkets = [
  'Amsterdam', 'Ankara', 'Athens', 'Atlanta', 'Austin', 'Barcelona', 'Beersheba', 'Berlin',
  'Boston', 'Brussels', 'Budapest', 'Chicago', 'Copenhagen', 'Dallas', 'Denver', 'Dublin',
  'Frankfurt', 'Geneva', 'Haifa', 'Hamburg', 'Helsinki', 'Herzliya', 'Houston', 'Istanbul',
  'Jerusalem', 'Lisbon', 'London', 'Los Angeles', 'Madrid', 'Manchester', 'Miami', 'Milan',
  'Montreal', 'Munich', 'Netanya', 'New York', 'Paris', 'Philadelphia', 'Prague', 'Ramat Gan',
  'Rome', 'San Francisco', 'Seattle', 'Stockholm', 'Tel Aviv', 'Toronto', 'Vienna', 'Zurich',
];
const immigrationPublications = [
  'Global Mobility Review', 'Immigration Practice Journal', 'Cross Border Employment Digest', 'Corporate Relocation Bulletin',
  'Work Permit Review', 'Expatriate Policy Journal', 'International Assignment Report', 'Business Immigration Observer',
  'Residence Planning Quarterly', 'Employer Compliance Review', 'Consular Practice Journal', 'Talent Mobility Digest',
  'Visa Procedures Review', 'Travel Documentation Journal', 'Workforce Mobility Report', 'Immigration Operations Review',
  'International Hiring Letter', 'Relocation Planning Review', 'Mobility Policy Digest', 'Employment Practice Journal',
  'Business Travel Review', 'Global Assignments Journal', 'Immigration Casework Bulletin', 'Mobility Services Review',
];
const immigrationGuides = [
  'Preparing for a consultation', 'Documents for an application', 'Questions for a mobility team', 'Planning a relocation',
  'Checking government requirements', 'Understanding employer responsibilities', 'Discussing renewal timelines', 'Comparing immigration pathways',
];
const fertilityPublications = [
  'Fertility Care Review', 'Reproductive Health Journal', 'Family Building Digest', 'Patient Education Bulletin',
  'Fertility Assessment Review', 'IVF Practice Journal', 'Embryology Report', 'Fertility Preservation Monitor',
  'Reproductive Medicine Quarterly', 'Patient Experience Review', 'Donor Care Journal', 'Fertility Consultation Digest',
  'Embryo Laboratory Review', 'Reproductive Endocrinology Journal', 'Fertility Outcomes Report', 'Treatment Planning Review',
  'Patient Support Letter', 'Reproductive Care Review', 'Fertility Research Digest', 'Fertility Clinic Journal',
  'Assisted Reproduction Review', 'Family Formation Journal', 'Egg Freezing Bulletin', 'Patient Information Review',
];
const fertilityGuides = [
  'Questions for a fertility consultation', 'Preparing for a first visit', 'Discussing treatment options', 'Understanding the care team',
  'Planning for monitoring appointments', 'Asking about laboratory standards', 'Interpreting clinic statistics', 'Finding patient support',
];
const industries = {
  uk_investing: { places, publications: investingPublications, guides: investingGuides, fallback: 'UK investing platforms', idPrefix: 'demo_investing' },
  merchant_payments: { places, publications: paymentPublications, guides: paymentGuides, fallback: 'Merchant payments', idPrefix: 'merchant_payments' },
  residential_roofing: { places: roofingPlaces, publications: roofingPublications, guides: roofingGuides, fallback: 'Residential roofing', idPrefix: 'residential_roofing' },
  unattended_payments: { places: usMarkets, publications: unattendedPublications, guides: unattendedGuides, fallback: 'Unattended payments', idPrefix: 'unattended_payments' },
  home_bedding: { places: usMarkets, publications: beddingPublications, guides: beddingGuides, fallback: 'Home bedding and bath linens', idPrefix: 'home_bedding' },
  yacht_chartering: { places: yachtPlaces, publications: yachtPublications, guides: yachtGuides, fallback: 'Mediterranean yacht charter and brokerage', idPrefix: 'yacht_chartering' },
  hair_restoration: { places: restorationPlaces, publications: restorationPublications, guides: restorationGuides, fallback: 'Hair restoration consultations', idPrefix: 'hair_restoration' },
  luxury_hospitality: { places: italyPlaces, publications: hospitalityPublications, guides: hospitalityGuides, fallback: 'Luxury hotel stays in Florence', idPrefix: 'luxury_hospitality' },
  immigration_law: { places: mobilityMarkets, publications: immigrationPublications, guides: immigrationGuides, fallback: 'Immigration and global mobility', idPrefix: 'immigration_law' },
  fertility_care: { places: usMarkets, publications: fertilityPublications, guides: fertilityGuides, fallback: 'Fertility care and family building', idPrefix: 'fertility_care' },
} satisfies Record<Profile, { places: string[]; publications: string[]; guides: string[]; fallback: string; idPrefix: string }>;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const caches = {
  uk_investing: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  merchant_payments: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  residential_roofing: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  unattended_payments: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  home_bedding: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  yacht_chartering: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  hair_restoration: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  luxury_hospitality: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  immigration_law: new WeakMap<Prompt[], Map<string, Citation[]>>(),
  fertility_care: new WeakMap<Prompt[], Map<string, Citation[]>>(),
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
