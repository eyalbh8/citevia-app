# Scheduled social posts and blog drafts

The default project-wide plan in **Publishing** has an **Automated social media** switch, timezone and up to 28 weekly day/time slots. Save applies all choices; the switch is off for every existing or new project until an owner enables it. Publishing slots select active prompts in rotation and create separate platform-specific posts for each active connected destination. Prompt rotation continues across weeks. Optional blog output creates one ordinary agent draft from the same prompt and never publishes it.

**Use the same post for Facebook and Instagram** is a separate opt-in, off by default. When enabled, each new publishing occurrence generates one short general caption (at most 400 characters including up to two hashtags) and one square image for its Facebook and Instagram destinations. Other channels keep their own formats. Turning it off preserves the existing separate Facebook post and Instagram carousel behavior. Each destination still has its own preview, approval, publishing time and outcome; editing a preview changes only that destination. Already prepared content is not rewritten when the toggle changes.

Generation and publishing have separate schedules. Daily generation prepares the remaining local day, weekly generation runs Monday and prepares the remaining calendar week, and monthly generation runs on the first day and prepares the remaining calendar month. Owners choose the preparation time; saving an enabled schedule or selecting Generate content now also prepares the remaining current period. Repeated generation requests reuse each reserved slot/date. Every social publication requires explicit approval of the prepared version by the owner or, for shared Facebook and Instagram publications, a delegated reviewer. Local wall-clock schedules follow IANA timezones and AWS Scheduler daylight-saving behavior: nonexistent spring times are skipped and repeated autumn times run once. No old slots are backfilled after enabling or editing the schedule. Pausing keeps the project, saved content and history; it cancels pending work at the next worker boundary. A publishing request already sent can still finish, and its result is reconciled.

## Weekly plans for product lines on one domain

1. In **Integrations**, connect the Facebook and Instagram accounts for each product line to the same Citevia project. For a platform with an existing connection, open **Manage** and use **Connect** again.
2. Open **Publishing** in the sidebar (system administrators use **Settings → Publishing**). Under **Brand plans**, choose **Add brand**. Enter the name and a short description of the products to promote. Select one Facebook and one Instagram account. Each account can belong to one brand plan in the project.
3. For example, add **Hot Coffee**, describe its espresso and coffee beans, and set **Publishing times per week** to **10**. Add **Iced Coffee**, describe its chilled coffee drinks, choose its two accounts, and set its volume to **2**. Enable **Use the same post for Facebook and Instagram** for both brands. Adjust each day and time, choose the project timezone and Monday preparation time, then enable automation and save. Monday publishing times must follow preparation.
4. With both pairs connected, a full week creates **12 creatives and 24 destination publications**. Each time has its own creative brief containing the brand description, its position in the weekly plan and a prompt from the project’s active rotation. With sharing disabled, the two destinations generate separate, platform-specific creatives for that time.
5. To move just one prepared publication, open its destination in **Review and publishing queue**, edit its publishing date/time and save. This clears its approval. Editing recurring settings creates a new schedule revision and prepares the remaining period again. Pending work and approved, unsent posts from the previous revision stop at their next worker check. The client review picker marks earlier brand drafts as belonging to the previous plan and excludes them from new links. Earlier links stop accepting approvals for those drafts. An owner can still review an individual retained draft and approve it if the brand owns its destination.

A project supports 20 brand plans with up to 28 publishing times per week in total. With any brand plans, preparation runs weekly and uses only their selected Facebook and Instagram destinations. The project-wide cadence, slots, sharing choice and blog option are retained. Removing the last brand and saving restores the project-wide plan. Existing projects keep their previous automation until an owner saves a change.

## Client review

Open **Client review links** in the queue. **Awaiting approval** shows Facebook and Instagram publications, their accounts and their publishing times. Select individual publications or all eligible items on the page, then choose **Create review link**. Copy the new link and send it through your own client communication channel. A link covers up to 100 destination versions in this project and expires after seven days. Anyone who receives it can approve those specific versions without a Citevia login. The picker marks versions already included in an active link. The queue identifies approvals made through a client link.

