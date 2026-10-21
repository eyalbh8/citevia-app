# MCP connections

Open **MCP connections** in the sidebar to connect an assistant to Citevia.

## Scope and permissions

- **System administrators:** one connection covers every account, including new accounts. Use `list_accounts`, then supply `accountId` to account tools. Selecting a different account in the UI does not change the connection.
- **Other users:** each connection is bound to one assigned account. Switch the selected account to manage its connections. Owners can read and edit; viewers can read.
- Each connection belongs to its authorizing user and uses their current permissions. Disabled users, removed assignments, revoked/expired keys and demoted administrators lose access on the next request.
- Account credentials remain account-bound after promotion to system administrator. Global credentials stop working after demotion; create a new account connection instead.

“One connection” describes the scope across accounts, not a shared secret between administrators. Each administrator authorizes their own assistant. Up to 20 active named credentials per user and scope support multiple clients.

## Connect

Copy the **Server URL** from the screen: the public API origin plus `/mcp` for administrators or `/mcp/accounts/{projectId}` for an account connection.

For **OAuth**, add that URL to a remote MCP client supporting OAuth and dynamic registration. Sign in through Citevia's normal Descope flow and approve the client and scope. A non-admin authorizing the generic `/mcp` endpoint must select exactly one assigned account. S256 PKCE, exact registered redirects, single-use authorization codes and rotating refresh tokens protect the flow. Access tokens last one hour; refresh tokens last 30 days, bounded by the connection's 90-day lifetime. Revocation blocks both. Public clients (`token_endpoint_auth_method=none`) and clients using `client_secret_post` or `client_secret_basic` are supported. Client ID metadata documents are not implemented.

For an **API key**, choose Create API key, name it and choose an expiry. The full secret appears once. Copy it into the client's credential settings or an `Authorization: Bearer ...` header. The UI provides JSON configuration for clients using `mcpServers`. Account keys also work at `/mcp`; the stored account boundary still applies. `X-Workspace-Id`, if present, must match the credential. Global connections select accounts through tool arguments.

Secrets in query strings are intentionally unsupported. OAuth supplies the URL-only connection flow. Descope sessions never appear in redirect URLs.

## Tools and protocol

`tools/list` is authoritative. Read tools cover account discovery, dashboards, prompts/metrics, answer histories/details, mentions, citation sources, scans, brandbooks, settings, competitor suggestions, tracked URLs and setup status. `allowed_routes` and resource `citevia://mcp/routes` publish the fixed read allowlist. `api_get` accepts only those routes and enforces the same account boundary.

Owner writes create/edit/archive prompts, update brandbooks/settings/competitors, register/update tracked content and start scans. Global system-admin connections can onboard accounts. Writes reuse the existing API's validation, versions, quotas, ownership and idempotency checks. Scans and onboarding can incur provider costs; tool descriptions identify this. Credentials, user administration and arbitrary external URLs are not exposed as tools.

Lists retain the API's pagination; follow `nextCursor` using the documented query parameters. Responses are capped at 2 MB. There are 120 MCP requests per minute per user and connection scope, shared across keys and workers. A 429 includes `Retry-After`.

Stateless Streamable HTTP supports protocol versions `2025-06-18` and `2025-11-25`: JSON responses to POST requests, 202 for notifications and 405 for GET because no persistent SSE subscription is offered. Legacy JSON-RPC batches are unsupported. POST clients must advertise both `application/json` and `text/event-stream` in `Accept`.

## Implementation plan and iGEO mapping

The implementation follows iGEO's named-key, show-once, expiry/revocation, OAuth and product-tool flows, using Citevia's existing Web Request/Response API and storage adapters.

1. Persist credentials, OAuth records and rate buckets in migration `006_mcp.sql`, including atomic one-time redemption and concurrent credential limits.
2. Add authenticated credential management with server-selected scope independent of caller arguments.
3. Add stateless JSON-RPC discovery and an explicit product-tool allowlist forwarding internally to the authenticated API.
4. Add discovery, registration, PKCE authorization and rotating tokens, with consent after normal sign-in.
5. Add scoped connection/consent screens, deployment configuration, and memory/PostgreSQL isolation tests.

The principal change from iGEO is the global administrator connection. The implementation also avoids reference weaknesses: credentials/session tokens in query strings, non-atomic code redemption, missing refresh support and requiring a workspace header after OAuth authorization.

## Configuration and deployment

- `MCP_PUBLIC_URL`: canonical public API **origin**, without `/v1`; HTTPS in production. Local default `http://127.0.0.1:3001`.
- `ALLOWED_ORIGIN`: frontend origin for OAuth sign-in/consent. Local default `http://127.0.0.1:5173`.
- `MCP_ALLOWED_ORIGINS`: optional comma-separated trusted browser origins. Native/server clients normally omit Origin. Additional browser origins must also be allowed in API Gateway CORS.

SAM sets the public origin when a custom API domain is configured; otherwise Lambda uses API Gateway's trusted request context (never client Host/Forwarded headers). It uses `FrontendOrigin` for consent and permits MCP headers. The existing API Lambda handles MCP/OAuth. Apply migration 006 through the existing scanner migration operation **before** publishing the API/client. Local development migrates automatically. No iGEO database or configuration is modified.

Public endpoints: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp[/accounts/{projectId}]]`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`. Token requests include the same `resource` used in authorization. Credential management/consent under `/v1/mcp/` require a real Descope session; MCP tokens cannot manage credentials.

Only SHA-256 hashes of random credentials/codes are persisted. Structured `MCP_AUDIT` logs include IDs, method/tool, status and duration; they omit secrets, arguments and response data. CloudWatch uses existing API retention. OAuth expiry is enforced during reads/redemption; periodically delete expired `citevia_mcp_records` rows and obsolete rate buckets for storage housekeeping.

Protocol references checked through Context7: [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).
