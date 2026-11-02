import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { S3SocialMediaUploadStore, SOCIAL_IMAGE_UPLOAD_LIMIT, SOCIAL_VIDEO_UPLOAD_LIMIT,
  validateSocialMediaSignature, validateSocialUpload, type SocialUploadedMedia } from './social-uploads.js';

const signing = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: signing.post }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: signing.get }));

const jpeg = new Uint8Array([255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0]);
const source = (patch: Partial<SocialUploadedMedia> = {}): SocialUploadedMedia => ({
  id: 'media-1', key: 'projects/owned/social/post-1/media-1.jpg', versionId: 'version-1', type: 'image',
  mimeType: 'image/jpeg', size: jpeg.byteLength, url: 'https://private.example/media-1.jpg?versionId=version-1', ...patch,
});
const stream = (bytes: Uint8Array) => ({ transformToByteArray: async () => bytes });
function fixture() {
  const send = vi.fn(async (_command: unknown): Promise<Record<string, unknown>> => ({}));
  const client = { send } as unknown as S3Client;
  return { send, client, store: new S3SocialMediaUploadStore(client, 'private-media', 'us-east-1') };
}
beforeEach(() => { signing.post.mockReset(); signing.get.mockReset(); });

describe('private social media uploads', () => {
  it('accepts only supported bounded file types and verifies bytes independently of the filename', () => {
    expect(validateSocialUpload('image/jpeg', SOCIAL_IMAGE_UPLOAD_LIMIT)).toBe('image');
    expect(validateSocialUpload('video/mp4', SOCIAL_VIDEO_UPLOAD_LIMIT)).toBe('video');
    for (const [mime, size] of [['image/jpeg', 11], ['image/jpeg', 12.5], ['image/jpeg', SOCIAL_IMAGE_UPLOAD_LIMIT + 1],
      ['video/mp4', SOCIAL_VIDEO_UPLOAD_LIMIT + 1], ['image/svg+xml', 100], ['text/html', 100]] as const)
      expect(() => validateSocialUpload(mime, size)).toThrow('Choose a JPEG');
    expect(() => validateSocialMediaSignature(jpeg, 'image/jpeg')).not.toThrow();
    expect(() => validateSocialMediaSignature(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), 'image/png')).not.toThrow();
    expect(() => validateSocialMediaSignature(Buffer.from('RIFF0000WEBP'), 'image/webp')).not.toThrow();
    expect(() => validateSocialMediaSignature(Buffer.from('0000ftypisom'), 'video/mp4')).not.toThrow();
    expect(() => validateSocialMediaSignature(Buffer.from('<html>danger</html>'), 'image/jpeg')).toThrow('contents do not match');
    expect(() => validateSocialMediaSignature(jpeg, 'video/mp4')).toThrow('contents do not match');
  });

  it('issues an upload policy restricted to one key, exact size, declared type and encryption', async () => {
    const { store, client, send } = fixture();
    signing.post.mockResolvedValue({ url: 'https://private-media.s3.amazonaws.com', fields: { key: source().key, policy: 'signed-policy' } });
    await store.start(source().key, 'image/jpeg', jpeg.byteLength);
    expect(signing.post).toHaveBeenCalledWith(client, {
      Bucket: 'private-media', Key: source().key, Expires: 600,
      Fields: { 'Content-Type': 'image/jpeg', 'x-amz-server-side-encryption': 'AES256' },
      Conditions: [['content-length-range', 12, 12], ['eq', '$Content-Type', 'image/jpeg'], ['eq', '$x-amz-server-side-encryption', 'AES256']],
    });
    await expect(store.start(source().key, 'image/jpeg', SOCIAL_IMAGE_UPLOAD_LIMIT + 1)).rejects.toThrow();
    expect(signing.post).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('probes the exact uploaded version and copies it to a unique durable object outside the replayable upload key', async () => {
    const { store, send } = fixture();
    send.mockResolvedValueOnce({ ContentType: 'image/jpeg', ContentLength: 12, VersionId: 'version/+1' })
      .mockResolvedValueOnce({ Body: stream(jpeg) })
      .mockResolvedValueOnce({ VersionId: 'durable/+1' });
    const saved = await store.complete('projects/owned/social/post 1/asset.jpg', 'image/jpeg', 12, 'asset');
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[1][0] as GetObjectCommand).input).toEqual({ Bucket: 'private-media', Key: 'projects/owned/social/post 1/asset.jpg', VersionId: 'version/+1', Range: 'bytes=0-63' });
    expect(send.mock.calls[2][0]).toBeInstanceOf(CopyObjectCommand);
    const copy = (send.mock.calls[2][0] as CopyObjectCommand).input;
    expect(copy).toMatchObject({ Bucket: 'private-media', CopySource: 'private-media/projects/owned/social/post%201/asset.jpg?versionId=version%2F%2B1',
      MetadataDirective: 'REPLACE', ContentType: 'image/jpeg', ServerSideEncryption: 'AES256' });
    expect(copy.Key).toMatch(/^projects\/owned\/social\/post 1\/asset\.jpg\/final\/[a-f0-9-]{36}$/);
    expect(saved).toMatchObject({ id: 'asset', key: copy.Key, size: 12, type: 'image', versionId: 'durable/+1' });
    expect(saved.url).toBe(`https://private-media.s3.us-east-1.amazonaws.com/${saved.key.split('/').map(encodeURIComponent).join('/')}?versionId=durable%2F%2B1`);
    expect(saved.url).not.toMatch(/X-Amz|Credential|Signature|token/i);
  });

  it('requires a version receipt for the durable copy and never returns the replayable upload object', async () => {
    const { store, send } = fixture();
    send.mockResolvedValueOnce({ ContentType: 'image/jpeg', ContentLength: 12, VersionId: 'upload-version' })
      .mockResolvedValueOnce({ Body: stream(jpeg) }).mockResolvedValueOnce({});
    await expect(store.complete(source().key, 'image/jpeg', 12, 'asset')).rejects.toThrow('versioned');
    expect(send).toHaveBeenCalledTimes(3);
    expect((send.mock.calls[2][0] as CopyObjectCommand).input.Key).not.toBe(source().key);
  });

  it.each([
    { ContentType: 'video/mp4', ContentLength: 12, VersionId: 'v1' },
    { ContentType: 'image/jpeg', ContentLength: 13, VersionId: 'v1' },
    { ContentType: 'image/jpeg', ContentLength: 12 },
    { ContentType: 'image/jpeg', ContentLength: 12, VersionId: 'null' },
  ])('rejects an incomplete, mismatched or unversioned upload before reading it (%j)', async head => {
    const { store, send } = fixture(); send.mockResolvedValueOnce(head);
    await expect(store.complete(source().key, 'image/jpeg', 12, 'asset')).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported content disguised as a correctly typed object', async () => {
    const { store, send } = fixture();
    send.mockResolvedValueOnce({ ContentType: 'image/jpeg', ContentLength: 12, VersionId: 'v1' })
      .mockResolvedValueOnce({ Body: stream(Buffer.from('<html>bad!!!')) });
    await expect(store.complete(source().key, 'image/jpeg', 12, 'asset')).rejects.toThrow('contents do not match');
  });

  it('stores generated bytes privately with encryption and requires a version receipt', async () => {
    const { store, send } = fixture(); send.mockResolvedValueOnce({ VersionId: 'generated-version' });
    const saved = await store.put(source().key, jpeg, 'image/jpeg', 'generated');
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect((send.mock.calls[0][0] as PutObjectCommand).input).toMatchObject({ Key: source().key, Body: jpeg, ContentType: 'image/jpeg', ServerSideEncryption: 'AES256' });
    expect(saved.versionId).toBe('generated-version');
    send.mockResolvedValueOnce({});
    await expect(store.put(source().key, jpeg, 'image/jpeg', 'generated')).rejects.toThrow('versioned');
  });

  it('reads and previews only the pinned version, ignoring the public-facing URL', async () => {
    const { store, send, client } = fixture();
    send.mockResolvedValueOnce({ ContentType: 'image/jpeg', ContentLength: 12, Body: stream(jpeg) });
    const original = source({ url: 'https://untrusted.example/different-object' });
    expect(await store.read(original)).toEqual(jpeg);
    expect((send.mock.calls[0][0] as GetObjectCommand).input).toEqual({ Bucket: 'private-media', Key: original.key, VersionId: original.versionId });
    signing.get.mockResolvedValue('https://temporary-signed-preview.example');
    expect(await store.preview(original)).toBe('https://temporary-signed-preview.example');
    const [signedClient, command, options] = signing.get.mock.calls[0];
    expect(signedClient).toBe(client);
    expect(command.input).toEqual({ Bucket: 'private-media', Key: original.key, VersionId: original.versionId, ResponseContentType: 'image/jpeg', ResponseContentDisposition: 'inline' });
    expect(options).toEqual({ expiresIn: 3600 });
    expect(original.url).toBe('https://untrusted.example/different-object');
  });

  it.each([
    { ContentType: 'video/mp4', ContentLength: 12, Body: stream(jpeg) },
    { ContentType: 'image/jpeg', ContentLength: 13, Body: stream(jpeg) },
    { ContentType: 'image/jpeg', ContentLength: 12, Body: stream(jpeg.slice(0, 11)) },
    { ContentType: 'image/jpeg', ContentLength: 12 },
  ])('rejects stored media whose headers or bytes changed (%j)', async response => {
    const { store, send } = fixture(); send.mockResolvedValueOnce(response);
    await expect(store.read(source())).rejects.toThrow();
  });

  it.each(['', 'null'])('rejects unpinned reads and previews (%j)', async versionId => {
    const { store, send } = fixture();
    await expect(store.read(source({ versionId }))).rejects.toThrow('version');
    expect(() => store.preview(source({ versionId }))).toThrow('version');
    expect(send).not.toHaveBeenCalled(); expect(signing.get).not.toHaveBeenCalled();
  });
});
