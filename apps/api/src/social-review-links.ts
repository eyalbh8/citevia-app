import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { identifier, publicReportId, resolveReportId, socialPublicationDestinationAssigned, type Project,
  type SharedSocialCreative, type SocialPublication } from '@citevia/core';
import type { Runtime, SocialReviewLink } from '@citevia/storage';
import { approvalHash, approveSocialPublication, editable, fail, fromPreviousBrandPlan, previewSocialMedia, validateContent, validateMedia,
  type SocialReviewServices } from './social-approval.js';
import { enforceApiLimit } from './api-security.js';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
const credentialId = (token: string) => createHash('sha256').update(token).digest('hex');
const unavailable = () => fail(404, 'REVIEW_UNAVAILABLE', 'This review link is unavailable or has expired. Ask the owner for a new link.');
const selectionSchema = z.object({ id: identifier, version: z.number().int().positive() }).strict();
const decisionSchema = selectionSchema.extend({ previewConfirmed: z.literal(true), expressConsentGiven: z.literal(true) });
type SharedVersion = SocialReviewLink['publications'][number];
const meta = (link: SocialReviewLink) => ({ id: link.id, createdAt: link.createdAt, expiresAt: link.expiresAt, publicationCount: link.publications.length });

export async function manageReviewLinks(runtime: Runtime, project: Project, userId: string, tail: string, request: Request, now: Date,
  frontendOrigin: string, body: (request: Request) => Promise<unknown>) {
  if (project.role !== 'owner' || project.demo) return fail(403, 'FORBIDDEN', 'Project owner access is required.');
  const repo = runtime.repository;
  if (tail === 'social/review-links') {
    if (request.method === 'GET') return json({ items: (await repo.listSocialReviewLinks(project.id, now.toISOString())).map(link => ({
      ...meta(link), publications: link.publications.map(({ id, version }) => ({ id, version })),
    })) });
    if (request.method === 'POST') {
      const { publications } = z.object({ publications: z.array(selectionSchema).min(1).max(100) }).strict().parse(await body(request));
      if (new Set(publications.map(p => p.id)).size !== publications.length) return fail(400, 'DUPLICATE_POST', 'Choose each publication once.');
      if (!project.socialAutomation?.enabled) return fail(409, 'AUTOMATION_PAUSED', 'Enable automation before sharing posts.');
      const posts = new Map((await repo.getSocialReviewPosts(project.id, publications.map(p => p.id))).map(p => [p.id, p]));
      const pinned = publications.map(({ id, version }): SharedVersion => {
        const post = posts.get(id);
        if (!post || post.version !== version || post.status !== 'review_required' || !editable(post, now) ||
          !socialPublicationDestinationAssigned(project, post) || fromPreviousBrandPlan(project, post))
          return fail(409, 'POST_CHANGED', 'A selected post or its brand plan changed. Refresh the list and review your selection.');
        const channel = post.destination.channel;
        if (channel !== 'facebook' && channel !== 'instagram') return fail(400, 'INVALID_CHANNEL', 'Choose Facebook or Instagram posts.');
        if (Date.parse(post.scheduledAt) <= now.getTime()) return fail(400, 'PUBLISH_TIME_PASSED', 'Set a future publishing time before sharing.');
        validateContent(post, post.content);
        validateMedia(post);
        return { id, version, contentHash: approvalHash(post), brandName: post.context.socialBrand?.name ?? post.context.brand.name,
          channel, destination: post.destination.username, scheduledAt: post.scheduledAt };
      });
      const token = randomBytes(32).toString('hex');
      const link: SocialReviewLink = { id: credentialId(token), projectId: project.id, createdBy: userId, createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * 86400000).toISOString(), publications: pinned };
      await repo.createSocialReviewLink(link);
      const url = new URL('/', frontendOrigin);
      url.hash = `social-review/${publicReportId(project.id)}/${token}`;
      return json({ ...meta(link), url: url.href }, 201);
    }
  }
  const revoke = /^social\/review-links\/([0-9a-f]{64})$/.exec(tail);
  if (revoke && request.method === 'DELETE' && await repo.revokeSocialReviewLink(project.id, revoke[1])) return json({ revoked: true });
  return unavailable();
}

