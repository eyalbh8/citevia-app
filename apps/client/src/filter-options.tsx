import type { CSSProperties } from 'react';
import { JOURNEY_STAGES } from '@citevia/core';
import type { FilterOption } from './FilterDropdown';

export const brandingOptions: FilterOption[] = [
  { value: '', label: 'All prompts' },
  {
    value: 'true',
    label: 'Branded',
    description: 'Prompts that name your brand',
  },
  {
    value: 'false',
    label: 'Non-branded',
    description: 'Prompts without your brand name',
  },
];
const stageColors = ['#7b86d7', '#4338db', '#138e96', '#b7791f'];
export const promptTypeOptions: FilterOption[] = [
  { value: '', label: 'All prompt types' },
  ...JOURNEY_STAGES.map((stage, index) => ({
    value: stage,
    label: stage.charAt(0).toUpperCase() + stage.slice(1),
    icon: (
      <span
        className="filter-stage-dot"
        style={{ '--stage-color': stageColors[index] } as CSSProperties}
      />
    ),
  })),
];
export function regionOptions(country: string): FilterOption[] {
  const code = country.toUpperCase();
  const flag = /^[A-Z]{2}$/.test(code)
    ? [...code]
        .map((character) =>
          String.fromCodePoint(127397 + character.charCodeAt(0)),
        )
        .join('')
    : '';
  let name = code;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch {
    /* Retain a legacy region code if it has no display name. */
  }
  return [
    { value: '', label: 'All regions' },
    { value: country, label: name, icon: flag },
  ];
}
