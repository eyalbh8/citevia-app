import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_SOCIAL_PUBLICATION_STATUSES, socialApprovalSnapshot, type Project, type SocialChannel, type SocialDestination, type SocialPublication } from '@citevia/core';
import { MemoryArtifacts, MemoryQueue, MemoryRepository, SocialPublisherError, type SocialPublisher, type SocialMediaUploadStore } from '@citevia/storage';
import { newProject } from '../../../tests/fixtures/scanner.js';
import { SocialAutomationEngine } from './social-automation.js';
import type { SocialBrandStyle, SocialGeneratedCopy, SocialGeneratedImage, SocialMediaGenerator } from './social-media.js';

const initialTime = '2026-11-02T09:00:00.000Z'; // Monday
const prompt = 'How can a team choose useful reporting metrics?';
const style: SocialBrandStyle = { summary: 'Blue diagrams', palette: ['#112266'], typography: 'Clear sans serif', composition: 'One focal diagram', voice: 'Helpful', referenceImageUrls: ['https://images.example.com/prior.jpg'], evidence: [{ postId: 'old-post' }], source: 'connected-feed', capturedAt: initialTime, requestId: 'style-call' };
const image: SocialGeneratedImage = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', width: 1024, height: 1280, requestId: 'image-call' };
const copy = (channel: SocialChannel): SocialGeneratedCopy => ({
  title: `${channel} reporting advice`, body: `Choose metrics that answer the business question. ${channel === 'instagram' ? 'Link in bio.' : ''}`.trim(), hashtags: channel === 'reddit' ? [] : ['#Reporting'],
  slides: Array.from({ length: ['instagram', 'tiktok'].includes(channel) ? 3 : 1 }, (_, index) => ({ heading: `Step ${index + 1}`, body: 'Start with the question.', imagePrompt: `A business diagram, slide ${index + 1}.` })),
  format: channel === 'instagram' ? 'carousel' : channel === 'tiktok' ? 'video' : 'image',
});

