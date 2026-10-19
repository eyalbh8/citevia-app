# Deploy Citevia on AWS

The repository includes an AWS SAM template for exactly two application Lambdas: the HTTP API and the scanner. The React client is hosted separately on Amplify Hosting. Deployment creates billable AWS resources and scans spend OpenAI API credits. Both local and AWS runtimes use real data only. Installation, tests and builds do not provision resources or call OpenAI.

## Deployment order

1. Validate a small real scan when your OpenAI project/key is ready; see [local validation](LOCAL_DEVELOPMENT.md).
2. Choose the frontend HTTPS origin, create the OpenAI secret in the backend region and verify AWS identity with `aws sts get-caller-identity`.
3. Build/test and deploy the SAM backend. Record its outputs.
4. Invoke the scanner database migration and verify its result before creating customers.
5. Configure and publish the static client with Cognito/API outputs, using Git-connected Amplify or a manual upload below. If the assigned origin changes, redeploy the backend with the final `FrontendOrigin` and rebuild the client.
6. Create the operator in Cognito, sign in, onboard a real customer, inspect its first scan and confirm its weekly schedule in EventBridge Scheduler.

The application does not ship customer records or populate AWS from the local database. AWS starts empty. Keep the local `.env`, database files and raw evidence out of client build archives.

## Architecture and deployment boundaries

- Amplify Hosting serves `apps/client/dist` and redirects application routes to `index.html`.
- Cognito managed login uses authorization code flow with PKCE. It is an invite-only pool, with a public app client and no client secret. The API requires a JWT access token with `openid` scope and checks project membership on each request.
- API Gateway HTTP API invokes the API Lambda. The API can manage project schedules but cannot read the OpenAI secret.
- Each enabled project has an EventBridge Scheduler schedule that enqueues `{ "kind": "kickoff", "projectId": "…", "scheduledAt": "<aws.scheduler.scheduled-time>" }`. The stable scheduled time makes repeated deliveries refer to the same run.
- SQS feeds the scanner one message per invocation, with 10 concurrent queue workers by default. A separate EventBridge rule invokes the same scanner with `{ "kind": "reconcile" }` every 15 minutes to recover interrupted work.
- Aurora PostgreSQL stores the iGEO-compatible tables and versioned workflow state. Both Lambdas connect over TLS from private VPC subnets; a NAT gateway provides outbound OpenAI/AWS access. S3 stores private raw evidence. The database, evidence bucket and Cognito pool are retained on stack deletion.

The template provisions a private Aurora PostgreSQL Serverless v2 writer, two private subnets across availability zones, one public NAT gateway, and exactly two application Lambdas. Both Lambda bundles include their dependencies and run on Node.js 22 / ARM64. The database is encrypted, deletion-protected and not publicly reachable. The single NAT gateway is a deliberate availability tradeoff for this MVP; production teams can add a NAT gateway per availability zone and an Aurora reader for stronger failover. The previous DynamoDB source is preserved only in `infra/dynamodb-template.reference.yaml`; it is not used by the current application.

## Prerequisites

1. Node.js 22, AWS CLI v2, and a current AWS SAM CLI with `sam validate --lint` support. Authenticate to the intended AWS account using your organization's normal SSO process.
2. An AWS region supporting the resources in `infra/template.yaml`, including Cognito managed login. Use the same region for the backend and its Secrets Manager secret.
3. An OpenAI project with billing and access to the configured Responses API models and web search. Set a project budget in OpenAI before enabling recurring scans. Model access and the generated output must be verified with a real small scan in this account.
4. A known production HTTPS frontend origin, without a trailing slash. An Amplify branch URL is sufficient; a custom domain is optional.
5. A unique Cognito domain prefix. A prefix such as `company-citevia-production` becomes `https://company-citevia-production.auth.REGION.amazoncognito.com`.

Create a Secrets Manager secret using the console, with either the raw OpenAI key or JSON containing `OPENAI_API_KEY`. Use the default `aws/secretsmanager` encryption key. Save the secret ARN for deployment. Do not put the API key in a template, GitHub variable, Amplify environment variable, or Git repository. A customer-managed KMS key requires an additional scoped `kms:Decrypt` permission on the scanner role and a matching key policy.

## Build and deploy the backend

