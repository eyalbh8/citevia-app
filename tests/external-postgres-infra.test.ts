import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, parseDocument, type CollectionTag, type ScalarTag } from 'yaml';

const tags: (ScalarTag | CollectionTag)[] = [
  ...['Ref', 'GetAtt', 'Sub', 'GetAZs'].map((name) => ({ tag: `!${name}`, resolve: (value: string) => ({ [name]: value }) })),
  ...['If', 'Equals', 'Not', 'And', 'Or', 'Select'].map((name): CollectionTag => ({ tag: `!${name}`, collection: 'seq', resolve: (value) => ({ [name]: value.toJSON() }) })),
];
const document = parseDocument(readFileSync('infra/template.yaml', 'utf8'), { customTags: tags });
if (document.errors.length || document.warnings.length) throw new Error('Template YAML could not be parsed completely.');
// The test evaluates only the conditional intrinsics used by this template; SAM lint checks the provider schemas.
type CfnObject = Record<string, any>;
const template = document.toJS() as CfnObject;
const workflow = parse(readFileSync('.github/workflows/deploy.yml', 'utf8')) as CfnObject;
const secret = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:citevia/neon-ABCDEF';
const noValue = Symbol('NoValue');
function render(overrides: Record<string, string> = {}) {
  const parameters = { ...Object.fromEntries(Object.entries(template.Parameters as CfnObject).map(([key, value]) => [key, value.Default])), ...overrides };
  const condition = (name: string): boolean => !!evaluate(template.Conditions[name]);
  function evaluate(value: any): any {
    if (Array.isArray(value)) return value.map(evaluate).filter((item) => item !== noValue);
    if (!value || typeof value !== 'object') return value;
    if ('Ref' in value) return value.Ref === 'AWS::NoValue' ? noValue : parameters[value.Ref] ?? `ref:${value.Ref}`;
    if ('GetAtt' in value) return `attribute:${value.GetAtt}`;
    if ('Equals' in value) return evaluate(value.Equals[0]) === evaluate(value.Equals[1]);
    if ('Not' in value) return !evaluate(value.Not[0]);
    if ('And' in value) return value.And.every((item: unknown) => evaluate(item));
    if ('Or' in value) return value.Or.some((item: unknown) => evaluate(item));
    if ('If' in value) return evaluate(value.If[condition(value.If[0]) ? 1 : 2]);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item)]).filter(([, item]) => item !== noValue));
  }
  const violations = Object.values(template.Rules as CfnObject).flatMap((rule) =>
    !rule.RuleCondition || evaluate(rule.RuleCondition) ? rule.Assertions.filter((assertion: CfnObject) => !evaluate(assertion.Assert)).map((assertion: CfnObject) => assertion.AssertDescription) : []);
  const selected = (section: CfnObject) => Object.fromEntries(Object.entries(section).filter(([, resource]) => !resource.Condition || condition(resource.Condition)).map(([name, resource]) => [name, evaluate(resource)]));
  return { violations, resources: selected(template.Resources), outputs: selected(template.Outputs), globals: evaluate(template.Globals) };
}

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function resolveWorkflow(parameters: { ParameterKey: string; ParameterValue: string }[], variables: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'citevia-db-deploy-test-'));
  directories.push(directory);
  const aws = join(directory, 'aws');
  writeFileSync(aws, '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s" "$FAKE_PARAMETERS"\n');
  chmodSync(aws, 0o700);
  const envFile = join(directory, 'github-env');
  writeFileSync(envFile, '');
  const script = workflow.jobs.deploy.steps.find((step: CfnObject) => step.name === 'Resolve database deployment configuration').run;
  execFileSync('bash', ['-c', script], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory, STACK_NAME: 'test-stack', AWS_REGION: 'eu-west-1', GITHUB_ENV: envFile, FAKE_PARAMETERS: JSON.stringify(parameters), DATABASE_MODE: '', EXTERNAL_DATABASE_SECRET_ARN: '', REMOVE_LEGACY_NETWORK: '', MAINTENANCE_MODE: '', COMPACT_RUN_STATE: '', RETIRE_LEGACY_DATABASE: '', ANALYSIS_BATCH_ENABLED: '', GOOGLE_PAGESPEED_SECRET_ARN: '', GOOGLE_CRUX_SECRET_ARN: '', ...variables }, stdio: ['ignore', 'pipe', 'pipe'] });
  return Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n').map((line) => { const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)]; }));
}