async function fixture(channels: SocialChannel[] = ['facebook'], createBlogDrafts = false, usePrivateMedia = true) {
  let clock = new Date(initialTime);
  const repository = new MemoryRepository(), artifacts = new MemoryArtifacts(), queue = new MemoryQueue();
  const destinationOptions: NonNullable<Project['socialDestinationOptions']> = {};
  if (channels.includes('pinterest')) destinationOptions['pinterest-account'] = { boardId: 'board-one' };
  if (channels.includes('reddit')) destinationOptions['reddit-account'] = { subreddit: 'analytics', flairId: 'flair-one' };
  const project: Project = { ...newProject({ id: 'social-project', prompts: [prompt], now: clock }), socialProfileId: 'profile-one',
    socialAutomation: { enabled: true, createBlogDrafts, revision: 1, timezone: 'UTC', slots: [{ id: 'monday', dayOfWeek: 1, time: '09:00' }], effectiveFrom: '2026-11-01T00:00:00.000Z', scheduleStatus: 'synced' },
    socialDestinationOptions: destinationOptions };
  await repository.saveProject(project, null);
  const destinations: SocialDestination[] = channels.map(channel => ({ id: `${channel}-account`, channel, username: `acme-${channel}`, profileId: 'profile-one', active: true, requiresReconnect: false }));
  const publisher = {
    ensureProfile: vi.fn<SocialPublisher['ensureProfile']>().mockResolvedValue('profile-one'),
    connectUrl: vi.fn<SocialPublisher['connectUrl']>().mockResolvedValue('https://example.com/connect'),
    accounts: vi.fn<SocialPublisher['accounts']>().mockImplementation(async () => structuredClone(destinations)),
    recentPosts: vi.fn<SocialPublisher['recentPosts']>().mockResolvedValue([{ id: 'old-post', text: 'Previous business advice.', imageUrls: ['https://images.example.com/prior.jpg'] }]),
    uploadMedia: vi.fn<SocialPublisher['uploadMedia']>().mockImplementation(async filename => ({ url: `https://media.zernio.com/${filename}` })),
    publish: vi.fn<SocialPublisher['publish']>().mockImplementation(async (_profile, destination) => ({ providerPostId: `provider-${destination.id}`, status: 'published', url: `https://social.example.com/${destination.id}/post` })),
    getPost: vi.fn<SocialPublisher['getPost']>().mockResolvedValue({ providerPostId: 'provider-one', status: 'published', url: 'https://social.example.com/post' }),
    tiktokCreatorInfo: vi.fn<SocialPublisher['tiktokCreatorInfo']>().mockResolvedValue({ privacyLevels: ['PUBLIC_TO_EVERYONE'], maxVideoDurationSec: 600, canPostMore: true, interactions: { allowComment: true, allowDuet: false, allowStitch: false } }),
    tiktokMusic: vi.fn<SocialPublisher['tiktokMusic']>().mockResolvedValue([{ id: 'music-one', name: 'Business soundtrack', artist: 'Licensed artist' }]),
    pinterestBoards: vi.fn<SocialPublisher['pinterestBoards']>().mockResolvedValue([{ id: 'board-one', name: 'Reporting' }]),
  };
  const generator = {
    analyzeStyle: vi.fn<SocialMediaGenerator['analyzeStyle']>().mockResolvedValue(style),
    generateCopy: vi.fn<SocialMediaGenerator['generateCopy']>().mockImplementation(async (_project, _prompt, destination) => copy(destination.channel)),
    generateImage: vi.fn<SocialMediaGenerator['generateImage']>().mockImplementation(async () => ({ ...image, bytes: new Uint8Array(image.bytes) })),
    checkImage: vi.fn<SocialMediaGenerator['checkImage']>().mockResolvedValue(undefined),
    videoReady: vi.fn<SocialMediaGenerator['videoReady']>().mockResolvedValue(true),
    renderVideo: vi.fn<SocialMediaGenerator['renderVideo']>().mockResolvedValue({ bytes: new Uint8Array([4, 5, 6]), mime: 'video/mp4', width: 720, height: 1280, durationSeconds: 18, hasAudio: false }),
  };
  const publisherFactory = vi.fn(async () => publisher), generatorFactory = vi.fn(async () => generator);
  const privateMedia = new Map<string, Uint8Array>();
  const uploadStore = {
    start: vi.fn<SocialMediaUploadStore['start']>().mockResolvedValue({ url: 'https://private.example.com/upload', fields: {} }),
    complete: vi.fn<SocialMediaUploadStore['complete']>(),
    put: vi.fn<SocialMediaUploadStore['put']>().mockImplementation(async (key, bytes, mimeType, id) => {
      const versionId = String(privateMedia.size + 1);
      privateMedia.set(`${key}:${versionId}`, new Uint8Array(bytes));
      return { id, key, versionId, mimeType, size: bytes.length, type: mimeType === 'video/mp4' ? 'video' : 'image', url: `https://private.example.com/${key}?versionId=${versionId}` };
    }),
    read: vi.fn<SocialMediaUploadStore['read']>().mockImplementation(async source => {
      const bytes = privateMedia.get(`${source.key}:${source.versionId}`);
      if (!bytes) throw new Error('Missing versioned media');
      return new Uint8Array(bytes);
    }),
    preview: vi.fn<SocialMediaUploadStore['preview']>().mockImplementation(async source => `${source.url}&signature=preview`),
  };
  const inspectVideo = vi.fn(async (_bytes: Uint8Array) => ({ durationSeconds: 18, width: 1080, height: 1920 }));
  const runtime = { repository, artifacts, queue };
  const worker = new SocialAutomationEngine(runtime, publisherFactory, generatorFactory, () => new Date(clock), undefined, () => usePrivateMedia ? uploadStore : undefined, inspectVideo);
  const message = { kind: 'social-occurrence' as const, projectId: project.id, revision: 1, slotId: 'monday', scheduledAt: initialTime };
  await worker.handleOccurrence(message);
  const publications = (await repository.listSocialPublications(project.id, 0, 50)).items;
  const read = async (id = publications[0].id) => (await repository.getSocialPublication(project.id, id))!;
  const advanceClock = (seconds = 60) => { clock = new Date(clock.getTime() + seconds * 1000); };
  const update = async (patch: Partial<SocialPublication>, id = publications[0].id) => {
    const current = await read(id);
    expect(await repository.saveSocialPublication({ ...current, ...patch, version: current.version + 1 }, current.version)).toBe(true);
    return read(id);
  };
  const approve = async (id = publications[0].id, extra: Partial<NonNullable<SocialPublication['approval']>> = {}) => {
    const post = await read(id);
    return update({ status: 'scheduled', stage: 'publish', nextAttemptAt: post.scheduledAt, approval: { approvedBy: 'owner', approvedAt: clock.toISOString(), previewConfirmed: true, expressConsentGiven: true, contentHash: createHash('sha256').update(socialApprovalSnapshot(post)).digest('hex'), ...extra } }, id);
  };
  const updateProject = async (patch: Partial<Project>) => {
    const current = (await repository.getProject(project.id))!;
    expect(await repository.saveProject({ ...current, ...patch, version: current.version + 1 }, current.version)).toBe(true);
  };
  const runTo = async (predicate: (post: SocialPublication) => boolean, id = publications[0].id) => {
    for (let count = 0; count < 40; count++) {
      const current = await read(id);
      if (predicate(current)) return current;
      if (!ACTIVE_SOCIAL_PUBLICATION_STATUSES.includes(current.status)) throw new Error(`Publication stopped at ${current.status}/${current.stage}: ${current.error?.message}`);
      if (Date.parse(current.nextAttemptAt || '') > clock.getTime()) advanceClock(60);
      await worker.handlePublication(project.id, id);
    }
    throw new Error('Publication did not reach the requested stage');
  };
  const finish = (id = publications[0].id) => runTo(post => !ACTIVE_SOCIAL_PUBLICATION_STATUSES.includes(post.status), id);
  return { runtime, project, publications, publisher, generator, publisherFactory, generatorFactory, worker, message, read, update, updateProject, advanceClock, runTo, finish, approve, uploadStore, inspectVideo };
}

