import { useState, type CSSProperties } from 'react';
import { domainLogoSources, logoInitials } from './domain-logos';
import './domain-logo.css';

type DomainLogoProps = {
  domain?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
  style?: CSSProperties;
};

/** Decorative beside the visible source/brand name; reserves space while loading. */
export default function DomainLogo(props: DomainLogoProps) {
  const sources = domainLogoSources(
    props.domain,
    import.meta.env.VITE_LOGO_DEV_API_KEY,
  );
  return <LogoImage key={sources.join('|')} {...props} sources={sources} />;
}

function LogoImage({
  domain,
  name,
  size = 28,
  className = '',
  style,
  sources,
}: DomainLogoProps & { sources: string[] }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = sources[attempt];
  return (
    <span
      className={`domain-logo ${className}${loaded ? ' is-loaded' : ''}`}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
    >
      <span className="domain-logo-fallback">{logoInitials(name, domain)}</span>
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy={
            src.startsWith('https://img.logo.dev/') ? 'origin' : 'no-referrer'
          }
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setAttempt((value) => value + 1);
          }}
        />
      )}
    </span>
  );
}