On the review page, matching content and media from a shared creative appear once, with a separate destination, publishing time and status for each publication. The reviewer can leave an account unchecked and approve the selected destinations. A failed approval for one account leaves the other account’s result intact. A publication without approval stays in the queue. The worker publishes each approved destination when its time arrives.

The reviewer can request edits from the owner through their usual communication channel. Editing the content, media or publishing time invalidates that destination’s shared version. Set a future time if needed, save changes and create a new review link for the updated publication. Owners can revoke a link under **Active links**. Revocation stops further access to the link. To change an already approved publication, edit it in the queue.

## Connection and publication behavior

The server creates a Zernio profile bound to the Citevia project. Hosted OAuth connects Facebook, Instagram, LinkedIn, X, Pinterest, Reddit or TikTok to that profile. The browser cannot choose another profile or a callback origin. Every read and publication checks the destination's current profile membership and connection state. Connecting an account does not enable the automation.

Pinterest requires an explicitly selected board. Reddit requires an explicitly chosen community and can include a flair ID. These choices are frozen when a scheduled occurrence is reserved. New connections join future occurrences. Disconnected destinations do not publish. For an opted-in Facebook/Instagram pair, the original generation owner may finish the shared content for a still-connected sibling; its own disconnected publication is then cancelled.

All channels require approval of the exact reviewed content. Owners can edit titles, captions, hashtags and publishing times; replace images or videos; and reorder or remove Instagram carousel images. Saving changes removes approval. Approved posts publish when due; posts whose publishing time has passed must be rescheduled before approval. TikTok generates a vertical MP4, then waits for the owner to preview that particular video, choose privacy/interactions and a Commercial Music Library track, and give explicit consent. Missing renderer configuration is shown in settings and does not block other channels. A changed TikTok music/permission choice returns an unsent draft to review. Instagram requires a professional account. LinkedIn personal profiles cannot supply historical feed content; their visuals use verified brandbook guidance instead. Company-page feed references are supported.

See [media generation and deployment configuration](SOCIAL_AUTOMATION_MEDIA.md) for OpenAI models, reference analysis, image QA, FFmpeg and secret configuration. No migration, test or deployment automatically opts an account in, connects a social account, or publishes a test post.

## Durable execution

Migration `017_social_automation.sql` adds occurrence and publication ledgers. Migration `018_social_review_schedule.sql` adds the scheduled status and marks existing social settings for recurrence repair while retaining opt-in and publishing slots. An account row lock checks the current settings and picks a prompt atomically. Occurrence IDs include project, schedule revision, slot (scoped to its brand in a brand plan) and local date; delivery IDs include occurrence and destination. All destinations are persisted before generation starts, including a blog waiting for the manual draft engine's capacity limit.

Each queue delivery performs one generation, QA, upload, render or publish stage. Leases and version checks prevent concurrent execution. Paid calls write intent first and save their result to private artifact storage; an interrupted request with no receipt is stopped rather than charged again automatically. Binary image/video receipts are encoded only in private artifact storage, never in project settings or database JSON. Publication uses a stable UUID idempotency key and a persisted request marker/result. Unknown results are retried only inside the provider's idempotency window; unconfirmed posts remain visibly unconfirmed rather than being blindly recreated. Published requests continue status reconciliation after a pause.

Shared generation membership and its single producing publication are frozen when an opted-in occurrence is reserved. Followers wait without consuming their failure-attempt budget, then reuse the producer's immutable style, copy, image and successful QA receipts. They never take over an uncertain paid call. Each destination retains private media under its own publication namespace and separate publishing idempotency keys. Old publications without sharing metadata retain their original format even if sharing is later enabled.

One EventBridge Scheduler cron prepares daily, weekly or monthly batches independently of scanning. A dedicated one-minute worker checks approved publications that are due. Schedule changes increment a dedicated revision, invalidating stale events and pending work; retained review drafts can be explicitly approved again under the current settings. Failed schedule synchronization is retained for maintenance repair. Queue reconciliation also recovers abandoned publication leases. Local development evaluates generation schedules every 30 seconds using the same admission and deduplication checks.

