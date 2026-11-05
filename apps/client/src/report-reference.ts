import { sourceId } from '@citevia/core';

/** Keep legacy storage labels out of public report references. */
export function reportReference(id: string) {
  return /(?:^|[^a-z0-9])demo(?:$|[^a-z0-9])/i.test(id)
    ? `ref-${sourceId(id).slice(2)}`
    : id;
}
