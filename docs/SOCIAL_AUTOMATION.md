# Scheduled social posts and blog drafts

Project settings contain an **Automated social media** switch, timezone and up to 28 weekly day/time slots. Save applies all choices; the switch is off for every existing or new project until an owner enables it. Publishing slots select active prompts in rotation and create separate platform-specific posts for each active connected destination. Prompt rotation continues across weeks. Optional blog output creates one ordinary agent draft from the same prompt and never publishes it.

Generation and publishing have separate schedules. Daily generation prepares the remaining local day, weekly generation runs Monday and prepares the remaining calendar week, and monthly generation runs on the first day and prepares the remaining calendar month. Owners choose the preparation time; saving an enabled schedule or selecting Generate content now also prepares the remaining current period. Repeated generation requests reuse each reserved slot/date. Every social post waits for owner review and explicit approval before its selected publishing time. Local wall-clock schedules follow IANA timezones and AWS Scheduler daylight-saving behavior: nonexistent spring times are skipped and repeated autumn times run once. No old slots are backfilled after enabling or editing the schedule. Pausing keeps the project, saved content and history; it cancels pending work at the next worker boundary. A publishing request already sent can still finish, and its result is reconciled.

## Connection and publication behavior

The server creates a Zernio profile bound to the Citevia project. Hosted OAuth connects Facebook, Instagram, LinkedIn, X, Pinterest, Reddit or TikTok to that profile. The browser cannot choose another profile or a callback origin. Every read and publication checks the destination's current profile membership and connection state. Connecting an account does not enable the automation.

Pinterest requires an explicitly selected board. Reddit requires an explicitly chosen community and can include a flair ID. These choices are frozen when a scheduled occurrence is reserved. New connections join future occurrences. Disconnected accounts are cancelled before new paid work or publication.

All channels require approval of the exact reviewed content. Owners can edit titles, captions, hashtags and publishing times; replace images or videos; and reorder or remove Instagram carousel images. Saving changes removes approval. Approved posts publish when due; posts whose publishing time has passed must be rescheduled before approval. TikTok generates a vertical MP4, then waits for the owner to preview that particular video, choose privacy/interactions and a Commercial Music Library track, and give explicit consent. Missing renderer configuration is shown in settings and does not block other channels. A changed TikTok music/permission choice returns an unsent draft to review. Instagram requires a professional account. LinkedIn personal profiles cannot supply historical feed content; their visuals use verified brandbook guidance instead. Company-page feed references are supported.

See [media generation and deployment configuration](SOCIAL_AUTOMATION_MEDIA.md) for OpenAI models, reference analysis, image QA, FFmpeg and secret configuration. No migration, test or deployment automatically opts an account in, connects a social account, or publishes a test post.

## Durable execution

Migration `017_social_automation.sql` adds occurrence and publication ledgers. Migration `018_social_review_schedule.sql` adds the scheduled status and marks existing social settings for recurrence repair while retaining opt-in and publishing slots. An account row lock checks the current settings and picks a prompt atomically. Occurrence IDs include project, schedule revision, slot and local date; delivery IDs include occurrence and destination. All destinations are persisted before generation starts, including a blog waiting for the manual draft engine's capacity limit.

Each queue delivery performs one generation, QA, upload, render or publish stage. Leases and version checks prevent concurrent execution. Paid calls write intent first and save their result to private artifact storage; an interrupted request with no receipt is stopped rather than charged again automatically. Binary image/video receipts are encoded only in private artifact storage, never in project settings or database JSON. Publication uses a stable UUID idempotency key and a persisted request marker/result. Unknown results are retried only inside the provider's idempotency window; unconfirmed posts remain visibly unconfirmed rather than being blindly recreated. Published requests continue status reconciliation after a pause.

One EventBridge Scheduler cron prepares daily, weekly or monthly batches independently of scanning. A dedicated one-minute worker checks approved publications that are due. Schedule changes increment a dedicated revision, invalidating stale events and pending work; retained review drafts can be explicitly approved again under the current settings. Failed schedule synchronization is retained for maintenance repair. Queue reconciliation also recovers abandoned publication leases. Local development evaluates generation schedules every 30 seconds using the same admission and deduplication checks.

## API

All paths are under `/v1/projects/:projectId`; existing project memberships govern access. Viewers can read history; owners manage connections, schedules and approvals.

- `GET /social`: settings, configuration readiness and public connection metadata.
- `PATCH /social/settings`: `{version, settings:{enabled, createBlogDrafts, generationCadence, generationTime, timezone, slots}}`.
- `POST /social/generate`: owner-requested preparation of the remaining current period.
- `POST /social/connect`: `{channel}`; returns the hosted OAuth URL.
- `GET /social/accounts/:id/boards`: owned Pinterest boards.
- `PATCH /social/destinations`: versioned board/community preferences.
- `GET /social/publications?offset=0`: history, twenty records per page.
- `GET /social/publications/:id`: public content/media preview.
- `GET /social/publications/:id/tiktok-options`: current creator capabilities and music choices.
- `PATCH /social/publications/:id`: versioned text, owned media order/removal and future publishing time; clears approval.
- `POST /social/publications/:id/media/start` and `/media/complete`: signed private uploads with owner/version/size/type checks.
- `POST /social/publications/:id/approve`: preview version and explicit consent; TikTok also requires privacy, interactions and selected music.

Provider authentication failures are integration errors, not Citevia/Descope authentication errors. Internal profile IDs, paid-call checkpoints and provider credentials are not returned in public project or publication responses.

## Validation and release

Tests exercise memory/Postgres parity, tenant boundaries, prompt rotation, duplicate events, DST, stale revisions, pauses, per-channel packages, image failure gates, uncertain publication recovery, explicit TikTok consent, and blog creation without publishing. API/provider tests use mocks and do not make paid calls.

Deploy migrations 017 and 018 before serving the matching API/worker, deploy the matching worker and frontend, configure the publisher secret and optional renderer layer, and use an intentionally connected test account for a separately authorized live smoke test. No live generation or publication was performed during implementation.

## Media review and storage

Images (JPEG, PNG, WebP, up to 10 MiB) and MP4 videos (up to 100 MiB) upload directly to private versioned S3 storage. Upload policies bind the exact object, MIME type and size. Finalization pins the object version; replaying an upload URL cannot change approved bytes. Preview URLs expire and are refreshed when the post is opened. Private storage metadata is never returned in the preview. The worker uploads approved immutable media to the publisher only when due, so month-ahead planning does not rely on temporary publisher URLs. Publication receipts retain the exact sent media for safe retry.
