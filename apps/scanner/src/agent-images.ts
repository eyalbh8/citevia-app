import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import {
  agentImageSchema,
  type AgentImage,
  type AgentPostJob,
} from '@citevia/core';
import { ProviderError } from './provider.js';

export interface AgentImages {
  select(post: AgentPostJob, query: string, alt: string): Promise<AgentImage>;
  track(image: AgentImage): Promise<void>;
}
export function unsplashConfigured() {
  return Boolean(
    process.env.UNSPLASH_ACCESS_KEY?.trim() ||
    process.env.UNSPLASH_SECRET_ARN?.trim(),
  );
}
export async function createAgentImages(): Promise<AgentImages> {
  let key = process.env.UNSPLASH_ACCESS_KEY?.trim();
  if (!key && process.env.UNSPLASH_SECRET_ARN) {
    const value = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: process.env.UNSPLASH_SECRET_ARN }),
    );
    if (value.SecretString) {
      try {
        key = JSON.parse(value.SecretString).UNSPLASH_ACCESS_KEY?.trim();
      } catch {
        key = value.SecretString.trim();
      }
    }
  }
  if (!key)
    throw new ProviderError(
      'unsplash_not_configured',
      'Configure Unsplash before generating posts with images.',
      false,
    );
  return new UnsplashImages(key);
}
export class UnsplashImages implements AgentImages {
  constructor(
    private key: string,
    private request: typeof fetch = fetch,
  ) {}
  private async get(path: string) {
    try {
      const response = await this.request('https://api.unsplash.com' + path, {
        headers: {
          Authorization: 'Client-ID ' + this.key,
          'Accept-Version': 'v1',
        },
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok)
        throw new ProviderError(
          'unsplash_unavailable',
          'Unsplash could not provide an image (' +
            response.status +
            '). Retry generation.',
          false,
        );
      return await response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'unsplash_unavailable',
        'Unsplash could not be reached. Retry generation.',
        false,
      );
    }
  }
  async select(
    post: AgentPostJob,
    query: string,
    alt: string,
  ): Promise<AgentImage> {
    const orientation =
      post.channel === 'instagram'
        ? 'squarish'
        : post.channel === 'pinterest'
          ? 'portrait'
          : 'landscape';
    const params = new URLSearchParams({
      query: query.slice(0, 100),
      per_page: '5',
      orientation,
      content_filter: 'high',
    });
    const result = await this.get('/search/photos?' + params);
    const photo = result.results?.[0];
    if (!photo)
      throw new ProviderError(
        'unsplash_no_photo',
        'No matching Unsplash photo was found. Retry generation.',
        false,
      );
    const referral = '?utm_source=citevia&utm_medium=referral';
    return agentImageSchema.parse({
      url: photo.urls.regular,
      alt: alt.slice(0, 300),
      photoId: photo.id,
      photographer: photo.user.name,
      photographerUrl:
        'https://unsplash.com/@' +
        encodeURIComponent(photo.user.username) +
        referral,
      photoUrl: photo.links.html + referral,
      downloadLocation: photo.links.download_location,
    });
  }
  async track(image: AgentImage) {
    // Construct the official endpoint ourselves: never fetch a model-supplied URL.
    const url = new URL(image.downloadLocation);
    if (
      url.origin !== 'https://api.unsplash.com' ||
      url.pathname !==
        '/photos/' + encodeURIComponent(image.photoId) + '/download'
    )
      throw new ProviderError(
        'unsplash_invalid_photo',
        'Unsplash returned an invalid download endpoint.',
        false,
      );
    await this.get(url.pathname + url.search);
  }
}