describe('scheduled social generation', () => {
  it('requires review of every connected image platform before publishing its own copy and assets', async () => {
    const channels = ['facebook', 'instagram', 'linkedin', 'x', 'pinterest', 'reddit'] as const;
    const f = await fixture([...channels]);
    for (const post of f.publications) expect((await f.finish(post.id)).status).toBe('review_required');
    expect(f.publisher.publish).not.toHaveBeenCalled();
    for (const post of f.publications) { await f.approve(post.id); expect((await f.finish(post.id)).status).toBe('published'); }
    expect(f.publisher.publish).toHaveBeenCalledTimes(channels.length);
    expect(f.generator.analyzeStyle).toHaveBeenCalledTimes(channels.length);
    expect(f.generator.generateImage).toHaveBeenCalledTimes(8); // Instagram has 3; the others have 1.
    expect(f.generator.checkImage).toHaveBeenCalledTimes(8);
    expect(f.publisher.uploadMedia).toHaveBeenCalledTimes(8);
    for (const [, destination, payload, key] of f.publisher.publish.mock.calls) {
      expect(key).toMatch(/^[a-f0-9-]{36}$/);
      expect(payload.media).toHaveLength(destination.channel === 'instagram' ? 3 : 1);
      expect(payload.text).toContain('Choose metrics that answer the business question.');
      if (destination.channel === 'instagram') expect(payload).toMatchObject({ platformSpecificData: { isAiGenerated: true } });
      if (destination.channel === 'pinterest') expect(payload).toMatchObject({ platformSpecificData: { boardId: 'board-one' } });
      if (destination.channel === 'reddit') expect(payload).toMatchObject({ platformSpecificData: { subreddit: 'analytics', flairId: 'flair-one' } });
    }
    expect(f.generator.generateCopy.mock.calls.every(([, savedPrompt]) => savedPrompt.text === prompt && savedPrompt.id === 'p_01')).toBe(true);
    expect(f.generator.checkImage.mock.calls[0][5]).toMatchObject({ mime: 'image/jpeg', bytes: Buffer.from(image.bytes) });
  });

  it('deduplicates repeated occurrences and completed queue deliveries', async () => {
    const f = await fixture();
    await f.worker.handleOccurrence(f.message);
    expect((await f.runtime.repository.listSocialPublications(f.project.id, 0, 50)).total).toBe(1);
    await f.finish();
    await f.approve();
    await f.finish();
    await f.worker.handlePublication(f.project.id, f.publications[0].id);
    await f.worker.handleOccurrence(f.message);
    expect(f.publisher.publish).toHaveBeenCalledTimes(1);
    expect(f.generator.generateCopy).toHaveBeenCalledTimes(1);
    expect(f.generator.generateImage).toHaveBeenCalledTimes(1);
  });

  it('does not charge again when a stage receipt survived a failed state transition', async () => {
    const f = await fixture();
    const save = f.runtime.repository.saveSocialPublication.bind(f.runtime.repository);
    let interrupted = false;
    vi.spyOn(f.runtime.repository, 'saveSocialPublication').mockImplementation(async (post, version) => {
      if (!interrupted && post.stage === 'copy') { interrupted = true; return false; }
      return save(post, version);
    });
    await f.worker.handlePublication(f.project.id, f.publications[0].id);
    expect(f.generator.analyzeStyle).toHaveBeenCalledTimes(1);
    expect((await f.read()).stage).toBe('queued');
    f.advanceClock(7 * 60);
    await f.finish();
    await f.approve();
    await f.finish();
    expect(f.generator.analyzeStyle).toHaveBeenCalledTimes(1);
    expect(f.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('stops a paid image call with an uncertain result instead of regenerating it', async () => {
    const f = await fixture();
    await f.runTo(post => post.stage === 'image-0');
    f.generator.generateImage.mockRejectedValueOnce(new SocialPublisherError('provider_timeout', 'The image response was lost.', true, true));
    await f.worker.handlePublication(f.project.id, f.publications[0].id);
    f.advanceClock();
    const stopped = await f.finish();
    expect(stopped).toMatchObject({ status: 'failed', error: { code: 'generation_uncertain' } });
    expect(f.generator.generateImage).toHaveBeenCalledTimes(1);
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it('does not upload or publish an image that fails visual QA', async () => {
    const f = await fixture();
    f.generator.checkImage.mockRejectedValueOnce(new Error('Text not readable and does not answer the prompt'));
    expect((await f.finish()).status).toBe('failed');
    expect(f.generator.checkImage).toHaveBeenCalledTimes(1);
    expect(f.publisher.uploadMedia).not.toHaveBeenCalled();
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it('cancels before publication when the user disables automation', async () => {
    const f = await fixture();
    await f.runTo(post => post.stage === 'publish');
    await f.updateProject({ socialAutomation: { ...f.project.socialAutomation!, enabled: false, revision: 2 } });
    expect(await f.finish()).toMatchObject({ status: 'cancelled', error: { code: 'automation_paused' } });
    expect((await f.read()).media).toHaveLength(1);
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it.each(['media upload', 'TikTok options'] as const)('honors a pause while awaiting %s before sending the public request', async stage => {
    const f = await fixture([stage === 'TikTok options' ? 'tiktok' : 'facebook']);
    await f.finish();
    await f.approve(undefined, stage === 'TikTok options' ? {
      privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, musicSoundId: 'music-one',
    } : {});
    const pause = () => f.updateProject({ socialAutomation: { ...f.project.socialAutomation!, enabled: false, revision: 2 } });
    if (stage === 'media upload') f.publisher.uploadMedia.mockImplementationOnce(async filename => {
      await pause();
      return { url: `https://media.zernio.com/${filename}` };
    });
    else f.publisher.tiktokMusic.mockImplementationOnce(async () => {
      await pause();
      return [{ id: 'music-one', name: 'Business soundtrack', artist: 'Licensed artist' }];
    });
    expect(await f.finish()).toMatchObject({ status: 'cancelled', error: { code: 'automation_paused' } });
    expect((await f.read()).publishAttemptAt).toBeUndefined();
    expect((await f.read()).media).toHaveLength(1);
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it('cancels a disconnected destination before any paid generation', async () => {
    const f = await fixture();
    f.publisher.accounts.mockResolvedValue([]);
    expect(await f.finish()).toMatchObject({ status: 'cancelled', error: { code: 'account_disconnected' } });
    expect(f.generator.analyzeStyle).not.toHaveBeenCalled();
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it('fails visibly before generation when a board or community is missing', async () => {
    const f = await fixture(['pinterest']);
    await f.updateProject({ socialDestinationOptions: {} });
    const post = await f.read();
    if (post.destination.channel === 'blog') throw new Error('Expected a social destination');
    await f.update({ destination: { ...post.destination, options: undefined } });
    expect(await f.finish()).toMatchObject({ status: 'failed', error: { code: 'destination_required' } });
    expect(f.generator.analyzeStyle).not.toHaveBeenCalled();
  });
});

describe('publication delivery recovery', () => {
  it('keeps a prior unknown request uncertain if a pause occurs during retry preparation', async () => {
    const f = await fixture(['tiktok']);
    await f.finish();
    await f.approve(undefined, { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, musicSoundId: 'music-one' });
    f.publisher.publish.mockRejectedValueOnce(new SocialPublisherError('publisher_timeout', 'No confirmed response.', true, true));
    await f.runTo(post => Boolean(post.publishAttemptAt));
    f.publisher.tiktokMusic.mockImplementationOnce(async () => {
      await f.updateProject({ socialAutomation: { ...f.project.socialAutomation!, enabled: false, revision: 2 } });
      return [{ id: 'music-one', name: 'Business soundtrack', artist: 'Licensed artist' }];
    });
    expect(await f.finish()).toMatchObject({ status: 'uncertain', error: { code: 'automation_paused' } });
    expect(f.publisher.publish).toHaveBeenCalledTimes(1);
  });
  it('keeps the reserved board when preferences change during an uncertain publish retry', async () => {
    const f = await fixture(['pinterest']);
    await f.finish();
    await f.approve();
    f.publisher.publish.mockRejectedValueOnce(new SocialPublisherError('publisher_timeout', 'No confirmed response.', true, true));
    await f.runTo(post => Boolean(post.publishAttemptAt));
    await f.updateProject({ socialDestinationOptions: { 'pinterest-account': { boardId: 'different-board' } } });
    expect((await f.finish()).status).toBe('published');
    expect(f.publisher.publish).toHaveBeenCalledTimes(2);
    expect(f.publisher.publish.mock.calls[0][2]).toEqual(f.publisher.publish.mock.calls[1][2]);
    expect(f.publisher.publish.mock.calls[1][2].platformSpecificData).toEqual({ boardId: 'board-one' });
  });

  it('retries an unknown publish outcome with the same idempotency key and no new generation', async () => {
    const f = await fixture();
    await f.finish();
    await f.approve();
    f.publisher.publish.mockRejectedValueOnce(new SocialPublisherError('publisher_timeout', 'No confirmed response.', true, true));
    expect((await f.finish()).status).toBe('published');
    expect(f.publisher.publish).toHaveBeenCalledTimes(2);
    expect(f.publisher.publish.mock.calls[0][3]).toBe(f.publisher.publish.mock.calls[1][3]);
    expect(f.publisher.publish.mock.calls[0][2]).toEqual(f.publisher.publish.mock.calls[1][2]);
    expect(f.generator.generateCopy).toHaveBeenCalledTimes(1);
    expect(f.generator.generateImage).toHaveBeenCalledTimes(1);
  });

  it('polls a pending provider post instead of resubmitting it, including after pausing', async () => {
    const f = await fixture();
    await f.finish();
    await f.approve();
    f.publisher.publish.mockResolvedValue({ providerPostId: 'provider-one', status: 'publishing' });
    await f.runTo(post => post.status === 'publishing');
    await f.updateProject({ socialAutomation: { ...f.project.socialAutomation!, enabled: false, revision: 2 } });
    expect((await f.finish()).status).toBe('published');
    expect(f.publisher.publish).toHaveBeenCalledTimes(1);
    expect(f.publisher.getPost).toHaveBeenCalledExactlyOnceWith('profile-one', 'facebook-account', 'provider-one');
  });

  it('uses a durable publication receipt if the final state write is interrupted', async () => {
    const f = await fixture();
    await f.finish();
    await f.approve();
    const save = f.runtime.repository.saveSocialPublication.bind(f.runtime.repository);
    let interrupted = false;
    vi.spyOn(f.runtime.repository, 'saveSocialPublication').mockImplementation(async (post, version) => {
      if (!interrupted && post.status === 'published') { interrupted = true; return false; }
      return save(post, version);
    });
    await f.runTo(post => Boolean(post.publishAttemptAt));
    f.advanceClock(7 * 60);
    expect((await f.finish()).status).toBe('published');
    expect(f.publisher.publish).toHaveBeenCalledTimes(1);
    expect(f.publisher.getPost).not.toHaveBeenCalled();
  });
});

describe('reviewed publishing calendar', () => {
  it.each([{ order: [2, 0, 1] }, { order: [2, 0] }])('publishes the reviewed legacy carousel order $order after reordering or removing slides', async ({ order }) => {
    const f = await fixture(['instagram'], false, false);
    f.generator.generateImage.mockImplementation(async (_project, _prompt, _copy, _destination, _style, index) => ({
      ...image, bytes: new Uint8Array([index + 1, 20, 30]),
    }));
    await f.finish();
    const original = (await f.read()).media!;
    expect(original.every(asset => !asset.id)).toBe(true);
    await f.update({ media: order.map(index => original[index]) });
    await f.approve();
    f.publisher.uploadMedia.mockClear();
    expect((await f.finish()).status).toBe('published');
    expect(f.publisher.uploadMedia.mock.calls.map(call => [...call[1]])).toEqual(order.map(index => [index + 1, 20, 30]));
    expect(f.publisher.publish.mock.calls[0][2].media).toHaveLength(order.length);
    expect(f.generator.generateImage).toHaveBeenCalledTimes(3);
  });

  it('keeps approved posts waiting until the exact publishing time, including premature queue deliveries', async () => {
    const f = await fixture();
    expect((await f.finish()).status).toBe('review_required');
    const scheduledAt = '2026-11-02T10:00:00.000Z';
    await f.update({ scheduledAt });
    await f.approve();
    await f.worker.handlePublication(f.project.id, f.publications[0].id);
    expect(f.publisher.publish).not.toHaveBeenCalled();
    f.runtime.queue.messages.length = 0;
    await f.worker.reconcile();
    expect(f.runtime.queue.messages).toEqual([]);
    // A stale queue writer cannot defeat the worker's scheduledAt boundary.
    await f.update({ nextAttemptAt: undefined, status: 'queued' });
    await f.worker.handlePublication(f.project.id, f.publications[0].id);
    expect(await f.read()).toMatchObject({ status: 'scheduled', nextAttemptAt: scheduledAt });
    expect(f.publisher.publish).not.toHaveBeenCalled();
    f.advanceClock(3600);
    await f.worker.reconcile();
    expect(f.runtime.queue.messages).toContainEqual({ kind: 'social-publication', projectId: f.project.id, publicationId: f.publications[0].id });
    expect((await f.finish()).status).toBe('published');
    expect(f.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('publishes edited text and media rather than the original generation receipt', async () => {
    const f = await fixture();
    await f.finish();
    const content = { title: 'Reviewed title', body: 'The owner corrected this answer.', hashtags: ['#Reviewed'] };
    const source = await f.uploadStore.put(`projects/${f.project.id}/social/${f.publications[0].id}/media/replacement`, new Uint8Array([8, 9, 10]), 'image/png', 'replacement');
    const media = [{ id: source.id, type: 'image' as const, mimeType: source.mimeType, url: source.url }];
    await f.update({ content, media, checkpoints: { ...(await f.read()).checkpoints, mediaSources: { [source.id]: source } } });
    await f.approve();
    expect((await f.finish()).status).toBe('published');
    expect(f.publisher.publish.mock.calls[0][2]).toMatchObject({ title: content.title, text: `${content.body}\n\n#Reviewed`, media: [{ type: 'image', url: expect.stringContaining('media.zernio.com') }] });
    expect(f.publisher.uploadMedia.mock.calls[0][1]).toEqual(new Uint8Array([8, 9, 10]));
    expect(f.generator.generateCopy).toHaveBeenCalledTimes(1);
    expect(f.generator.generateImage).toHaveBeenCalledTimes(1);
  });

  it.each(['content', 'media', 'scheduledAt'] as const)('invalidates approval when %s changes, even if an old approval is accidentally retained', async field => {
    const f = await fixture();
    await f.finish();
    await f.approve();
    const patch: Partial<SocialPublication> = field === 'content'
      ? { content: { title: 'Changed', body: 'Unapproved edit', hashtags: [] } }
      : field === 'media' ? { media: [{ type: 'image', mimeType: 'image/png', url: 'https://media.zernio.com/unapproved.png' }] }
        : { scheduledAt: '2026-11-02T08:59:00.000Z' };
    await f.update(patch);
    expect((await f.finish()).status).toBe('review_required');
    expect((await f.read()).approval).toBeUndefined();
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it('does not trust a legacy approval without an exact reviewed-content fingerprint', async () => {
    const f = await fixture();
    await f.finish();
    await f.update({ status: 'queued', approval: { approvedBy: 'owner', approvedAt: initialTime, previewConfirmed: true, expressConsentGiven: true } });
    expect((await f.finish()).status).toBe('review_required');
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it('can review a monthly draft well after its generation day', async () => {
    const f = await fixture();
    await f.finish();
    await f.update({ scheduledAt: '2026-11-25T09:00:00.000Z' });
    f.advanceClock(23 * 86400);
    await f.approve();
    expect((await f.finish()).status).toBe('published');
    expect(f.generator.generateCopy).toHaveBeenCalledTimes(1);
    expect(f.uploadStore.read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'image-0', versionId: '1' }));
    expect(f.publisher.uploadMedia).toHaveBeenCalledTimes(1);
    expect(f.publisher.publish.mock.calls[0][2].media[0].url).not.toContain('private.example.com');
  });
});

describe('daily, weekly and monthly preparation', () => {
  it.each([
    ['daily', 1], ['weekly', 7], ['monthly', 29],
  ] as const)('prepares all remaining %s publishing slots exactly once', async (generationCadence, count) => {
    const f = await fixture();
    await f.updateProject({ socialAutomation: { ...f.project.socialAutomation!, generationCadence, generationTime: '08:00',
      slots: Array.from({ length: 7 }, (_, dayOfWeek) => ({ id: `day-${dayOfWeek}`, dayOfWeek, time: '10:00' })) } });
    const message = { kind: 'social-generation' as const, projectId: f.project.id, revision: 1, scheduledAt: initialTime, trigger: 'manual' as const };
    await f.worker.handleGeneration(message);
    await f.worker.handleGeneration(message);
    const posts = (await f.runtime.repository.listSocialPublications(f.project.id, 0, 100)).items.filter(post => post.id !== f.publications[0].id);
    expect(posts).toHaveLength(count);
    expect(posts.every(post => Date.parse(post.scheduledAt) > Date.parse(initialTime))).toBe(true);
    expect(new Set(posts.map(post => post.occurrenceId)).size).toBe(count);
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.generator.generateCopy).not.toHaveBeenCalled();
  });

  it('does not prepare any content for stale or paused generation events', async () => {
    const f = await fixture();
    const message = { kind: 'social-generation' as const, projectId: f.project.id, revision: 1, scheduledAt: initialTime, trigger: 'manual' as const };
    await f.worker.handleGeneration({ ...message, revision: 2 });
    await f.updateProject({ socialAutomation: { ...f.project.socialAutomation!, enabled: false } });
    await f.worker.handleGeneration(message);
    expect((await f.runtime.repository.listSocialPublications(f.project.id, 0, 100)).total).toBe(1);
    expect(f.publisher.accounts).toHaveBeenCalledTimes(1);
  });
});

describe('TikTok reviews', () => {
  it('renders a real MP4 and stops for review without publishing', async () => {
    const f = await fixture(['tiktok']);
    const stopped = await f.finish();
    expect(stopped.status).toBe('review_required');
    expect(stopped.media).toEqual([{ id: 'video', type: 'video', mimeType: 'video/mp4', url: expect.stringContaining('private.example.com') }]);
    expect(f.generator.generateImage).toHaveBeenCalledTimes(3);
    expect(f.generator.checkImage).toHaveBeenCalledTimes(3);
    expect(f.generator.renderVideo).toHaveBeenCalledTimes(1);
    expect(f.publisher.uploadMedia).not.toHaveBeenCalled();
    expect(f.uploadStore.put).toHaveBeenCalledTimes(1);
    expect(f.uploadStore.put.mock.calls[0][2]).toBe('video/mp4');
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it('publishes the reviewed video with the selected licensed soundtrack and AI disclosure', async () => {
    const f = await fixture(['tiktok']);
    await f.finish();
    await f.approve(undefined, { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, musicSoundId: 'music-one' });
    expect((await f.finish()).status).toBe('published');
    expect(f.publisher.publish).toHaveBeenCalledTimes(1);
    expect(f.publisher.publish.mock.calls[0][2]).toMatchObject({
      tiktokApproval: { previewConfirmed: true, expressConsentGiven: true, allowDuet: false },
      platformSpecificData: { videoMadeWithAi: true, musicSoundInfo: { musicSoundId: 'music-one' } },
      media: [{ type: 'video' }],
    });
    expect(f.generator.generateImage).toHaveBeenCalledTimes(3);
    expect(f.generator.renderVideo).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate consent from an incomplete persisted approval', async () => {
    const f = await fixture(['tiktok']);
    await f.finish();
    await f.update({ status: 'queued', approval: { approvedBy: 'owner', approvedAt: initialTime, previewConfirmed: false, expressConsentGiven: false, privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, musicSoundId: 'music-one' } });
    await f.finish();
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });

  it('checks the actual replacement video duration against current creator limits', async () => {
    const f = await fixture(['tiktok']);
    await f.finish();
    const source = await f.uploadStore.put(`projects/${f.project.id}/social/${f.publications[0].id}/media/replacement`, new Uint8Array([7, 8, 9]), 'video/mp4', 'replacement');
    await f.update({ media: [{ id: source.id, type: 'video', mimeType: source.mimeType, url: source.url }],
      checkpoints: { ...(await f.read()).checkpoints, mediaSources: { [source.id]: source }, videoDuration: 18 } });
    f.inspectVideo.mockResolvedValue({ durationSeconds: 650, width: 1080, height: 1920 });
    await f.approve(undefined, { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, musicSoundId: 'music-one' });
    expect(await f.finish()).toMatchObject({ status: 'review_required', error: { code: 'tiktok_options_changed' } });
    expect(f.inspectVideo).toHaveBeenCalledExactlyOnceWith(new Uint8Array([7, 8, 9]));
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect((await f.read()).approval).toBeUndefined();
  });

  it('returns an invalid replacement video to review so it can be corrected', async () => {
    const f = await fixture(['tiktok']);
    await f.finish();
    f.inspectVideo.mockRejectedValue(new Error('Malformed video stream'));
    await f.approve(undefined, { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, musicSoundId: 'music-one' });
    expect(await f.finish()).toMatchObject({ status: 'review_required', error: { code: 'review_media_invalid' } });
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it('returns a TikTok post to review when its selected music is no longer available', async () => {
    const f = await fixture(['tiktok']);
    await f.finish();
    await f.approve(undefined, { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, musicSoundId: 'music-one' });
    f.publisher.tiktokMusic.mockResolvedValue([]);
    const post = await f.finish();
    expect(post).toMatchObject({ status: 'review_required', error: { code: 'tiktok_options_changed' } });
    expect(post.approval).toBeUndefined();
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.generator.generateImage).toHaveBeenCalledTimes(3);
  });

  it('does not generate a TikTok package without a video renderer', async () => {
    const f = await fixture(['tiktok']);
    f.generator.videoReady.mockResolvedValue(false);
    expect(await f.finish()).toMatchObject({ status: 'failed', error: { code: 'video_not_configured' } });
    expect(f.generator.generateImage).not.toHaveBeenCalled();
    expect(f.publisher.publish).not.toHaveBeenCalled();
  });
});

describe('scheduled blog drafts', () => {
  it('queues the existing draft engine and never publishes the blog', async () => {
    const f = await fixture([], true);
    expect(f.publications).toHaveLength(1);
    await f.worker.handlePublication(f.project.id, f.publications[0].id);
    const waiting = await f.read();
    expect(waiting.destination.channel).toBe('blog');
    expect(waiting.draftPostId).toBeTruthy();
    const draft = (await f.runtime.repository.getAgentPost(f.project.id, waiting.draftPostId!))!;
    expect(draft).toMatchObject({ channel: 'blog', status: 'queued', promptId: 'p_01', prompt, socialAutomation: { publicationId: waiting.id, revision: 1 } });
    expect(f.runtime.queue.messages).toContainEqual({ kind: 'agent-post', projectId: f.project.id, postId: draft.id });
    expect(await f.runtime.repository.saveAgentPost({ ...draft, status: 'draft', version: draft.version + 1 }, draft.version)).toBe(true);
    f.advanceClock();
    expect(await f.finish()).toMatchObject({ status: 'draft_created', draftPostId: draft.id });
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.generatorFactory).not.toHaveBeenCalled();
    expect(f.publisherFactory).toHaveBeenCalledTimes(1); // The initial occurrence discovers social accounts only.
  });
});