describe('external PostgreSQL infrastructure stages', () => {
  it('preserves the existing Aurora/VPC deployment by default', () => {
    const current = render();
    expect(current.violations).toEqual([]);
    expect(current.globals.Function.Environment.Variables).toMatchObject({ DATABASE_MODE: 'aurora', DATABASE_HOST: 'attribute:Database.Endpoint.Address', DATABASE_SECRET_ARN: 'attribute:Database.MasterUserSecret.SecretArn', DATABASE_NAME: 'citevia' });
    for (const name of ['ApiFunction', 'ScannerFunction']) expect(current.resources[name].Properties.VpcConfig.SubnetIds).toHaveLength(2);
    expect(current.resources).toHaveProperty('NatGateway');
    expect(current.outputs).toHaveProperty('DatabaseTunnelInstanceId');
  });
  it('cuts over credentials and Lambda networking while retaining rollback resources', () => {
    const cutover = render({ DatabaseMode: 'external', ExternalDatabaseSecretArn: secret });
    expect(cutover.violations).toEqual([]);
    expect(cutover.globals.Function.Environment.Variables).toMatchObject({ DATABASE_MODE: 'external', DATABASE_SECRET_ARN: secret });
    expect(cutover.globals.Function.Environment.Variables).not.toHaveProperty('DATABASE_HOST');
    expect(cutover.globals.Function.Environment.Variables).not.toHaveProperty('DATABASE_NAME');
    for (const name of ['ApiFunction', 'ScannerFunction']) {
      expect(cutover.resources[name].Properties).not.toHaveProperty('VpcConfig');
      expect(JSON.stringify(cutover.resources[name].Properties.Policies)).toContain(secret);
      expect(JSON.stringify(cutover.resources[name].Properties.Policies)).not.toContain('attribute:Database.MasterUserSecret.SecretArn');
    }
    expect(cutover.resources).toHaveProperty('NatGateway');
    expect(cutover.resources).toHaveProperty('DatabaseTunnel');
    expect(cutover.outputs.DatabaseSecretArn.Value).toBe(secret);
    expect(cutover.outputs).not.toHaveProperty('DatabaseHost');
    expect(cutover.outputs.LegacyDatabaseHost.Value).toBe('attribute:Database.Endpoint.Address');
  });
  it('removes only explicitly selected legacy egress while retaining protected Aurora and subnets', () => {
    const cleaned = render({ DatabaseMode: 'external', ExternalDatabaseSecretArn: secret, RemoveLegacyNetwork: 'true' });
    expect(cleaned.violations).toEqual([]);
    for (const name of ['NatGateway', 'NatAddress', 'PrivateRoute', 'DatabaseTunnel', 'DatabaseTunnelRole', 'DatabaseTunnelInstanceProfile']) expect(cleaned.resources).not.toHaveProperty(name);
    for (const name of ['Database', 'DatabaseWriter']) {
      expect(cleaned.resources[name].DeletionPolicy).toBe('Retain');
      expect(cleaned.resources[name].UpdateReplacePolicy).toBe('Retain');
    }
    expect(cleaned.resources.Database.Properties.DeletionProtection).toBe(true);
    for (const name of ['Vpc', 'DatabaseSubnets', 'PrivateSubnetA', 'PrivateSubnetB', 'DatabaseSecurityGroup', 'DatabaseTunnelSecurityGroup']) expect(cleaned.resources).toHaveProperty(name);
    expect(cleaned.outputs).not.toHaveProperty('DatabaseTunnelInstanceId');
  });
  it('rejects missing external credentials and unsafe cleanup combinations before deployment', () => {
    expect(render({ DatabaseMode: 'external' }).violations).toHaveLength(1);
    expect(render({ RemoveLegacyNetwork: 'true' }).violations).toHaveLength(1);
    expect(template.Parameters).not.toHaveProperty('DatabaseUrl');
    expect(template.Parameters).not.toHaveProperty('DatabasePassword');
  });
  it('freezes queue polling and reconciliation in either database mode while preserving the queue', () => {
    const configurations: Record<string, string>[] = [{ MaintenanceMode: 'true' }, { MaintenanceMode: 'true', DatabaseMode: 'external', ExternalDatabaseSecretArn: secret }];
    for (const overrides of configurations) {
      const frozen = render(overrides);
      expect(frozen.globals.Function.Environment.Variables.CITEVIA_MAINTENANCE_MODE).toBe('true');
      expect(frozen.resources.ScannerFunction.Properties.Events.ScanJobs.Properties.Enabled).toBe(false);
      expect(frozen.resources.ScannerFunction.Properties.Events.Reconcile.Properties.State).toBe('DISABLED');
      expect(frozen.resources).toHaveProperty('ScanQueue');
    }
    const resumed = render();
    expect(resumed.resources.ScannerFunction.Properties.Events.ScanJobs.Properties.Enabled).toBe(true);
    expect(resumed.resources.ScannerFunction.Properties.Events.Reconcile.Properties.State).toBe('ENABLED');
  });
  it('allows the bounded scanner queue chain in both database modes without changing API recursion protection', () => {
    for (const DatabaseMode of ['aurora', 'external']) {
      const rendered = render({ DatabaseMode, ExternalDatabaseSecretArn: secret });
      expect(rendered.resources.ScannerFunction.Properties.RecursiveLoop).toBe('Allow');
      expect(rendered.resources.ApiFunction.Properties).not.toHaveProperty('RecursiveLoop');
      expect(rendered.resources.ScannerFunction.Properties.Events.ScanJobs.Properties.ScalingConfig.MaximumConcurrency).toBeGreaterThan(0);
    }
  });
  it('detaches retained Aurora only after external cutover and cleanup, without dangling references', () => {
    for (const mode of ['aurora', 'external']) for (const cleanup of ['false', 'true']) for (const retirement of ['false', 'true']) for (const maintenance of ['false', 'true']) {
      const rendered = render({ DatabaseMode: mode, RemoveLegacyNetwork: cleanup, RetireLegacyDatabase: retirement, MaintenanceMode: maintenance, ExternalDatabaseSecretArn: secret });
      const valid = (mode === 'external' || cleanup === 'false') && (retirement === 'false' || (mode === 'external' && cleanup === 'true'));
      expect(rendered.violations.length === 0).toBe(valid);
      if (!valid) continue;
      expect('Database' in rendered.resources).toBe(retirement === 'false');
      expect('DatabaseWriter' in rendered.resources).toBe(retirement === 'false');
      expect('LegacyDatabaseHost' in rendered.outputs).toBe(retirement === 'false');
      expect('LegacyDatabaseSecretArn' in rendered.outputs).toBe(retirement === 'false');
      if (retirement === 'true') {
        expect(JSON.stringify(rendered)).not.toContain('attribute:Database.');
        expect(JSON.stringify(rendered)).not.toContain('ref:Database"');
        expect(rendered.outputs.DatabaseSecretArn.Value).toBe(secret);
        expect(rendered.resources).toHaveProperty('Vpc');
      }
    }
    for (const name of ['Database', 'DatabaseWriter']) expect(template.Resources[name].DeletionPolicy).toBe('Retain');
  });
});

