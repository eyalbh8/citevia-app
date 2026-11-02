import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SocialPublisherError } from './social-publisher.js';

export const SOCIAL_IMAGE_UPLOAD_LIMIT = 10 * 1024 ** 2;
export const SOCIAL_VIDEO_UPLOAD_LIMIT = 100 * 1024 ** 2;
export interface SocialUploadedMedia {
  id: string; key: string; versionId: string; mimeType: string; size: number;
  type: 'image' | 'video'; url: string;
}
export interface SocialMediaUploadStore {
  start(key: string, mimeType: string, size: number): Promise<{ url: string; fields: Record<string, string> }>;
  complete(key: string, mimeType: string, size: number, id: string): Promise<SocialUploadedMedia>;
  put(key: string, bytes: Uint8Array, mimeType: string, id: string): Promise<SocialUploadedMedia>;
  read(source: SocialUploadedMedia): Promise<Uint8Array>;
  preview(source: SocialUploadedMedia): Promise<string>;
}
export function validateSocialUpload(mimeType: string, size: number): 'image' | 'video' {
  const type = mimeType === 'video/mp4' ? 'video' : 'image';
  if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(mimeType) ||
      !Number.isInteger(size) || size < 12 || size > (type === 'video' ? SOCIAL_VIDEO_UPLOAD_LIMIT : SOCIAL_IMAGE_UPLOAD_LIMIT))
    throw new SocialPublisherError('invalid_media', 'Choose a JPEG, PNG or WebP up to 10 MB, or an MP4 up to 100 MB.', false, false, 400);
  return type;
}
export function validateSocialMediaSignature(bytes: Uint8Array, mimeType: string) {
  const b = Buffer.from(bytes);
  const valid = mimeType === 'image/jpeg' ? b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff :
    mimeType === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
    mimeType === 'image/webp' ? b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' :
    mimeType === 'video/mp4' && b.toString('ascii', 4, 8) === 'ftyp';
  if (!valid) throw new SocialPublisherError('invalid_media', 'The file contents do not match its image or video format.', false, false, 400);
}
/** Version-pinned private objects keep approved bytes immutable even if an upload URL is replayed. */
export class S3SocialMediaUploadStore implements SocialMediaUploadStore {
  constructor(private client: S3Client, private bucket: string, private region: string) {}
  private source(key: string, mimeType: string, size: number, id: string, versionId?: string): SocialUploadedMedia {
    if (!versionId || versionId === 'null') throw new Error('Social media requires versioned private storage.');
    return { id, key, mimeType, size, versionId, type: validateSocialUpload(mimeType, size),
      url: `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}?versionId=${encodeURIComponent(versionId)}` };
  }
  async start(key: string, mimeType: string, size: number) {
    validateSocialUpload(mimeType, size);
    return createPresignedPost(this.client, { Bucket: this.bucket, Key: key, Expires: 600,
      Fields: { 'Content-Type': mimeType, 'x-amz-server-side-encryption': 'AES256' },
      Conditions: [['content-length-range', size, size], ['eq', '$Content-Type', mimeType], ['eq', '$x-amz-server-side-encryption', 'AES256']] });
  }
  async complete(key: string, mimeType: string, size: number, id: string) {
    validateSocialUpload(mimeType, size);
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    if (head.ContentType !== mimeType || head.ContentLength !== size) throw new SocialPublisherError('invalid_media', 'The uploaded file changed or is incomplete. Try uploading it again.', false, false, 400);
    const source = this.source(key, mimeType, size, id, head.VersionId);
    const probe = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: source.versionId, Range: 'bytes=0-63' }));
    if (!probe.Body) throw new Error('Empty uploaded media');
    validateSocialMediaSignature(await probe.Body.transformToByteArray(), mimeType);
    // An upload policy can be replayed for ten minutes. Move the accepted version
    // to a unique server-only key so it never becomes a noncurrent version that
    // the evidence bucket's retention policy can expire before publication.
    const durableKey = `${key}/final/${randomUUID()}`;
    const copied = await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: durableKey,
      CopySource: `${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}?versionId=${encodeURIComponent(source.versionId)}`,
      MetadataDirective: 'REPLACE', ContentType: mimeType, ServerSideEncryption: 'AES256' }));
    return this.source(durableKey, mimeType, size, id, copied.VersionId);
  }
  async put(key: string, bytes: Uint8Array, mimeType: string, id: string) {
    validateSocialUpload(mimeType, bytes.byteLength);
    validateSocialMediaSignature(bytes, mimeType);
    const result = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mimeType, ServerSideEncryption: 'AES256' }));
    return this.source(key, mimeType, bytes.byteLength, id, result.VersionId);
  }
  async read(source: SocialUploadedMedia) {
    if (!source.versionId || source.versionId === 'null') throw new Error('Social media requires versioned private storage.');
    validateSocialUpload(source.mimeType, source.size);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: source.key, VersionId: source.versionId }));
    if (!result.Body || result.ContentLength !== source.size || result.ContentType !== source.mimeType) throw new Error('Stored social media changed');
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength !== source.size) throw new Error('Incomplete stored social media');
    validateSocialMediaSignature(bytes, source.mimeType);
    return bytes;
  }
  preview(source: SocialUploadedMedia) {
    if (!source.versionId || source.versionId === 'null') throw new Error('Social media requires versioned private storage.');
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: source.key, VersionId: source.versionId,
      ResponseContentType: source.mimeType, ResponseContentDisposition: 'inline' }), { expiresIn: 3600 });
  }
}
let cached: SocialMediaUploadStore | undefined;
export function createSocialMediaUploadStore(): SocialMediaUploadStore | undefined {
  const bucket = process.env.EVIDENCE_BUCKET;
  if (!bucket) return undefined;
  return cached ??= new S3SocialMediaUploadStore(new S3Client({ maxAttempts: 3 }), bucket, process.env.AWS_REGION || 'us-east-1');
}
