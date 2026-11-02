import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

describe('security lint configuration', () => {
  // ESLint's transitive minimatch v10 is vulnerable to pattern amplification.
  // The package overrides install patched v11; verify real lint discovery and
  // enforcement so an incompatible matcher cannot silently skip source files.
  it.each(['apps/api/src/security-probe.ts', 'apps/client/src/security-probe.tsx', 'scripts/security-probe.mjs'])(
    'enforces code execution rules for %s', async filePath => {
      const eslint = new ESLint();
      const results = await eslint.lintText('eval(userInput); new Function(userInput);', { filePath });
      expect(results).toHaveLength(1);
      expect(results[0].messages.map(message => message.ruleId)).toEqual(expect.arrayContaining(['no-eval', 'no-new-func']));
    },
  );

  it('allows attack URL fixtures only in tests', async () => {
    const eslint = new ESLint();
    const source = 'const attack = "javascript:alert(1)";';
    const [production] = await eslint.lintText(source, { filePath: 'apps/api/src/security-probe.ts' });
    const [fixture] = await eslint.lintText(source, { filePath: 'tests/security-probe.test.ts' });
    expect(production.messages.map(message => message.ruleId)).toContain('no-script-url');
    expect(fixture.messages).toEqual([]);
  });
});
