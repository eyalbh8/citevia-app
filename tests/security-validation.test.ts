import { describe, expect, it } from 'vitest';
import { promptCreateSchema, settingsSchema } from '@citevia/core';
import { mcpBody } from '../apps/api/src/mcp.js';

describe('bounded request validation', () => {
  it('applies shared JSON complexity limits to MCP requests', async () => {
    const request = new Request('https://example.com/mcp', { method: 'POST', body: JSON.stringify({ values: Array(1001).fill(1) }) });
    await expect(mcpBody(request)).rejects.toMatchObject({ code: 'BODY_TOO_COMPLEX', status: 413 });
  });

  it('preserves the stricter MCP byte limit', async () => {
    const request = new Request('https://example.com/mcp', { method: 'POST', body: JSON.stringify('x'.repeat(150000)) });
    await expect(mcpBody(request)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE', status: 413 });
  });

  it('rejects an oversized invalid prompt collection without producing an issue for every element', () => {
    const result = promptCreateSchema.safeParse({ texts: Array(30_000).fill(null) });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues).length).toBeLessThan(2_000);
  });

  it('rejects an oversized nested collection before validating its elements', () => {
    const result = settingsSchema.safeParse({ version: 1, competitors: Array(30_000).fill({}) });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['competitors'] }),
    ]);
  });

  it('preserves bounded valid prompt batches and rejects unknown settings fields', () => {
    const texts = Array.from({ length: 50 }, (_, index) => `Valid question ${index}?`);
    expect(promptCreateSchema.parse({ texts, tags: ['research', 'research'] })).toEqual({ texts, tags: ['research'] });
    expect(settingsSchema.safeParse({ version: 1, isSystemAdmin: true }).success).toBe(false);
  });
});