Run these commands from the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
sam validate --template-file infra/template.yaml --lint
sam deploy --template-file infra/template.yaml --guided --capabilities CAPABILITY_IAM
```

The build writes `dist/api/index.mjs` and `dist/scanner/index.mjs`. The template packages those directories directly; do not run `sam build` over application source or discard the client artifact. Give `sam deploy --guided` a stack name such as `citevia-production`, your region, and these parameter values:

- `FrontendOrigin`: the exact production client origin.
- `CognitoDomainPrefix`: your unique prefix.
- `OpenAiSecretArn`: the ARN of the existing secret, never its value.
- `GenerationModel` and `ExtractionModel`: defaults are `gpt-4.1-2025-04-14` and `gpt-4.1-mini-2025-04-14`. Check availability with your OpenAI project before accepting them.
- `AlertEmail`: an optional operations email. After deployment, confirm the SNS subscription email; alarms exist without an email, but notifications do not.
- `EnableDevOrigin`: keep `false` in production. A development stack can use `true` with `DevOrigin=http://localhost:5173` to permit localhost OAuth callbacks and CORS.
- `QueueConcurrency`: defaults to 10 concurrent SQS workers. Set it within your actual OpenAI rate limits.
- `ScannerReservedConcurrency`: defaults to 12; keep it at least two higher than `QueueConcurrency`. The API reserves 20 invocations; each Lambda pool uses at most two database connections. The AWS account must have sufficient concurrency quota.
- `OnboardingModel`: research, brandbook and portfolio model, independent of answer/extraction models.
- `MaxAccountsPerOwner`: default 100; configurable up to 10,000. This is an ownership cap, not a throughput promise.
- `AuroraEngineVersion`: default 16.9. Verify the PostgreSQL 16 minor is available in your region before deploying. Aurora scales from 1 to 8 ACUs in this template.

Review the CloudFormation change set before executing a production deployment. `infra/samconfig.example.toml` is a non-secret example for repeat deployments. If a deployed frontend URL changes, update `FrontendOrigin` and redeploy so OAuth callback URLs and CORS match exactly.

View the resulting resource names and public configuration:

```sh
aws cloudformation describe-stacks \
  --stack-name citevia-production \
  --query 'Stacks[0].Outputs' \
  --output json
```

## Configure Amplify Hosting with a Git repository

Create an Amplify Hosting app connected to this repository and choose the branch to publish. Use the root `amplify.yml`; it builds only `@citevia/client` and publishes `apps/client/dist`. Choose a build image with Node.js 22. Set these branch environment variables from the stack outputs:

```dotenv
VITE_AUTH_MODE=cognito
VITE_API_URL=https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/v1
VITE_COGNITO_DOMAIN=https://YOUR_PREFIX.auth.YOUR_REGION.amazoncognito.com
VITE_COGNITO_CLIENT_ID=YOUR_COGNITO_CLIENT_ID
VITE_REDIRECT_URI=https://YOUR_FRONTEND_ORIGIN/auth/callback
VITE_LOGOUT_URI=https://YOUR_FRONTEND_ORIGIN/
```

`ApiUrl` is the origin only: append `/v1` for `VITE_API_URL`. `CognitoDomain`, `CognitoClientId`, `RedirectUri`, and `LogoutUri` are stack outputs. Vite values are public and compiled into the browser bundle; rebuild after changing them. Never include AWS credentials or an OpenAI key. Do not use local authentication in a hosted environment.

In Amplify **Hosting → Rewrites and redirects**, import `infra/amplify-rewrites.json`. It rewrites application routes, including `/auth/callback`, to `/index.html` with status 200 while preserving asset requests. Alternatively, with the app ID already known:

```sh
aws amplify update-app \
  --app-id YOUR_AMPLIFY_APP_ID \
  --custom-rules file://infra/amplify-rewrites.json
```

If Amplify assigned the origin after the first backend deploy, update the backend `FrontendOrigin`, then apply the resulting callback configuration to the Amplify branch and rebuild. Login is expected to fail until these exact URLs match.

## Publish the client without a Git repository

If this project is only on your computer, use Amplify's **Deploy without Git** option. The existing Lambda/API stack remains the backend.

1. In `apps/client/.env.production.local`, enter the public `VITE_*` settings above using stack outputs. This file is ignored by Git. `VITE_AUTH_MODE` must be `cognito`.
2. From the repository root, build the client and zip the **contents** of its output directory:

```sh
npm run build --workspace @citevia/client
cd apps/client/dist
zip -r /tmp/citevia-client.zip .
cd ../../..
```

3. In Amplify, choose **Create new app → Deploy without Git**, name the app/production branch, upload `/tmp/citevia-client.zip`, and deploy. For future changes, rebuild and upload a fresh archive to that app/branch.
4. Apply `infra/amplify-rewrites.json` in Amplify's rewrites/redirects settings so `/auth/callback` reaches `index.html`.
5. If the assigned Amplify URL differs from the origin used for the backend, redeploy SAM with that exact `FrontendOrigin`, update the callback/logout values in the client environment file and repeat the client build/upload.