## API

All paths are under `/v1/projects/:projectId`; existing project memberships govern access. Viewers can read history; owners manage connections, schedules and approvals.

- `GET /social`: settings, configuration readiness and public connection metadata.
- `PATCH /social/settings` accepts the project version and editable settings. Optional `settings.brands` entries contain `id`, `name`, `description`, `facebookDestinationId`, `instagramDestinationId`, `shareFacebookInstagramContent` and `slots` with the same day/time structure as project slots. Omitting `brands` preserves the saved list. Sending `brands: []` restores the project plan. The existing settings fields remain `enabled`, `createBlogDrafts`, `imageSource` (`openai` or `unsplash`), `shareFacebookInstagramContent`, `generationCadence`, `generationTime`, `timezone` and `slots`.
- `POST /social/generate`: owner-requested preparation of the remaining current period.
- `POST /social/connect`: `{channel}`; returns the hosted OAuth URL.
- `GET /social/accounts/:id/boards`: owned Pinterest boards.
- `PATCH /social/destinations`: versioned board/community preferences.
- `GET /social/publications?offset=0` returns twenty history records per page. Add `clientReview=true` for up to 100 Facebook and Instagram publications awaiting approval.
- `POST /social/review-links` creates a link for the selected `publications: [{id, version}]`. `GET /social/review-links` lists active links and `DELETE /social/review-links/:id` revokes one.
- `GET /social/publications/:id`: public content/media preview.
- `GET /social/publications/:id/tiktok-options`: current creator capabilities and music choices.
- `PATCH /social/publications/:id`: versioned text, owned media order/removal and future publishing time; clears approval.
- `POST /social/publications/:id/media/start` and `/media/complete`: signed private uploads with owner/version/size/type checks.
- `POST /social/publications/:id/approve`: preview version and explicit consent; TikTok also requires privacy, interactions and selected music.

The separate reviewer endpoints `GET /v1/social-reviews/:projectId` and `POST /v1/social-reviews/:projectId/approve` require the review bearer credential. Its digest is stored in the database. The raw credential is returned to the owner once in the URL fragment.

Provider authentication failures are integration errors, not Citevia/Descope authentication errors. Internal profile IDs, paid-call checkpoints and provider credentials are not returned in public project or publication responses.

## Validation and release

Tests exercise memory/Postgres parity, tenant boundaries, prompt rotation, duplicate events, DST, stale revisions, pauses, per-channel packages, image failure gates, uncertain publication recovery, explicit TikTok consent, and blog creation without publishing. API/provider tests use mocks and do not make paid calls.

Apply pending database migrations through `020_social_review_links.sql` before serving this API. Brand settings use the existing project JSON. Migration 020 creates the review-link table and grants CRUD to existing restricted `citevia_runtime_*` logins with matching direct privileges on the publications table. New runtime logins receive the table through the provisioning allowlist. Verify the deployed runtime role’s SELECT, INSERT, UPDATE and DELETE privileges on `public.citevia_social_review_links` before switching traffic. Deploy the matching worker, frontend and API together before enabling brand plans. Review links use the configured frontend origin (`ALLOWED_ORIGIN`, set by the `FrontendOrigin` deployment parameter) and the frontend’s configured API URL. Use the existing publisher and generation credentials for an authorized deployment.

## Media review and storage

Images (JPEG, PNG, WebP, up to 10 MiB) and MP4 videos (up to 100 MiB) upload directly to private versioned S3 storage. Upload policies bind the exact object, MIME type and size. Finalization pins the object version; replaying an upload URL cannot change approved bytes. Preview URLs expire and are refreshed when the post is opened. Private storage metadata is never returned in the preview. The worker uploads approved immutable media to the publisher only when due, so month-ahead planning does not rely on temporary publisher URLs. Publication receipts retain the exact sent media for safe retry.
