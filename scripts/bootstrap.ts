import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  brandSchema, identifier, nextWeeklyScan, normalizeDomain, PARSER_VERSION,
  promptTextSchema, settingsSchema, WEEKLY_SCHEDULE,
  type Project, type Prompt,
} from '@citevia/core';

const HELP = `Create a Citevia project for an existing Cognito user.

Usage:
  npm run bootstrap -- --stack STACK --email EMAIL --name NAME --brand BRAND --domain DOMAIN [options]

Required:
  --stack         Deployed CloudFormation stack name or ARN
  --email         Existing user's email in this stack's Cognito pool
  --name          Customer/project name
  --brand         Brand name measured by scans
  --domain        Owned domain, such as example.com

Options:
  --project-id    Stable project identifier (otherwise derived from stack, email and project)
  --user-sub      Existing Cognito user sub to look up instead of the email alias
  --country       Two-letter market code (default US)
  --language      Language code (default en)
  --timezone      IANA timezone for Monday 06:00 scans (default UTC)
  --prompts       UTF-8 text file with one prompt per line, at most 50 nonempty lines
  --help          Show this help without accessing AWS

Use the AWS region and SSO/profile configured in your shell.
This command never creates Cognito users or sends invitation emails.
Without a prompt file the new project starts with its weekly schedule disabled.
With a prompt file the weekly schedule is enabled; no immediate scan is started.
Existing project settings and prompts are preserved on repeated invocations.
`;

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
      stack: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' },
      brand: { type: 'string' }, domain: { type: 'string' }, 'project-id': { type: 'string' },
      'user-sub': { type: 'string' }, country: { type: 'string' }, language: { type: 'string' },
      timezone: { type: 'string' }, prompts: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return null;
  const required = (name: 'stack' | 'email' | 'name' | 'brand' | 'domain') => {
    const value = values[name]?.trim();
    if (!value) throw new Error(`Missing --${name}. Run npm run bootstrap -- --help.`);
    return value;
  };
  const stack = required('stack');
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stack)
    && !/^arn:[a-z-]+:cloudformation:[a-z0-9-]+:\d{12}:stack\/[A-Za-z][A-Za-z0-9-]*\/[A-Za-z0-9-]+$/.test(stack)) {
    throw new Error('--stack must be a CloudFormation stack name or ARN.');
  }
  const email = required('email').toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('--email must be a valid email address.');
  const name = required('name');
  const brand = required('brand');
  const domain = normalizeDomain(required('domain'));
  if (!domain || domain.length > 253 || !domain.includes('.')) throw new Error('--domain must be a valid public domain.');
  const country = (values.country || 'US').toUpperCase();
  const language = values.language || 'en';
  const timezone = values.timezone || 'UTC';
  settingsSchema.parse({ version: 1, name, country, language, timezone });
  brandSchema.parse({ id: 'brand', name: brand, aliases: [], domains: [domain] });
  const hash = createHash('sha256').update(JSON.stringify([stack, email, name, domain])).digest('hex').slice(0, 20);
  const projectId = identifier.parse(values['project-id'] || `project_${hash}`);
  const userSub = values['user-sub'];
  if (userSub && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userSub)) {
    throw new Error('--user-sub must be the existing Cognito UUID sub.');
  }
  return { stack, email, name, brand, domain, projectId, userSub, country, language, timezone, promptsFile: values.prompts };
}

export function parsePromptLines(content: string): string[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 50) throw new Error('The prompts file must contain between 1 and 50 nonempty lines.');
  const texts = lines.map(line => promptTextSchema.parse(line));
  if (new Set(texts.map(text => text.toLowerCase())).size !== texts.length) throw new Error('The prompts file contains duplicate prompts.');
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
    id: options.projectId, name: options.name,
    brand: { id: 'brand', name: options.brand, aliases: [], domains: [options.domain] },
    competitors: [], country: options.country, language: options.language, timezone: options.timezone,
    scheduleExpression: WEEKLY_SCHEDULE, enabled: prompts.length > 0,
    generationModel: models.generation, extractionModel: models.extraction,
    parserVersion: PARSER_VERSION, version: 1, prompts, createdAt: now, updatedAt: now,
    scheduleStatus: 'pending',
  };
}

