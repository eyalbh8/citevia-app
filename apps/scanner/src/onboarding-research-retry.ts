import type { CapturedAnswer } from '@citevia/core';

/** Join two saved research passes only for extraction. Native citation offsets
 * remain relative to their original blocks. Both original receipts stay intact. */
export function withCompetitorResearch(primary: CapturedAnswer, supplement: CapturedAnswer): CapturedAnswer {
  const blocks = supplement.blocks.map(block => ({ ...block, id: 'competitors-' + block.id }));
  const references = supplement.citations.map(ref => ({
    ...ref, id: 'competitors-' + ref.id, blockId: 'competitors-' + ref.blockId,
  }));
  return {
    ...primary,
    text: primary.text + '\n\n' + supplement.text,
    blocks: [...primary.blocks, ...blocks],
    citations: [...primary.citations, ...references],
    sources: [...primary.sources, ...supplement.sources],
  };
}
