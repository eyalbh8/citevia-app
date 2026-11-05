import { publicReportId } from '@citevia/core';

/** Keep legacy storage labels out of public report references. */
export function reportReference(id: string) {
  return /demo/i.test(id) ? publicReportId(id) : id;
}
