import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  brandSchema,
  identifier,
  normalizeDomain,
  PARSER_VERSION,
  promptTextSchema,
  settingsSchema,
  WEEKLY_SCHEDULE,
  type Project,
  type Prompt,
} from '@citevia/core';

export interface BootstrapOptions {
  stack: string;
  email: string;
  name: string;
  brand: string;
  domain: string;
  projectId: string;
  userSub?: string;
  country: string;
  language: string;
  timezone: string;
  promptsFile?: string;
}

/** Parse and validate all operator input before making an AWS request. */
export function parseBootstrapArgs(args: string[]): BootstrapOptions | null {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      stack: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      brand: { type: 'string' },
      domain: { type: 'string' },
      'project-id': { type: 'string' },
      'user-sub': { type: 'string' },
      country: { type: 'string' },
      language: { type: 'string' },
      timezone: { type: 'string' },
      prompts: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return null;
  const required = (name: 'stack' | 'email' | 'name' | 'brand' | 'domain') => {
    const value = values[name]?.trim();
    if (!value)
      throw new Error(`Missing --${name}. Run npm run bootstrap -- --help.`);
    return value;
  };
  const stack = required('stack');
  if (
    !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stack) &&
    !/^arn:[a-z-]+:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z][A-Za-z0-9-]*\/[A-Za-z0-9-]+$/.test(
      stack,
    )
  ) {
    throw new Error('--stack must be a CloudFormation stack name or ARN.');
  }
  const email = required('email').toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error('--email must be a valid email address.');
  const name = required('name');
  const brand = required('brand');
  const domain = normalizeDomain(required('domain'));
  if (!domain || domain.length > 253 || !domain.includes('.'))
    throw new Error('--domain must be a valid public domain.');
  const country = (values.country || 'US').toUpperCase();
  const language = values.language || 'en';
  const timezone = values.timezone || 'UTC';
  settingsSchema.parse({ version: 1, name, country, language, timezone });
  brandSchema.parse({
    id: 'brand',
    name: brand,
    aliases: [],
    domains: [domain],
  });
  const hash = createHash('sha256')
    .update(JSON.stringify([stack, email, name, domain]))
    .digest('hex')
    .slice(0, 20);
  const projectId = identifier.parse(values['project-id'] || `project_${hash}`);
  const userSub = values['user-sub'];
  if (
    userSub &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      userSub,
    )
  ) {
    throw new Error('--user-sub must be an existing UUID.');
  }
  return {
    stack,
    email,
    name,
    brand,
    domain,
    projectId,
    userSub,
    country,
    language,
    timezone,
    promptsFile: values.prompts,
  };
}

export function parsePromptLines(content: string): string[] {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 50)
    throw new Error(
      'The prompts file must contain between 1 and 50 nonempty lines.',
    );
  const texts = lines.map((line) => promptTextSchema.parse(line));
  if (new Set(texts.map((text) => text.toLowerCase())).size !== texts.length)
    throw new Error('The prompts file contains duplicate prompts.');
  return texts;
}

export function createBootstrapProject(
  options: BootstrapOptions,
  texts: string[],
  models: { generation: string; extraction: string },
  now = new Date().toISOString(),
): Project {
  const prompts: Prompt[] = texts.map((text, index) => ({
    id: `prompt_${String(index + 1).padStart(2, '0')}`,
    text,
    version: 1,
    active: true,
    branded: text.toLowerCase().includes(options.brand.toLowerCase()),
    createdAt: now,
    updatedAt: now,
  }));
  return {
    id: options.projectId,
    name: options.name,
    brand: {
      id: 'brand',
      name: options.brand,
      aliases: [],
      domains: [options.domain],
    },
    competitors: [],
    country: options.country,
    language: options.language,
    timezone: options.timezone,
    scheduleExpression: WEEKLY_SCHEDULE,
    enabled: prompts.length > 0,
    generationModel: models.generation,
    extractionModel: models.extraction,
    parserVersion: PARSER_VERSION,
    version: 1,
    prompts,
    createdAt: now,
    updatedAt: now,
    scheduleStatus: 'pending',
  };
}

export { main } from './admin-bootstrap.js';