async function bootstrap(options: BootstrapOptions): Promise<void> {
  let texts: string[] = [];
  if (options.promptsFile) {
    const metadata = await stat(options.promptsFile);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('The prompts file must be a regular UTF-8 text file no larger than 1 MiB.');
    texts = parsePromptLines(await readFile(options.promptsFile, 'utf8'));
  }

  // Keep --help and input validation independent of AWS credentials and clients.
  const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
  const { CognitoIdentityProviderClient, AdminGetUserCommand } = await import('@aws-sdk/client-cognito-identity-provider');
  const stacks = await new CloudFormationClient({ maxAttempts: 3 }).send(new DescribeStacksCommand({ StackName: options.stack }));
  const stack = stacks.Stacks?.[0];
  if (!stack) throw new Error('The deployed stack was not found.');
  const outputs = new Map(stack.Outputs?.map(output => [output.OutputKey, output.OutputValue]));
  const parameters = new Map(stack.Parameters?.map(parameter => [parameter.ParameterKey, parameter.ParameterValue]));
  const output = (key: string): string => {
    const value = outputs.get(key);
    if (!value) throw new Error(`The stack is missing required output ${key}. Deploy the Citevia template first.`);
    return value;
  };
  const environment: Record<string, string> = {
    APP_MODE: 'aws', DATABASE_HOST: output('DatabaseHost'), DATABASE_SECRET_ARN: output('DatabaseSecretArn'),
    DATABASE_NAME: output('DatabaseName'), EVIDENCE_BUCKET: output('EvidenceBucketName'),
    QUEUE_URL: output('ScanQueueUrl'), QUEUE_ARN: output('ScanQueueArn'),
    SCHEDULE_GROUP: output('ScheduleGroupName'), SCHEDULER_ROLE_ARN: output('SchedulerRoleArn'),
    DLQ_ARN: output('DeadLetterQueueArn'),
  };
  const userPoolId = output('UserPoolId');
  const generation = parameters.get('GenerationModel');
  const extraction = parameters.get('ExtractionModel');
  if (!generation || !extraction) throw new Error('The stack is missing GenerationModel or ExtractionModel parameters.');

  const cognito = new CognitoIdentityProviderClient({ maxAttempts: 3 });
  let user;
  try {
    user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: options.userSub || options.email }));
  } catch (error) {
    if ((error as { name?: string }).name === 'UserNotFoundException') {
      throw new Error(`The user does not exist in Cognito pool ${userPoolId}. Create the intended user in the Cognito console, then rerun this command. This script does not create users or send invitations.`);
    }
    throw error;
  }
  const attributes = new Map(user.UserAttributes?.map(attribute => [attribute.Name, attribute.Value]));
  const userId = attributes.get('sub');
  if (!userId || (options.userSub && userId !== options.userSub)) throw new Error('Cognito returned an unexpected or missing user sub.');
  if (attributes.get('email')?.toLowerCase() !== options.email) throw new Error('The Cognito user email does not match --email. No project membership was written.');
  if (!user.Enabled) throw new Error('The Cognito user is disabled. Enable the intended user before bootstrapping access.');

  Object.assign(process.env, environment);
  const { createAwsRuntime } = await import('@citevia/storage');
  const { syncProjectSchedule } = await import('../apps/api/src/scheduler.js');
  const { repository } = createAwsRuntime();
  let project = await repository.getProject(options.projectId);
  let created = false;
  if (!project) {
    const candidate = createBootstrapProject(options, texts, { generation, extraction });
    created = await repository.saveProject(candidate, null);
    project = created ? candidate : await repository.getProject(options.projectId);
    if (!project) throw new Error('Project creation conflicted. Rerun the same command.');
  }
  if (project.brand.name.toLowerCase() !== options.brand.toLowerCase()
    || !project.brand.domains.some(domain => normalizeDomain(domain) === options.domain)) {
    throw new Error('That project ID already belongs to a different brand/domain. Use its correct settings or choose another --project-id.');
  }
  const member = await repository.getMembership(project.id, userId);
  if (member?.role !== 'owner') await repository.putMembership({ projectId: project.id, userId, role: 'owner' });

  if (project.scheduleStatus !== 'synced') {
    try {
      await syncProjectSchedule(project);
      const synced: Project = {
        ...project, version: project.version + 1, updatedAt: new Date().toISOString(), scheduleStatus: 'synced',
        nextScanAt: project.enabled ? nextWeeklyScan(project.timezone) : undefined,
      };
      if (!await repository.saveProject(synced, project.version)) {
        throw new Error('Project settings changed while scheduling. Review and save Settings to synchronize the latest schedule.');
      }
      project = synced;
    } catch (error) {
      await repository.saveProject({ ...project, version: project.version + 1, updatedAt: new Date().toISOString(), scheduleStatus: 'error' }, project.version);
      throw new Error(`Project ${project.id} and owner membership are saved, but schedule synchronization failed. Rerun this command after resolving the error: ${error instanceof Error ? error.message : 'unknown scheduler error'}`);
    }
  }

  console.log(`${created ? 'Created' : 'Reused'} project ${project.id}. Owner access is ready for ${options.email}.`);
  console.log(`${project.prompts.filter(prompt => prompt.active).length}/50 active prompts. Weekly schedule ${project.enabled ? `enabled (${project.timezone}, Monday 06:00)` : 'disabled'}.`);
  if (!created) console.log('Existing project settings and prompts were preserved. Use Settings to change them.');
  if (!project.enabled) console.log('Sign in, add/review prompts in Settings, then enable the weekly schedule.');
  console.log('No invitation emails were sent and no scan was started.');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseBootstrapArgs(args);
  if (!options) { console.log(HELP); return; }
  await bootstrap(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
