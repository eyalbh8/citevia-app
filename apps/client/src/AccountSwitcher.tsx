import type { Project } from '@citevia/core';
import DomainLogo from './DomainLogo';
import FilterDropdown from './FilterDropdown';
import { logoDomain } from './domain-logos';
import './account-switcher.css';

type Props = {
  projects: Project[];
  project?: Project;
  onChange: (id: string) => void;
};

export default function AccountSwitcher({ projects, project, onChange }: Props) {
  const accounts = new Map<string, Project>();
  // Settings can arrive before the account list, so the current workspace must
  // remain visible and selectable while the other accounts load.
  if (project && !projects.some(item => item.id === project.id)) accounts.set(project.id, project);
  for (const item of projects) accounts.set(item.id, item.id === project?.id ? project : item);
  const name = project?.name || (accounts.size ? 'Select account' : 'No account assigned');
  return (
    <div className="account-switcher">
      <FilterDropdown
        label="Select account"
        value={project?.id || ''}
        onChange={onChange}
        displayValue={name}
        triggerCaption="YOUR WORKSPACE"
        className="account-switcher-trigger"
        menuClassName="account-switcher-menu"
        menuWidth={320}
        menuMaxHeight={520}
        active={false}
        icon={<DomainLogo domain={project?.brand.domains[0]} name={project?.brand.name || 'Workspace'} size={34} />}
        options={[...accounts.values()].map(account => ({
          value: account.id,
          label: account.name,
          description: logoDomain(account.brand.domains[0]) || 'No website added',
          icon: <DomainLogo domain={account.brand.domains[0]} name={account.brand.name || account.name} size={32} />,
        }))}
      />
    </div>
  );
}