describe('database deployment workflow safeguards', () => {
  it('keeps old stacks on Aurora and inherits an already completed external cutover', () => {
    expect(resolveWorkflow([])).toEqual({ DATABASE_MODE: 'aurora', EXTERNAL_DATABASE_SECRET_ARN: '', REMOVE_LEGACY_NETWORK: 'false', MAINTENANCE_MODE: 'false', COMPACT_RUN_STATE: 'false', RETIRE_LEGACY_DATABASE: 'false', ANALYSIS_BATCH_ENABLED: 'false', GOOGLE_PAGESPEED_SECRET_ARN: '', GOOGLE_CRUX_SECRET_ARN: '' });
    expect(resolveWorkflow([{ ParameterKey: 'DatabaseMode', ParameterValue: 'external' }, { ParameterKey: 'ExternalDatabaseSecretArn', ParameterValue: secret }, { ParameterKey: 'RemoveLegacyNetwork', ParameterValue: 'true' }])).toEqual({ DATABASE_MODE: 'external', EXTERNAL_DATABASE_SECRET_ARN: secret, REMOVE_LEGACY_NETWORK: 'true', MAINTENANCE_MODE: 'false', COMPACT_RUN_STATE: 'false', RETIRE_LEGACY_DATABASE: 'false', ANALYSIS_BATCH_ENABLED: 'false', GOOGLE_PAGESPEED_SECRET_ARN: '', GOOGLE_CRUX_SECRET_ARN: '' });
  });
  it('keeps Website Health secrets optional, preserves enabled values and validates overrides', () => {
    const configured = [{ ParameterKey: 'GooglePageSpeedSecretArn', ParameterValue: secret }, { ParameterKey: 'GoogleCruxSecretArn', ParameterValue: secret }];
    expect(resolveWorkflow(configured)).toMatchObject({ GOOGLE_PAGESPEED_SECRET_ARN: secret, GOOGLE_CRUX_SECRET_ARN: secret });
    const replacement = secret + '-replacement';
    expect(resolveWorkflow(configured, { GOOGLE_PAGESPEED_SECRET_ARN: replacement }).GOOGLE_PAGESPEED_SECRET_ARN).toBe(replacement);
    expect(() => resolveWorkflow([], { GOOGLE_PAGESPEED_SECRET_ARN: 'unsafe-inline-key' })).toThrow();
    expect(() => resolveWorkflow([], { GOOGLE_CRUX_SECRET_ARN: secret.replace('eu-west-1', 'us-east-1') })).toThrow();
    for (const name of ['ApiFunction', 'ScannerFunction']) expect(template.Resources[name].Properties.Environment.Variables).toMatchObject({ GOOGLE_PAGESPEED_SECRET_ARN: { Ref: 'GooglePageSpeedSecretArn' }, GOOGLE_CRUX_SECRET_ARN: { Ref: 'GoogleCruxSecretArn' } });
    const resources = render({ GooglePageSpeedSecretArn: secret, GoogleCruxSecretArn: replacement }).resources;
    expect(JSON.stringify(resources.ScannerFunction.Properties.Policies)).toContain(replacement);
    expect(JSON.stringify(resources.ApiFunction.Properties.Policies)).not.toContain(replacement);
  });
  it('preserves deployed Batch admission unless explicitly overridden', () => {
    expect(workflow.jobs.deploy.env.ANALYSIS_BATCH_ENABLED).toBe('${{ vars.ANALYSIS_BATCH_ENABLED }}');
    const enabled = [{ ParameterKey: 'AnalysisBatchEnabled', ParameterValue: 'true' }];
    expect(resolveWorkflow(enabled).ANALYSIS_BATCH_ENABLED).toBe('true');
    expect(resolveWorkflow(enabled, { ANALYSIS_BATCH_ENABLED: 'false' }).ANALYSIS_BATCH_ENABLED).toBe('false');
    expect(resolveWorkflow([], { ANALYSIS_BATCH_ENABLED: 'true' }).ANALYSIS_BATCH_ENABLED).toBe('true');
    expect(() => resolveWorkflow(enabled, { ANALYSIS_BATCH_ENABLED: 'invalid' })).toThrow();
  });
  it('inherits deployed compact state unless the rollout setting is explicitly overridden', () => {
    expect(workflow.jobs.deploy.env.COMPACT_RUN_STATE).toBe('${{ vars.CITEVIA_COMPACT_RUN_STATE }}');
    const compact = [{ ParameterKey: 'CompactRunState', ParameterValue: 'true' }];
    expect(resolveWorkflow(compact).COMPACT_RUN_STATE).toBe('true');
    expect(resolveWorkflow(compact, { COMPACT_RUN_STATE: 'false' }).COMPACT_RUN_STATE).toBe('false');
    expect(resolveWorkflow([], { COMPACT_RUN_STATE: 'true' }).COMPACT_RUN_STATE).toBe('true');
    expect(() => resolveWorkflow(compact, { COMPACT_RUN_STATE: 'invalid' })).toThrow();
  });
  it('inherits maintenance across the offline cutover and requires an explicit false to unfreeze', () => {
    const frozen = [{ ParameterKey: 'DatabaseMode', ParameterValue: 'aurora' }, { ParameterKey: 'MaintenanceMode', ParameterValue: 'true' }];
    expect(resolveWorkflow(frozen, { DATABASE_MODE: 'external', EXTERNAL_DATABASE_SECRET_ARN: secret }).MAINTENANCE_MODE).toBe('true');
    expect(resolveWorkflow(frozen, { MAINTENANCE_MODE: 'false' }).MAINTENANCE_MODE).toBe('false');
    expect(() => resolveWorkflow(frozen, { MAINTENANCE_MODE: 'invalid' })).toThrow();
    const migration = workflow.jobs.deploy.steps.find((step: CfnObject) => step.name === 'Migrate the private PostgreSQL schema');
    expect(migration.if).toBe("env.MAINTENANCE_MODE != 'true'");
  });
  it('requires deployed external mode for retirement and never silently recreates detached Aurora', () => {
    const external = [{ ParameterKey: 'DatabaseMode', ParameterValue: 'external' }, { ParameterKey: 'ExternalDatabaseSecretArn', ParameterValue: secret }, { ParameterKey: 'RemoveLegacyNetwork', ParameterValue: 'true' }];
    expect(resolveWorkflow(external, { RETIRE_LEGACY_DATABASE: 'true' }).RETIRE_LEGACY_DATABASE).toBe('true');
    expect(() => resolveWorkflow([{ ParameterKey: 'DatabaseMode', ParameterValue: 'aurora' }], { DATABASE_MODE: 'external', EXTERNAL_DATABASE_SECRET_ARN: secret, REMOVE_LEGACY_NETWORK: 'true', RETIRE_LEGACY_DATABASE: 'true' })).toThrow();
    expect(() => resolveWorkflow(external, { REMOVE_LEGACY_NETWORK: 'false', RETIRE_LEGACY_DATABASE: 'true' })).toThrow();
    const detached = [...external, { ParameterKey: 'RetireLegacyDatabase', ParameterValue: 'true' }];
    expect(resolveWorkflow(detached).RETIRE_LEGACY_DATABASE).toBe('true');
    expect(() => resolveWorkflow(detached, { RETIRE_LEGACY_DATABASE: 'false' })).toThrow();
  });
  it('requires a separate cleanup deployment and same-region secret ARN', () => {
    const old = [{ ParameterKey: 'DatabaseMode', ParameterValue: 'aurora' }];
    expect(resolveWorkflow(old, { DATABASE_MODE: 'external', EXTERNAL_DATABASE_SECRET_ARN: secret })).toMatchObject({ DATABASE_MODE: 'external', REMOVE_LEGACY_NETWORK: 'false' });
    expect(() => resolveWorkflow(old, { DATABASE_MODE: 'external', EXTERNAL_DATABASE_SECRET_ARN: secret, REMOVE_LEGACY_NETWORK: 'true' })).toThrow();
    expect(() => resolveWorkflow(old, { DATABASE_MODE: 'external', EXTERNAL_DATABASE_SECRET_ARN: 'postgresql://unsafe-inline-credentials' })).toThrow();
    expect(() => resolveWorkflow(old, { EXTERNAL_DATABASE_SECRET_ARN: 'postgresql://unsafe-inline-credentials' })).toThrow();
    expect(() => resolveWorkflow(old, { DATABASE_MODE: 'external', EXTERNAL_DATABASE_SECRET_ARN: secret.replace('eu-west-1', 'us-east-1') })).toThrow();
    expect(() => resolveWorkflow([{ ParameterKey: 'DatabaseMode', ParameterValue: 'external' }, { ParameterKey: 'ExternalDatabaseSecretArn', ParameterValue: secret }, { ParameterKey: 'RemoveLegacyNetwork', ParameterValue: 'true' }], { DATABASE_MODE: 'aurora' })).toThrow();
  });
  it('keeps every embedded shell step syntactically valid', () => {
    for (const step of workflow.jobs.deploy.steps) if (step.run) expect(() => execFileSync('bash', ['-n'], { input: step.run })).not.toThrow();
  });
});
