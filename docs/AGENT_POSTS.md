# Agent post creation

Owners and system administrators can create drafts with images in **Agents → Generate** for Facebook, Instagram, X, Pinterest, Reddit and Blog. Choose only the active prompt to answer and the target agent. The API resolves the saved question from that account's prompt ID. Topic is omitted from creation, history and post detail. Social account connections are not required. Viewers can read, copy and export; mutations require owner access.

## Platform briefs

`apps/scanner/src/agent-prompts.ts` contains six separate editorial prompts. Only the selected agent's brief is sent to OpenAI, along with the immutable account brandbook snapshot, language, country, website and selected question. Topic is not sent to generation. New posts and explicit retries use `OPENAI_CONTENT_MODEL`, defaulting to `gpt-6-astra`, independently of the account's visibility-scan `generationModel`. The chosen model is frozen on each generation, so queued recovery, replayed idempotency keys and saved drafts keep their original model. Astra requests use `reasoning.effort: low` to keep the existing caption/blog workflow bounded; legacy GPT-4.1 jobs receive no reasoning parameter. Astra writing requests have a content-only 180-second timeout, bounded by the four-minute worker lease; visibility-scan requests retain their existing timeouts. Research, writing, formatting and corrections use the frozen content model. Astra provides stronger reasoning and instruction-following at a higher cost per post.

- **X:** one punchy, conversational answer, at most 280 weighted characters including hashtags. Body target is at most 220 characters, with at most two short hashtags. CJK and emoji receive conservative platform weighting.
- **Facebook:** creative-manager copy, 2–4 short sentences, body target below 500 characters. The worker appends the verified account website; model-supplied URLs are removed. A missing account website is a visible failure.
- **Instagram:** concise creative-manager caption, a useful opening and takeaway, up to five hashtags. The worker adds “Link in bio.” and removes raw URLs.
- **Pinterest:** actionable, searchable description with a title at most 100 characters and complete copy at most 500 characters.
- **Reddit:** substantive community advice, brand affiliation disclosure, no invented personal experience or hashtag promotion.
- **Blog:** the staged workflow below.

Facebook, Instagram and X captions, titles and hashtags must omit the account brand name, aliases and branded handles, including when the saved question names the brand. The appended Facebook website remains allowed. A deterministic check rejects brand mentions and allows one checkpointed rewrite before failing visibly; Pinterest and Reddit retain their own editorial rules.

Every agent writes a standalone editorial post for its audience. A yes/no prompt must become a useful insight, benefit or practical hook that answers the question within the first one or two sentences. Titles and opening prose must not begin with conversational replies such as “Yes”, “Sure”, “Absolutely”, “Great question” or “Here is the answer”, including behind Markdown headings or formatting. Social posts get one checkpointed rewrite for an invalid opening; the rewrite preserves channel rules and any required Reddit affiliation. Blog formatting and repair receive a `standalone-opening` editorial check, and a blog still failing that check cannot finish. Existing FAQs may use natural yes/no answers; the guard applies to the post opening.

Social copy uses platform-specific paragraph breaks and short sentences. Long dashes and spaced double hyphens are replaced with ordinary punctuation outside URLs. Captions with sentences exceeding 40 words fail validation.

No channel may invent evidence, source URLs, customer results, capabilities, offers or publication status. Invalid structured output, refusals and channel length violations become visible failures. Editing also enforces channel length limits.

## Blog workflow

Adapted from iGEO's `social-media-content-generation-service.ts` two-step writing/formatting workflow and its SEO and FAQ schema rules:

1. Research the selected question with the existing Responses web-search provider in two separately queued, checkpointed requests: external authoritative sources first, then an internal-page search restricted with `web_search.filters.allowed_domains` to the account domains. Discover relevant guides, tutorials, webinars and other public deep pages on the account site. Collect URLs only from native citations and consulted web-search sources, never generated prose. Keep separate internal and external link catalogs so one category cannot crowd out the other. If the site has no relevant indexed deep pages, use known account evidence or its homepage as a fallback; no new brandbook evidence is required. Pass both catalogs and research briefs into writing, formatting and revision. Then write an 800–1200 word article answering the chosen question, using verified evidence and enabled case studies. Supply a focus keyphrase, SEO title, meta description, slug, image brief, 3–5 FAQs and useful practical examples in prose.
2. A separate queued editorial stage formats/revises the article, preserving the question and factual meaning. It adds useful H2/H3 structure, direct opening, TL;DR, short paragraphs and practical guidance, and receives deterministic SEO check feedback. Links are restricted to exact supplied research and brandbook destinations. Invented links, duplicate destinations, bare URLs, reference definitions and generic anchors are removed. At least one contextual internal account link and one external citation are required; relevant supplied deep pages are preferred over homepages.
3. If checks still need attention, one additional queued revision is allowed. Missing internal/external links fail the draft after that revision. Other remaining issues are shown explicitly in the SEO review; these are editorial checks aligned with Yoast, not a fabricated official Yoast score. Final title width and language analysis must be verified in the installed Yoast plugin.
4. Add exactly one Unsplash hero photo at the top, with attribution. No screenshots or inline images are generated. Legacy screenshot fields and placement markers are removed from previews, exports and derived schema; old paid receipts remain recoverable.
5. Add visible FAQs and deterministic `BlogPosting` plus `FAQPage` JSON-LD built from the saved title, article and visible FAQ data. Include only research citations actually linked in the article. Draft schema omits a public post URL or publication date; the publisher supplies these.
6. Preview the article, hero photo, FAQs, SEO metadata and checks in the post drawer. **Download article** exports static HTML with the hero attribution, SEO title/description and JSON-LD. **Copy schema** exports the graph; **Copy content** includes Markdown, the single hero photo, FAQs and schema.

