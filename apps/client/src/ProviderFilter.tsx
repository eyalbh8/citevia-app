import {
  PROVIDER_LABELS,
  projectProviders,
  type Project,
  type ScanProvider,
} from '@citevia/core';
import FilterDropdown from './FilterDropdown';
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
  const providers = projectProviders(project).map((item) => item.provider);
  const selected = value.filter((provider) => providers.includes(provider));
  const options = [
    { value: '', label: 'All providers' },
    ...providers.map((provider) => ({
      value: provider,
      label: PROVIDER_LABELS[provider],
      icon: <Icons providers={[provider]} />,
    })),
  ];
  const shared = {
    label: 'Providers',
    className: 'provider-filter-trigger',
    icon: <Icons providers={selected.length ? selected : providers} />,
    displayValue:
      selected.length === 1
        ? PROVIDER_LABELS[selected[0]]
        : selected.length
          ? `${selected.length} providers`
          : 'Providers',
    options,
  };
  return multiple ? (
    <FilterDropdown
      {...shared}
      multiple
      value={selected}
      onChange={(next) => onChange(next as ScanProvider[])}
    />
  ) : (
    <FilterDropdown
      {...shared}
      value={selected[0] || ''}
      onChange={(next) => onChange(next ? [next as ScanProvider] : [])}
    />
  );
}