/** Generated private files may have different object identities per destination even when their bytes match. */
function sameCreative(a: SocialPublication, b: SocialPublication) {
  const shared = a.sharedGeneration, other = b.sharedGeneration;
  if (!shared || !other || a.occurrenceId !== b.occurrenceId || a.context.socialBrand?.id !== b.context.socialBrand?.id ||
    shared.sourcePublicationId !== other.sourcePublicationId || !shared.memberPublicationIds.includes(b.id) || !other.memberPublicationIds.includes(a.id) ||
    !isDeepStrictEqual(a.content, b.content) || !a.media?.length || a.media.length !== b.media?.length) return false;
  return a.media.every((asset, index) => {
    const peer = b.media![index];
    const sameFile = asset.contentDigest && peer.contentDigest
      ? asset.contentDigest === peer.contentDigest : asset.url === peer.url;
    return sameFile && asset.type === peer.type && asset.mimeType === peer.mimeType && isDeepStrictEqual(asset.attribution, peer.attribution);
  });
}

function reviewStatus(project: Project, pinned: SharedVersion, post?: SocialPublication) {
  if (!post || !socialPublicationDestinationAssigned(project, post) || approvalHash(post) !== pinned.contentHash) return 'changed';
  if ((post.status === 'review_required' || post.status === 'scheduled') && fromPreviousBrandPlan(project, post)) return 'changed';
  if (post.version === pinned.version || (post.approval?.contentHash === pinned.contentHash && post.status !== 'review_required')) return post.status;
  return 'changed';
}

async function reviewPreviews(runtime: Runtime, project: Project, link: SocialReviewLink, services: SocialReviewServices) {
  const current = new Map((await runtime.repository.getSocialReviewPosts(project.id, link.publications.map(p => p.id))).map(p => [p.id, p]));
  const groups: { first?: SocialPublication; creative: SharedSocialCreative }[] = [];
  for (const pinned of link.publications) {
    const post = current.get(pinned.id);
    const status = reviewStatus(project, pinned, post);
    const { id, version, channel, destination, scheduledAt, brandName } = pinned;
    const publication: SharedSocialCreative['publications'][number] = { id, version, channel, destination, scheduledAt, status };
    const visible = status !== 'changed' ? post : undefined;
    const match = visible && groups.find(group => group.first && sameCreative(group.first, visible));
    if (match) match.creative.publications.push(publication);
    else groups.push({ first: visible, creative: { id, brandName, content: visible?.content, publications: [publication] } });
  }
  const creatives = await Promise.all(groups.map(async ({ first, creative }) => ({
    ...creative, media: first ? await previewSocialMedia(first, services) : undefined,
  })));
  return json({ expiresAt: link.expiresAt, timezone: project.socialAutomation?.timezone ?? project.timezone, creatives });
}

export const reviewEndpoint = /^\/v1\/social-reviews\/([A-Za-z0-9_-]{1,804})(\/approve)?$/;

/** A separate bearer audience, scoped to the pinned project, versions and review operations. */
export async function clientSocialReview(runtime: Runtime, match: RegExpExecArray, request: Request, now: Date,
  services: SocialReviewServices, body: (request: Request) => Promise<unknown>) {
  const projectId = identifier.parse(resolveReportId(match[1]));
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') || '')?.[1];
  if (!token) return unavailable();
  const link = await runtime.repository.getSocialReviewLink(projectId, credentialId(token), now.toISOString());
  if (!link) return unavailable();
  const project = await runtime.repository.getProject(projectId);
  if (!project || project.demo) return unavailable();
  await enforceApiLimit(runtime.repository, link.id, request.method, now, projectId);
  if (!match[2] && request.method === 'GET') return reviewPreviews(runtime, project, link, services);
  if (match[2] && request.method === 'POST') {
    const { id, ...consent } = decisionSchema.parse(await body(request));
    const pinned = link.publications.find(p => p.id === id && p.version === consent.version);
    if (!pinned) return unavailable();
    const post = await runtime.repository.getSocialPublication(project.id, id);
    const status = reviewStatus(project, pinned, post ?? undefined);
    if (!post || status === 'changed') return fail(409, 'POST_CHANGED', 'This publication changed. Ask the owner for a new review link.');
    // A retry after a lost response reports the actual recorded decision without touching the queue.
    if (post.approval?.contentHash === pinned.contentHash && status !== 'review_required') return json({ id, status });
    const next = await approveSocialPublication(runtime, project, post, `client-review:${link.id}`, now, services, consent, link.id);
    return json({ id, status: next.status }, 202);
  }
  return unavailable();
}