Manual uploads do not run `amplify.yml` or read Amplify build environment variables. Vite embeds the public configuration during the local build. Never upload the repository root or an archive containing `.env`/local data. See [AWS manual deployment instructions](https://docs.aws.amazon.com/amplify/latest/userguide/manual-deploys.html) and [Vite environment configuration](https://vite.dev/guide/env-and-mode).

## Initialize the database and onboard customers

Deploy this as a new Citevia stack. The local template edit does not migrate or remove any existing cloud resources. Do not update an externally deployed DynamoDB stack in place without first exporting its data and planning a separate migration. The application never connects to iGEO's production database.

After deployment, run the bundled migration through the **existing scanner Lambda**. This keeps the private database inaccessible from the public internet and does not add a migration Lambda. Using the `ScannerFunctionName` stack output:

```sh
aws lambda invoke \
  --function-name YOUR_SCANNER_FUNCTION_NAME \
  --cli-binary-format raw-in-base64-out \
  --payload '{"kind":"database:migrate"}' \
  /tmp/citevia-migration-result.json
```

Check that the invocation metadata has no `FunctionError` and the result contains `{"migrated":true}`. A Lambda invocation can return HTTP 200 while its function failed; checking only the CLI exit status is insufficient. Migrations are transactional, serialized with a PostgreSQL advisory lock, and checksum-verified. Repeating the command is safe. The command operates only on the new Citevia database; it does not import iGEO customer data. SQS payload validation rejects migration events, so this operation requires direct IAM permission to invoke the scanner.

The baseline reproduces the 109 tables modeled by the frozen iGEO Prisma reference. Five workflow tables and a migration ledger supplement it. See [the exact model snapshot, field mapping and limitations](ONBOARDING.md). Run migrations before publishing the client or enabling account creation. A rollback that needs to remove schema requires an operator-authored migration; application updates do not silently drop tables.

In the Cognito console, open the `UserPoolId` from stack outputs and create the intended operator under **Users**, using the actual email and a temporary password. Choose the invitation option according to your own delivery process; this repository sends no invitations. On first sign-in, complete the required password change through managed login. Sign-in needs no existing project membership to create an owned account. A person does not need a preassigned project to use **Accounts → New account**. For each customer supply the official website, name, locale and optional context/prompts, or import up to 25 accounts per CSV/JSON batch. The system creates the owner membership, researched brandbook, 50 categorized prompts, first scan and weekly schedule automatically. No per-customer bootstrap command, database edit or invitation email is required. The Prompts screen then allows portfolio maintenance and links to the original real answers; Dashboard, Mentions and Sources stay empty until scans supply observations.

`npm run bootstrap` remains an advanced operator tool for existing Cognito users and manually configured accounts. Because PostgreSQL is private, run it from an operator environment with authorized VPC/VPN/tunnel access to the database, plus scoped Secrets Manager, Cognito, CloudFormation and Scheduler access. It is not part of normal customer onboarding.

## GitHub Actions and OIDC

`Validate` runs type checks, tests, the production build, and SAM linting on pull requests and pushes to `main`. It requires no AWS credentials and makes no OpenAI requests.

`Deploy AWS backend` is manual (`workflow_dispatch`). Create a GitHub environment such as `production`, protect it with the appropriate reviewers and branch restrictions, and configure these environment variables:

- `AWS_REGION`: target region.
- `AWS_DEPLOY_ROLE_ARN`: an IAM role trusted through GitHub OIDC.
- `CLOUDFORMATION_ROLE_ARN`: the separate CloudFormation execution role.
- `ARTIFACT_BUCKET`: an existing private S3 bucket for deployment bundles in the target region.
- `FRONTEND_ORIGIN`, `COGNITO_DOMAIN_PREFIX`, and `OPENAI_SECRET_ARN`: the backend parameter values above.
- Optional `OPENAI_GENERATION_MODEL`, `OPENAI_EXTRACTION_MODEL`, `OPENAI_ONBOARDING_MODEL`, and `ALERT_EMAIL`.

Adapt `infra/github-oidc-trust.example.json` for your account, repository, and exact GitHub environment. Bind the role trust to that exact repository/environment and `sts.amazonaws.com` audience. Do not store long-lived AWS keys in GitHub.

The deploy role needs CloudFormation change-set operations limited to the intended stack, upload access to the artifact bucket/prefix, `lambda:InvokeFunction` for the exact scanner function (database migrations), and `iam:PassRole` for the exact CloudFormation execution role. The execution role is trusted by `cloudformation.amazonaws.com` and needs permission to manage the template resources, including EC2 networking, RDS clusters/instances/parameter groups, the RDS-managed secret, Lambda execution roles and their inline policies. Restrict that role to the application's resources using your organization's provisioning policy. These account-level roles are deliberately supplied by the operator rather than created by an application that would then grant itself deployment authority.

After the protected environment is approved, the workflow deploys the backend and invokes the scanner migration operation, checking its result. It does not publish the client; Amplify builds that through its connected repository branch. Keep the protected environment review because the stack includes persistent database and network resources.

## Reliability, recovery and retention

The queue visibility timeout is 30 minutes, six times the scanner's five-minute maximum runtime. The AWS scan deadline is 24 hours to tolerate onboarding/weekly bursts; local development defaults to three hours. Onboarding has four attempts per stage, a 24-hour deadline and explicit owner retry. After five failed receives, SQS moves a message to the dead-letter queue. Partial batch failure responses permit retrying failed messages without retrying completed items. Scan jobs and scheduled kickoffs must remain idempotent because SQS uses at-least-once delivery.

The dead-letter queue keeps messages for 14 days and has no automatic consumer. This preserves failed evidence for diagnosis. On a DLQ or queue-age alarm:

1. Inspect the run status and CloudWatch scanner logs. Check model access, OpenAI balance/rate limits, IAM failures, and exhausted job attempts.
2. Correct the cause. Prefer the application's explicit retry-failed action, which resets failed jobs while retaining saved answers and evidence. A parsing retry should reuse the captured answer.
3. If a kickoff failed before creating a run, use SQS's console redrive to send only the appropriate messages back to the source queue. Redrive preserves message bodies; a terminal failed job can remain terminal until the application's retry action resets it. Redriving all DLQ messages is not a substitute for resetting failed results.
4. Verify the affected run reaches a terminal state with correct completed/failed counts. Clear resolved DLQ messages only after verification; do not purge an uninspected DLQ.

CloudWatch retains logs for 14 days. Alarms cover non-empty DLQ, queue age over two hours, scanner errors, and repeated API errors. Handled per-prompt failures may not increment Lambda's `Errors` metric, so inspect the scan's failure counts and queue alarms as well. Never log full API keys or authorization headers.

Aurora storage is encrypted, has 14 days of backups and requires TLS. RDS manages the database credential in Secrets Manager; the application refreshes its small connection pool/credentials periodically to accommodate rotation. SQL reporting records and current S3 evidence have no automatic deletion. S3 deletes noncurrent versions after 30 days. The legacy `expiresAt` values remain compatibility metadata and are not SQL deletion jobs. Define and test an explicit data-retention policy before adding cleanup. S3 public access is blocked and bucket/queue policies require TLS.

Deleting the stack does not delete the retained Aurora database, evidence, or Cognito users. Aurora deletion protection must be handled explicitly during an intentional shutdown; its retained private networking and credentials also need an operator migration/shutdown plan. For an intentional shutdown, disable project schedules before deletion; the schedule group deletion removes its schedules. Record retained resource names and explicitly apply your data-deletion policy. Recreating a stack does not automatically reconnect retained resources from a previous stack.

## Production acceptance checks

Before relying on the weekly schedule, verify in the deployed account:

- An unauthenticated API request fails, a signed-in member can read their project, and another project's ID returns no data.
- Account creation completes research, brandbook, all four prompt sections, first scan and scheduling without per-customer operator steps.
- Repeating a creation request after a lost response resumes the same jobs; a failed generation retry reuses its prior checkpoints.
- Querying `accounts`, `prompts`, `scans`, `prompt_responses` and `results` confirms account-scoped rows and original evidence.
- A real manual run captures original response text, web-search citation annotations, retrieved sources, model identity, and parse results. Rank and sentiment are derived measurements; they are not native ChatGPT API fields.
- The Mentions answer detail displays citations and evidence, and Sources separates cited from retrieved URLs. Visibility excludes unfinished or failed analyses and visibly reports the denominator.
- The 50-prompt run finishes with accurate completion counts, and a retry of parsing does not generate another answer.
- A scheduled execution creates exactly one weekly run, including when the same scheduled-time payload is delivered twice.
- Failed provider calls are visible and recoverable, logs contain no credentials, alarm email is confirmed, and a restored session can sign in again.

Template validation and local tests cannot prove account quotas, IAM delegation, model entitlement, hosted login or live provider output. Those checks require an actual deployment and paid API calls.

## Official references

- [SAM guided deployment](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/using-sam-cli-deploy.html)
- [SAM JWT authorizer configuration](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-controlling-access-to-apis-oauth2-authorizer.html)
- [SAM SQS events and partial batch failures](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-property-function-sqs.html)
- [Scheduler context attributes](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-context-attributes.html) and [SQS targets](https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-targets-templated.html)
- [Cognito managed login setup](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-managed-login.html) and [CloudFormation branding](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-managedloginbranding.html)
- [Amplify SPA rewrites](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html)
- [GitHub OIDC with AWS credentials action](https://github.com/aws-actions/configure-aws-credentials)
