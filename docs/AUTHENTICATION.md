# Descope login, users and account access

Both local development and AWS use real Descope sessions. There is no shared development login, anonymous workspace access or client-controlled administrator role. The application does not create sample users or copy iGEO credentials.

## Configure Descope

Use the Descope project you intend Citevia to trust. You may use an existing project, but Citevia's database permissions are independent of roles or account access in other applications.

1. Publish the login flow you want to use in the Descope console. The default client flow ID is `sign-in`; change it if your project uses a different flow.
2. Register the exact Citevia frontend origins/redirect destinations in Descope, including `http://127.0.0.1:5173` for local development and your final HTTPS Amplify/custom domain for production. Configure the chosen flow's login methods there.
3. Configure the same project ID and project API/custom-domain base URL on the client and API.
4. Supply a server-only management key permitting user lookup. The API verifies each session token, then retrieves its matching user profile from Descope. It only reads Descope users; it does not create identities, change provider roles, send invites or send login messages itself.

For local development, copy root `.env.example` to `.env` and set:

```dotenv
DESCOPE_PROJECT_ID=YOUR_PROJECT_ID
DESCOPE_FLOW_ID=YOUR_PUBLISHED_FLOW_ID
DESCOPE_BASE_URL=https://api.descope.com
DESCOPE_MANAGEMENT_KEY=YOUR_SERVER_ONLY_MANAGEMENT_KEY
```

Alternatively set `DESCOPE_SECRET_ARN` instead of the direct key. The secret must contain the raw key or JSON with a `DESCOPE_MANAGEMENT_KEY` property, and your AWS identity must be permitted to read it. Use your project's actual base URL if it differs from the default. Restart `npm run dev` after changes. The script passes only the public project/flow/base URL values to Vite; management/OpenAI keys must never use a `VITE_*` prefix.

For AWS, supply `DescopeProjectId`, `DescopeSecretArn` and optionally `DescopeBaseUrl` to SAM. The API role can read that exact management-key secret; the scanner cannot read it. Client builds use `VITE_DESCOPE_PROJECT_ID`, `VITE_DESCOPE_BASE_URL`, `VITE_DESCOPE_FLOW_ID` and the API URL. See [deployment instructions](DEPLOYMENT.md).

Missing configuration shows setup instructions or denies protected API calls. No fixture or legacy login is substituted. Configured values alone do not prove Descope project/flow/key availability; verify a real sign-in before production.

## Saved user records

After a verified sign-in, the first API request saves the real Descope identity with no administrator role and no account assignments. A user can sign in before being assigned an account, but cannot read customer data.

- iGEO `users`: UUID, normalized actual email, name, last name, `is_system_admin`, created/updated timestamps. Passwords and session/refresh tokens are not stored here.
- iGEO `user_accounts`: user/account foreign keys, `OWNER` or `VIEWER` assignment and timestamps. System-admin all-account access does not require inserting a membership for every customer.
- `citevia_identities`: stable namespaced Descope subject, external user ID, user foreign key, provider, disabled flag, access version and last-seen timestamp. The additive `003_descope_users.sql` migration preserves the original iGEO user tables.

The server obtains email/name from Descope's authenticated management lookup, not from a browser profile body. The session's user ID must match that lookup. Only active human identities with a verified email are accepted; Descope test users and access-key machine identities are rejected. Identity mapping uses the verified stable subject, not email alone. An email collision with another saved identity requires administrator/operator review rather than silently merging access.

## Establish the first system administrator

No one becomes an administrator merely by being the first person to sign in, using a particular email domain, or claiming a role in a token. An operator explicitly promotes an already saved real identity.

1. Sign in through the configured Descope flow.
2. Copy the **database user ID** displayed in the workspace when no accounts are assigned. This is the native `users.id` UUID; it is not the Descope user ID or a JWT.
3. For local development, stop `npm run dev` before opening its database, then run:

```sh
npm run admin:bootstrap -- --local --user-id YOUR_DATABASE_USER_UUID
npm run dev
```

4. For AWS, use an authenticated operator shell with permission to describe the intended stack and invoke its scanner:

```sh
npm run admin:bootstrap -- --stack citevia-production --user-id YOUR_DATABASE_USER_UUID
```

The AWS command invokes `users:bootstrap-admin` on the existing scanner Lambda. It is not an HTTP endpoint; SQS validation rejects the event. The database must already be migrated. Bootstrap is transactionally serialized and refuses to promote another user once an enabled system administrator exists. Repeating it for the sole existing administrator is safe. `npm run bootstrap` is an alias for this command.

Refresh/sign in again, then open **Users**. Manage subsequent administrators there. Your own administrator status cannot be removed or disabled through your session; another administrator must perform that change. The system protects the last enabled administrator.

## Assign users to customer accounts

Only system administrators see the Users navigation and can call its APIs. They can create customer accounts through Accounts, inspect every customer and assign access.

Users are saved automatically when they sign in. To prepare an existing verified Descope user before their first Citevia sign-in, use **Users → Import user**, supplying their actual email. This reads the profile and saves it; it does not create a provider identity or send an invitation. Create/verify new identities through your chosen Descope flow or console first.

Open **Manage** next to a user, search for the customer account and choose:

- **Viewer:** read Dashboard, Prompts, Mentions, Sources, Brandbook, settings and preserved answers for assigned accounts.
- **Owner:** the same visibility plus prompt/brandbook/settings changes, manual scans and retries for assigned accounts.
- **System admin:** view and manage every Citevia account, create customers, assign/remove users, enable/disable application access and manage system administrators.

Regular owners cannot create customer accounts, list users or assign privileges. New unassigned users see an empty private account list. Disabling a user denies all protected API access even if their Descope JWT remains valid. Removing an assignment denies that customer's endpoints on the next request. The client refreshes permissions on focus/every minute and discards cached API data after authorization failures.

Authorization is enforced before reading project configuration, run snapshots, prompts, answers or private evidence. Foreign/unassigned project IDs return 404. Browser query parameters, project selectors, headers, request bodies and Descope role claims cannot grant system-administrator access. Administrative writes check current database permissions and access versions inside a serialized transaction; stale edits return 409.

## User APIs and verification

- `GET /v1/me`: save/update the authenticated verified profile and return database user/access metadata.
- `GET /v1/admin/users`: admin-only searchable paginated user list.
- `POST /v1/admin/users/import`: admin-only verified Descope lookup by `{ "email": "..." }`.
- `GET/PATCH /v1/admin/users/:userId`: admin-only detail and versioned `isSystemAdmin`/`disabled` changes.
- `PUT /v1/admin/users/:userId/accounts/:projectId`: admin-only `{ "version": 1, "role": "viewer" }` or owner assignment.
- `DELETE /v1/admin/users/:userId/accounts/:projectId`: admin-only removal with `{ "version": 1 }`.

`npm test` checks both PostgreSQL and memory authorization behavior, isolation across project endpoints, administrator visibility, disabled users, revoked assignments, stale writes, explicit bootstrap and Descope verification failures. Those profiles are isolated test fixtures, never application records. Real sign-in validation needs your actual Descope configuration.

Official references: [React and Node integration](https://docs.descope.com/getting-started/react/nodejs), [web session management](https://docs.descope.com/sessions/management/web), and [Descope Node SDK](https://github.com/descope/node-sdk).
