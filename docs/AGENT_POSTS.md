# Agent post creation

Owners and system administrators can create text drafts in **Agents → Generate** for Facebook, Instagram, X, Pinterest, Reddit, and Blog. Choose a tracked prompt or enter a custom topic and prompt. Social account connections are not required to create drafts. Viewers can read and copy drafts; mutations require owner access on the server.

Generation uses the account's configured `generationModel` and the existing OpenAI Responses provider. The queued job snapshots the brand, language, country, and brandbook. The prompt includes tone, audience, features, post guidelines, verified evidence, and enabled case studies. Structured output contains `title`, `body`, and `hashtags`; refusals, incomplete responses, malformed output, and channel length violations become visible failures. Blog bodies support Markdown. This flow generates text drafts, without image generation, live web research, scheduling, or social publishing.

## API

All paths below are relative to `/v1/projects/:projectId`. Authentication and project membership use the existing Descope API middleware.

- `POST /agents/posts`: JSON `{ "channel": "facebook", "topic": "…", "prompt": "…", "promptId": "optional-tracked-prompt-id" }`. Requires an `Idempotency-Key` of 8–100 letters, digits, underscores, or hyphens. Returns `{ post }` and HTTP 202 while queued/generating. Replaying a completed reservation returns HTTP 200; reusing its key with different input returns 409.
- `GET /agents/posts?cursor=0&limit=10`: returns `{ items, total, nextCursor, generationAvailable }`. Cursors are decimal offsets; limit is 1–50. Newest posts appear first.
- `GET /agents/posts/:postId`: returns `{ post }`, scoped to this account.
- `PATCH /agents/posts/:postId`: JSON `{ "title": "…", "body": "…", "hashtags": [], "version": 4 }`. Only finished drafts can be edited. Stale versions return 409.
- `POST /agents/posts/:postId/retry`: explicitly starts another generation for a failed post. Requires a fresh `Idempotency-Key`; replaying that retry key reuses the same generation.

Up to three queued/generating posts are admitted per account, serialized by a PostgreSQL project-row lock. Input validation, tracked-prompt ownership, and mutation permissions are enforced before admission. Public responses omit the brandbook snapshot, creator identity, request fingerprint, paid-call marker, and worker lease.

## Storage and recovery

Migration `009_agent_posts.sql` creates `citevia_agent_posts`, storing versioned job state and finished content. The normal migration runner applies it locally at startup. For AWS, deploy both Lambda bundles and apply migrations using the existing IAM-authorized `database:migrate` procedure in [DEPLOYMENT.md](DEPLOYMENT.md). No new cloud resource or credential is required.

The API reserves a durable post before sending `{ kind: "agent-post", projectId, postId }` to the existing queue. A failed queue send can be repaired by replaying the request or by periodic reconciliation. Local development and AWS use the same worker and four-minute lease; optimistic version checks prevent duplicate deliveries from overwriting state.

The worker records a paid-call marker before contacting OpenAI, then checkpoints the native response at `projects/:projectId/agent-posts/:postId/generation-:generation.json` in the private artifact store. Recovery reuses an existing checkpoint. If a paid call has no saved response, automatic generation stops with `agent_call_uncertain`; an owner must explicitly retry before another paid call. Infrastructure recovery is bounded to five worker attempts. Provider failures are surfaced without exposing raw provider error bodies. Failed generations and their receipts remain preserved when an owner explicitly retries.

The client polls active jobs every three seconds, stops on terminal status, preserves failed form input, and uses version checks when saving edits. Switching accounts remounts the view and clears its form and drawer state.

## Validation

`tests/agent-posts.test.ts` runs the creation flow against both memory and embedded PostgreSQL, using a test-only provider. It covers permissions, account isolation, concurrent admission, idempotency, queue repair, immutable context, edit conflicts, saved-receipt recovery, uncertain calls, and worker routing. `apps/client/src/agent-creation.test.ts` covers submission, read-only access, editing failures, polling, and account changes. No fixtures are loaded by application startup.
