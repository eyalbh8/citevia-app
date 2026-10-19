import { describe, expect, it, vi } from 'vitest';
import { createBootstrapProject, main, parseBootstrapArgs, parsePromptLines } from '../scripts/bootstrap.js';

const args = ['--stack', 'citevia-test', '--email', 'owner@example.com', '--name', 'Example', '--brand', 'Example Brand', '--domain', 'example.com'];

describe('bootstrap input and project initialization', () => {
  it('shows help without requiring AWS configuration or required flags', async () => {
    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['--help']);
      expect(print).toHaveBeenCalledWith(expect.stringContaining('never creates Cognito users'));
    } finally { print.mockRestore(); }
  });

  it('derives a stable project id and normalizes the owner and domain', () => {
    const first = parseBootstrapArgs(args)!;
    const second = parseBootstrapArgs([...args, '--email', 'OWNER@EXAMPLE.COM', '--domain', 'https://www.example.com/page'])!;
    expect(second.projectId).toBe(first.projectId);
    expect(second.email).toBe('owner@example.com');
    expect(second.domain).toBe('example.com');
  });

  it('rejects invalid locale, identity and unknown options before AWS calls', () => {
    expect(() => parseBootstrapArgs([...args, '--timezone', 'not-a-timezone'])).toThrow();
    expect(() => parseBootstrapArgs([...args, '--user-sub', 'not-a-user-sub'])).toThrow();
    expect(() => parseBootstrapArgs([...args, '--email', 'missing-address'])).toThrow();
    expect(() => parseBootstrapArgs([...args, '--send-email'])).toThrow();
  });

  it('accepts newline prompt files while rejecting duplicates and over-limit sets', () => {
    expect(parsePromptLines('\uFEFFWhich product is best?\r\n\r\nHow does Example compare?\n')).toEqual(['Which product is best?', 'How does Example compare?']);
    expect(() => parsePromptLines('Which is best?\nwhich is best?')).toThrow('duplicate');
    expect(() => parsePromptLines(Array.from({ length: 51 }, (_, index) => `Prompt number ${index}`).join('\n'))).toThrow('50');
    expect(() => parsePromptLines('  \n')).toThrow('between 1 and 50');
  });

  it('starts empty projects disabled and freezes imported prompts at version 1', () => {
    const options = parseBootstrapArgs(args)!;
    const now = '2026-10-19T08:00:00.000Z';
    const models = { generation: 'generation-snapshot', extraction: 'extraction-snapshot' };
    expect(createBootstrapProject(options, [], models, now).enabled).toBe(false);
    const project = createBootstrapProject(options, ['Compare Example Brand with alternatives', 'Best products for a small team?'], models, now);
    expect(project.enabled).toBe(true);
    expect(project.scheduleStatus).toBe('pending');
    expect(project.prompts.map(prompt => [prompt.id, prompt.version, prompt.branded])).toEqual([
      ['prompt_01', 1, true], ['prompt_02', 1, false],
    ]);
    expect(project.generationModel).toBe('generation-snapshot');
    expect(project.createdAt).toBe(now);
  });
});
