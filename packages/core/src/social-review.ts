import type { SocialContent, SocialMediaAsset, SocialPublicationStatus } from './social-automation.js';

export interface SharedSocialCreative {
  id: string;
  brandName: string;
  content?: SocialContent;
  media?: SocialMediaAsset[];
  publications: {
    id: string; version: number; channel: 'facebook' | 'instagram'; destination: string;
    scheduledAt: string; status: SocialPublicationStatus | 'changed';
  }[];
}
export interface SharedSocialReview {
  expiresAt: string;
  timezone: string;
  creatives: SharedSocialCreative[];
}
