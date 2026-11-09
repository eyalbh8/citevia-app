import { createHash } from 'node:crypto';
import {
  SOCIAL_CHANNELS,
  socialBrandHasDestination,
  type AutomationDestination,
  type Project,
  type ReserveSocialOccurrenceInput,
  type SocialOccurrence,
  type SocialPublication,
} from '@citevia/core';

const stableId = (prefix: string, parts: unknown[]) => `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;
// Brand and slot IDs cannot contain ':'. Preserve the original key for legacy reservations.
export const socialSlotKey = ({ brandId, slotId }: Pick<SocialOccurrence, 'brandId' | 'slotId'>) =>
  brandId ? `${brandId}:${slotId}` : slotId;
export const socialOccurrenceId = (input: ReserveSocialOccurrenceInput, localDate: string) =>
  stableId('social', [input.projectId, input.revision, socialSlotKey(input), localDate]);

/** Called only while the account is locked. Blog targets come from server settings, never caller destinations. */
export function createSocialRecords(
  project: Project,
  input: ReserveSocialOccurrenceInput,
  localDate: string,
  previous: SocialOccurrence | null,
): { occurrence: SocialOccurrence; publications: SocialPublication[] } | null {
  const settings = project.socialAutomation;
  const brand = settings?.brands?.find(brand => brand.id === input.brandId);
  if (settings?.brands?.length ? !brand : input.brandId !== undefined) return null;
  const destinations: AutomationDestination[] = [];
  const seen = new Set<string>();
  for (const destination of input.destinations) {
    if (!project.socialProfileId || destination.profileId !== project.socialProfileId || !destination.id ||
      destination.id === 'blog-draft' || !SOCIAL_CHANNELS.includes(destination.channel) ||
      !destination.active || destination.requiresReconnect || seen.has(destination.id) ||
      (brand && !socialBrandHasDestination(brand, destination))) continue;
    seen.add(destination.id);
    const configured = project.socialDestinationOptions?.[destination.id];
    destinations.push(structuredClone({ ...destination, ...(configured ? { options: { ...destination.options, ...configured } } : {}) }));
  }
  if (!brand && settings?.createBlogDrafts === true) destinations.push({
    id: 'blog-draft', channel: 'blog', username: 'Blog drafts', profileId: '', active: true, requiresReconnect: false,
  });
  const prompts = project.prompts.filter(prompt => prompt.active).sort((a, b) => a.id.localeCompare(b.id));
  if (!prompts.length || !destinations.length) return null;
  const sequence = (previous?.sequence ?? 0) + 1;
  const lastIndex = prompts.findIndex(prompt => prompt.id === previous?.prompt.id);
  const prompt = structuredClone(prompts[lastIndex >= 0 ? (lastIndex + 1) % prompts.length : (sequence - 1) % prompts.length]);
  const brandSlots = brand?.slots.slice().sort((a, b) => (a.dayOfWeek + 6) % 7 - (b.dayOfWeek + 6) % 7 || a.time.localeCompare(b.time));
  const context = structuredClone({ brand: project.brand, ...(project.brandbook ? { brandbook: project.brandbook } : {}), country: project.country, language: project.language,
    imageSource: settings?.imageSource ?? 'openai', ...(brand && brandSlots ? {
      socialBrand: { id: brand.id, name: brand.name, description: brand.description },
      weeklyCreative: { number: brandSlots.findIndex(slot => slot.id === input.slotId) + 1, total: brandSlots.length, scheduledAt: input.scheduledAt },
    } : {}) });
  const occurrence: SocialOccurrence = {
    id: socialOccurrenceId(input, localDate), projectId: project.id, revision: input.revision,
    slotId: input.slotId, ...(brand ? { brandId: brand.id } : {}), localDate, scheduledAt: new Date(input.scheduledAt).toISOString(),
    createdAt: new Date(input.now).toISOString(), sequence, prompt, destinations, context,
  };
  const publications = destinations.map((destination): SocialPublication => ({
    id: stableId('publication', [occurrence.id, destination.id]), projectId: project.id,
    occurrenceId: occurrence.id, revision: input.revision, scheduledAt: occurrence.scheduledAt,
    prompt: structuredClone(prompt), destination, context: structuredClone(context), status: 'queued',
    stage: 'queued', version: 1, createdAt: occurrence.createdAt, updatedAt: occurrence.createdAt, attempts: 0, error: null,
  }));
  if ((brand ?? settings)?.shareFacebookInstagramContent === true) {
    const shared = publications.filter(post => ['facebook', 'instagram'].includes(post.destination.channel))
      .sort((a, b) => (a.destination.channel === 'facebook' ? 0 : 1) - (b.destination.channel === 'facebook' ? 0 : 1) || a.id.localeCompare(b.id));
    if (shared.length) for (const post of shared) post.sharedGeneration = {
      sourcePublicationId: shared[0].id, memberPublicationIds: shared.map(member => member.id), format: 'facebook-instagram',
    };
  }
  return { occurrence, publications };
}

export function socialPageBounds(offset: number, limit: number) {
  return { offset: Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 100 };
}
