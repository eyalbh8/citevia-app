import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PostgresRepository } from '@citevia/storage';
import { localPostgres } from '../packages/storage/src/local-postgres.js';
import { assertRealLocalData } from './local-data.js';

const HELP = `Usage:
  npm run admin:bootstrap -- --local --user-id DATABASE_USER_UUID
  npm run admin:bootstrap -- --stack YOUR_STACK --user-id DATABASE_USER_UUID
Sign in through Descope first. Copy your database user ID from the no-accounts screen.
Local mode requires the development server to be stopped. AWS mode invokes the existing scanner with IAM authorization.
This only establishes the first administrator. It never creates users or sends email.
Manage further users, administrators and account assignments in Users.`;
export function parseAdminArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean' },
      local: { type: 'boolean' },
      stack: { type: 'string' },
      'user-id': { type: 'string' },
    },
    strict: true,
  });
  if (values.help) return null;
  const id = z.string().uuid().parse(values['user-id']);
  if (Boolean(values.local) === Boolean(values.stack))
    throw new Error('Choose exactly one of --local or --stack.');
  if (values.stack && !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(values.stack))
    throw new Error('Invalid stack name');
  return { id, local: !!values.local, stack: values.stack };
}
export async function main(args = process.argv.slice(2)) {
  const options = parseAdminArgs(args);
  if (!options) {
    console.log(HELP);
    return;
  }
  if (options.local) {
    const running = await fetch('http://127.0.0.1:3001/health', {
      signal: AbortSignal.timeout(1000),
    })
      .then(() => true)
      .catch(() => false);
    if (running)
      throw new Error(
        'Stop the local development server before opening its database.',
      );
    const db = await localPostgres(
      resolve(process.env.LOCAL_DATA_DIR || '.local-data/real', 'postgres'),
    );
    try {
      await assertRealLocalData(db);
      const user = await new PostgresRepository(db).bootstrapAdmin(options.id);
      console.log(
        `System administrator saved: ${user.id}. Restart the local server and sign in.`,
      );
    } finally {
      await db.close();
    }
    return;
  }
  const { CloudFormationClient, DescribeStacksCommand } = await import(
    '@aws-sdk/client-cloudformation'
  );
  const { LambdaClient, InvokeCommand } = await import(
    '@aws-sdk/client-lambda'
  );
  const stack = await new CloudFormationClient({}).send(
    new DescribeStacksCommand({ StackName: options.stack }),
  );
  const name = stack.Stacks?.[0]?.Outputs?.find(
    (item) => item.OutputKey === 'ScannerFunctionName',
  )?.OutputValue;
  if (!name) throw new Error('ScannerFunctionName stack output was not found.');
  const result = await new LambdaClient({}).send(
    new InvokeCommand({
      FunctionName: name,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(
        JSON.stringify({ kind: 'users:bootstrap-admin', userId: options.id }),
      ),
    }),
  );
  const body = JSON.parse(new TextDecoder().decode(result.Payload));
  if (result.FunctionError || !body.adminBootstrapped)
    throw new Error(
      'Administrator bootstrap failed. Check the scanner logs and saved user ID.',
    );
  console.log(
    `System administrator saved: ${options.id}. Sign in and open Users.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
