import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  PROVIDER_LABELS,
  projectProviders,
  type Project,
  type ScanProvider,
} from '@citevia/core';
import './provider-filter.css';

function Icons({ providers }: { providers: ScanProvider[] }) {
  return (
    <span className="provider-filter-icons" aria-hidden="true">
      {providers.map((provider) => (
        <img
          key={provider}
          src={`/providers/${provider}.svg`}
          alt=""
          width="20"
          height="20"
        />
      ))}
    </span>
  );
}

export default function ProviderFilter({
  project,
  value,
  onChange,
  multiple = false,
}: {
  project: Pick<Project, 'scanProviders' | 'generationModel'>;
  value: ScanProvider[];
  onChange: (providers: ScanProvider[]) => void;
  multiple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 230,
    maxHeight: 320,
  });
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const providers = projectProviders(project).map((item) => item.provider);
  const selected = value.filter((provider) => providers.includes(provider));
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const viewportWidth = document.documentElement.clientWidth;
      const width = Math.min(230, viewportWidth - 24);
      const height = Math.min(
        58 + providers.length * 44,
        window.innerHeight - 24,
      );
      const preferredTop =
        bounds.bottom + height + 8 > window.innerHeight &&
        bounds.top > height + 12
          ? bounds.top - height - 8
          : bounds.bottom + 8;
      const top = Math.max(
        12,
        Math.min(preferredTop, window.innerHeight - height - 12),
      );
      setPosition({
        width,
        left: Math.max(12, Math.min(bounds.left, viewportWidth - width - 12)),
        top,
        maxHeight: window.innerHeight - top - 12,
      });
    };
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, providers.length]);
  function choose(next: ScanProvider[]) {
    onChange(next);
    if (!multiple) {
      setOpen(false);
      trigger.current?.focus();
    }
  }
  return (
    <div
      className="provider-filter"
      ref={ref}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`provider-filter-trigger${selected.length ? ' is-filtered' : ''}`}
        aria-label={
          selected.length
            ? `Providers: ${selected.map((provider) => PROVIDER_LABELS[provider]).join(', ')}`
            : 'Providers'
        }
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icons providers={selected.length ? selected : providers} />
        <span>
          {selected.length === 1
            ? PROVIDER_LABELS[selected[0]]
            : selected.length
              ? `${selected.length} providers`
              : 'Providers'}
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          id={id}
          className="provider-filter-menu"
          role="group"
          aria-label="Select AI providers"
          style={position}
        >
          <button
            type="button"
            className={!selected.length ? 'is-selected' : ''}
            onClick={() => choose([])}
          >
            All providers
          </button>
          {providers.map((provider) => (
            <label
              key={provider}
              className={selected.includes(provider) ? 'is-selected' : ''}
            >
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={`${id}-provider`}
                checked={selected.includes(provider)}
                onChange={(event) =>
                  choose(
                    multiple
                      ? event.target.checked
                        ? [...selected, provider]
                        : selected.filter((item) => item !== provider)
                      : [provider],
                  )
                }
              />
              <Icons providers={[provider]} />
              <span>{PROVIDER_LABELS[provider]}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