Body edits preserve saved images and SEO/FAQ metadata and rebuild the schema and SEO checks. FAQs and metadata are displayed for review; this version's edit form changes title, article body and hashtags. Existing text-only drafts remain readable/editable. No WordPress or social publication is performed. Blogs use cited live research; social drafts use the saved brandbook.

## Unsplash

Every newly completed post requires a real Unsplash API photo. Search uses a model-supplied English query, content filtering and channel orientation (square for Instagram, portrait for Pinterest, landscape otherwise). Save the API hotlink and photographer/photo attribution URLs. Search up to five pages of 30 results, atomically reserving an unused photo before selecting it. Photo IDs are unique per account and channel, including historical drafts, concurrent jobs and explicit retries. Reservations persist even if later generation fails; recovery of the same generation reuses its original reservation. If no unused candidate is found, fail visibly rather than reuse a photo.

Trigger the returned download endpoint when selecting the photo, preserving its query parameters. The image and tracking receipt are checkpointed independently of paid text generation. A tracking request interrupted before its checkpoint may be repeated on recovery; the text is not regenerated.

Set server-only `UNSPLASH_ACCESS_KEY` locally, or `UNSPLASH_SECRET_ARN` containing a raw key or JSON `{"UNSPLASH_ACCESS_KEY":"..."}`. The API enables new generation only when both OpenAI and Unsplash are configured. The browser receives no access key. API errors and empty image results fail visibly; the app never substitutes a fabricated image. Photographer attribution is shown beside every preview and in blog exports.

## API

Paths are relative to `/v1/projects/:projectId`, behind existing Descope authentication and project membership checks.

- `POST /agents/posts`: `{ "channel": "facebook", "promptId": "selected-active-prompt-id" }`. Requires `Idempotency-Key` (8–100 letters, digits, underscores or hyphens). Returns `{ post }`, 202 while active and 200 for a replayed completed reservation. A reused key with different input returns 409.
- `GET /agents/posts?cursor=0&limit=10`: `{ items, total, nextCursor, generationAvailable }`. Decimal offset cursor; limit 1–50; newest first. History items contain metadata with content set to null; fetch the detail endpoint for the complete draft.
- `GET /agents/posts/:postId`: `{ post }`, scoped to the account.
- `PATCH /agents/posts/:postId`: `{ "title": "…", "body": "…", "hashtags": [], "version": 4 }`. Finished drafts only; stale version returns 409. Media, SEO metadata and schema cannot be replaced through this input.
- `POST /agents/posts/:postId/retry`: explicitly starts another generation of a failed post. Requires a fresh idempotency key; replaying the same retry key reuses that generation.

Up to three active posts per account are admitted under a PostgreSQL project-row lock. Public responses omit brandbook snapshots, creator, fingerprints, paid-call markers, editorial stage and worker leases.

## Storage, recovery and deployment

Migration `009_agent_posts.sql` stores versioned jobs and finished content. Migration `010_agent_images.sql` adds permanent account/channel photo reservations with uniqueness constraints and backfills photo IDs from existing drafts. Apply it before enabling the updated scanner. The screenshot renderer, Wasm and font bundle have been removed.

Each queued message contains only `{ kind: "agent-post", projectId, postId }`. The worker uses a four-minute lease and optimistic version checks. Each editorial stage records a paid-call marker before OpenAI, then checkpoints the native response privately at `projects/:projectId/agent-posts/:postId/generation-:generation[-links|-write|-format|-repair|-social-repair].json`. Recovery reuses saved responses. If a paid call lacks a saved receipt, automatic generation stops with `agent_call_uncertain`; an owner must explicitly retry. Infrastructure recovery is bounded to five attempts per stage. Stage transitions clear the lease and enqueue the next stage; reconciliation repairs a failed enqueue. Explicit retries preserve previous receipts and start a new generation number. New blog jobs require both web-search checkpoints; jobs already in editorial stages before this change can finish with their saved original research. Each search and the optional social rewrite uses the same lease, paid-call and recovery safeguards.

Deploy both API and scanner bundles and the client together. Configure SAM `ContentGenerationModel` (default `gpt-6-astra`, GitHub variable `OPENAI_CONTENT_MODEL`) and the `UnsplashSecretArn` parameter; its conditional IAM permission grants only the scanner access to that secret. The API checks ARN presence without reading the secret. See [DEPLOYMENT.md](DEPLOYMENT.md) for the existing deployment and migration procedure. Never place this key in `VITE_*` variables.

## Validation

`tests/agent-posts.test.ts` covers memory and embedded PostgreSQL: ownership, isolation, admission, prompt resolution, immutable snapshots, idempotency, edits, queue repair, uncertain paid calls and receipt recovery. `tests/agent-platforms.test.ts` covers separate prompts, copy/CTA limits, Unsplash auth/orientations/attribution/tracking, photo reservation races and historical reuse prevention, human copy formatting, supplied blog links, blog stages and matching schema. Client tests cover generation, read-only behavior, failed edits, polling and account switching. Test fixtures are never loaded by application startup.

`tests/agent-research.test.ts` covers separate external/internal web search, domain isolation, native-source provenance, missing-index fallback, checkpoint recovery, brand/alias/hashtag rejection and bounded social rewrites. The provider contract test verifies domain filters do not change neutral scan requests.
