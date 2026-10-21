import type { Integration } from './integration-catalog';

export default function IntegrationMark({ integration, size = 34 }: { integration: Pick<Integration, 'id' | 'name'>; size?: number }) {
  return <img className="integration-mark" src={`/integrations/${integration.id}.svg`} alt="" aria-hidden="true" width={size} height={size} />;
}
