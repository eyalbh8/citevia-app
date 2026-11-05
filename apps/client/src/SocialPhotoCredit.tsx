import type { AgentImage } from '@citevia/core';
import { reportExcerpt } from './report-excerpt';
import { safeUrl } from './components';

export default function SocialPhotoCredit({ photos }: { photos?: AgentImage[] }) {
  if (!photos?.length) return null;
  return <div className="social-photo-credit">{photos.map(photo => <p key={photo.photoId}>Photo by{' '}
    <a href={safeUrl(photo.photographerUrl)} target="_blank" rel="noreferrer noopener">{reportExcerpt(photo.photographer)}</a>{' '}on{' '}
    <a href={safeUrl(photo.photoUrl)} target="_blank" rel="noreferrer noopener">Unsplash</a>
  </p>)}</div>;
}
