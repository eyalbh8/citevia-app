import type { Project } from '@citevia/core';
import { Info } from 'lucide-react';

export default function PresentationScenarioNotice({ demo, label }: { demo?: Project['demo']; label?: string }) {
  const scenarioLabel = label || demo?.presentation?.label;
  if (!scenarioLabel) return null;

  return (
    <div className="provider-banner presentation-scenario-notice" role="note" aria-label="Illustrative scenario">
      <Info size={18} aria-hidden="true" />
      <span>
        <strong>Illustrative scenario · {scenarioLabel}</strong>
        <br />
        These answers and rankings are simulated. Original scan records are preserved.
      </span>
    </div>
  );
}
